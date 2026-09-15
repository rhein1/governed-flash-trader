// Blotter tests: P&L math on fixture quotes, position extraction from settled
// paper receipts, skip rules, honesty labels, and snapshot append format.
// No network, no credentials: live quotes are stubbed at the fetch boundary.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  paperPositions,
  markPosition,
  updateBlotter,
  blotterKeyInfo,
  BLOTTER_DISCLAIMER,
  PUBLIC_DEV_KEY,
} from "../src/blotter.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

// fetchImpl stub returning a fixed quote body as a Response-like.
const stubQuote = (body, ok = true) =>
  async () => ({ ok, status: ok ? 200 : 500, text: async () => JSON.stringify(body) });

const order = (over) => ({
  orderType: "market",
  side: "buy",
  targetChain: "base",
  contraChain: "base",
  targetAsset: WETH,
  contraAsset: USDC,
  qty: "250",
  quoteId: "paper-quote-1",
  orderId: "paper-order-1",
  ...over,
});
const paperFill = (price, qtyOut) => ({
  orderId: "paper-order-1",
  status: "ORDER_STATUS_FILLED",
  fills: [{ fillId: "f1", price, qtyOut }],
});
const receipt = (over) => ({
  receiptId: "rcpt-t1",
  signalId: "sig-t1",
  leaderId: "leader-mara",
  followerId: "follower-finch",
  mode: "paper",
  outcome: "settled",
  stages: {
    submission: { status: "submitted", orders: [order()] },
    settlement: { status: "settled", fills: [paperFill("2000.0000", "0.125")] },
  },
  ...over,
});
const storeOf = (receipts) => ({ consumed: {}, dailySpend: {}, receipts });

let dir;
let savedKey;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gft-blotter-test-"));
  savedKey = process.env.FLASH_API_KEY;
  delete process.env.FLASH_API_KEY;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedKey === undefined) delete process.env.FLASH_API_KEY;
  else process.env.FLASH_API_KEY = savedKey;
});

describe("paperPositions", () => {
  it("extracts a LONG from a settled paper buy receipt", () => {
    const { positions, skipped } = paperPositions(storeOf([receipt()]));
    assert.equal(skipped.length, 0);
    assert.equal(positions.length, 1);
    assert.deepEqual(
      { direction: positions[0].direction, units: positions[0].units, entryPx: positions[0].entryPx },
      { direction: "LONG", units: 0.125, entryPx: 2000 }
    );
    assert.equal(positions[0].entryNotionalUsd, 250);
  });

  it("computes SHORT units as notional/entryPx, never order.qty as target units", () => {
    const r = receipt({
      stages: {
        submission: { status: "submitted", orders: [order({ side: "sell", qty: "150", orderId: "o2" })] },
        settlement: { status: "settled", fills: [paperFill("3000.0000", "0.05")] },
      },
    });
    const { positions, skipped } = paperPositions(storeOf([r]));
    assert.equal(skipped.length, 0);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].direction, "SHORT");
    assert.equal(positions[0].units, 150 / 3000); // 0.05 WETH, not 150 WETH
    assert.equal(positions[0].entryNotionalUsd, 150);
  });

  it("skips positions with no entry fill, and ignores blocked/live receipts", () => {
    const noFill = receipt({ receiptId: "r-nofill", stages: {
      submission: { status: "submitted", orders: [order({ orderId: "o9" })] },
      settlement: { status: "settled", fills: [null] },
    }});
    const blocked = receipt({ receiptId: "r-blocked", outcome: "blocked" });
    const live = receipt({ receiptId: "r-live", mode: "live" });
    const { positions, skipped } = paperPositions(storeOf([noFill, blocked, live]));
    assert.equal(positions.length, 0);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0].receiptId, "r-nofill");
    assert.match(skipped[0].reason, /no entry fill/);
  });

  it("skips receipts whose orders predate blotter position fields", () => {
    const legacy = receipt({ receiptId: "r-legacy", stages: {
      submission: { status: "submitted", orders: [{ orderId: "o-old" }] },
      settlement: { status: "settled", fills: [paperFill("1", "1")] },
    }});
    const { positions, skipped } = paperPositions(storeOf([legacy]));
    assert.equal(positions.length, 0);
    assert.equal(skipped[0].reason, "no position fields (receipt predates blotter)");
  });
});

describe("markPosition", () => {
  it("LONG profit: live sell proceeds minus entry notional", async () => {
    const { positions } = paperPositions(storeOf([receipt()])); // 0.125 @ 2000 = $250
    const m = await markPosition(positions[0], {
      apiKey: "dpka_x",
      fetchImpl: stubQuote({ to: { asset: "contra", amount: "312.5", notional: "312.50" } }),
    });
    assert.equal(m.markPx, 312.5 / 0.125);
    assert.equal(m.pnlUsd, 62.5);
    assert.equal(m.pnlPct, 0.25);
  });

  it("LONG loss: mark below entry yields negative P&L", async () => {
    const { positions } = paperPositions(storeOf([receipt()]));
    const m = await markPosition(positions[0], {
      apiKey: "dpka_x",
      fetchImpl: stubQuote({ to: { asset: "contra", amount: "200", notional: "200.00" } }),
    });
    assert.equal(m.pnlUsd, -50);
    assert.equal(m.pnlPct, -0.2);
  });

  it("SHORT profit: entry proceeds minus buyback at live price", async () => {
    const r = receipt({
      stages: {
        submission: { status: "submitted", orders: [order({ side: "sell", qty: "150", orderId: "o2" })] },
        settlement: { status: "settled", fills: [paperFill("3000.0000", "0.05")] },
      },
    });
    const { positions } = paperPositions(storeOf([r])); // short 0.05 @ 3000 = $150
    // Buy back spending the $150 proceeds: 0.06 WETH => buyPx 2500
    const m = await markPosition(positions[0], {
      apiKey: "dpka_x",
      fetchImpl: stubQuote({ to: { asset: "target", amount: "0.06", notional: "150" } }),
    });
    assert.equal(m.markPx, 2500);
    assert.equal(m.pnlUsd, 25); // 150 - 0.05*2500
    assert.ok(Math.abs(m.pnlPct - 25 / 150) < 1e-12);
  });

  it("throws BLOTTER_QUOTE_FAILED on an unusable live quote", async () => {
    const { positions } = paperPositions(storeOf([receipt()]));
    await assert.rejects(
      markPosition(positions[0], { apiKey: "dpka_x", fetchImpl: stubQuote({ to: {} }) }),
      (e) => e.code === "BLOTTER_QUOTE_FAILED"
    );
  });

  it("sends a market quote for the reverse side with the position's units", async () => {
    const { positions } = paperPositions(storeOf([receipt()]));
    let seen;
    await markPosition(positions[0], {
      apiKey: "dpka_x",
      fetchImpl: async (url, opts) => {
        seen = { url, body: JSON.parse(opts.body), key: opts.headers["x-definitive-api-key"] };
        return { ok: true, status: 200, text: async () => JSON.stringify({ to: { notional: "1" } }) };
      },
    });
    assert.ok(seen.url.endsWith("/v1/quote"));
    assert.equal(seen.body.side, "sell"); // reverse of the LONG
    assert.equal(seen.body.orderType, "market");
    assert.equal(seen.body.qty, "0.125");
    assert.equal(seen.key, "dpka_x");
  });
});

describe("updateBlotter", () => {
  const writeStore = (receipts) => {
    const p = path.join(dir, "store.json");
    fs.writeFileSync(p, JSON.stringify(storeOf(receipts)));
    return p;
  };

  it("appends one JSONL snapshot with honesty labels, totals, and per-position marks", async () => {
    const storePath = writeStore([receipt()]);
    const blotterPath = path.join(dir, "blotter.jsonl");
    const snap = await updateBlotter({
      storePath,
      blotterPath,
      fetchImpl: stubQuote({ to: { asset: "contra", amount: "312.5", notional: "312.50" } }),
    });
    assert.equal(snap.disclaimer, BLOTTER_DISCLAIMER);
    assert.match(BLOTTER_DISCLAIMER, /no real funds moved/);
    assert.equal(snap.venue, "paper");
    assert.equal(snap.prices, "live-flash-v1-quotes");
    assert.equal(snap.keySource, "public-dev-key");
    assert.equal(snap.positions.length, 1);
    assert.equal(snap.totals.totalPnlUsd, 62.5);
    // Exactly one JSON line appended, parseable on its own.
    const lines = fs.readFileSync(blotterPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]).totals, snap.totals);
  });

  it("lists quote failures under skipped, never drops them silently", async () => {
    const storePath = writeStore([receipt({ receiptId: "r-bad" })]);
    const blotterPath = path.join(dir, "blotter.jsonl");
    const snap = await updateBlotter({ storePath, blotterPath, fetchImpl: stubQuote({ to: {} }) });
    assert.equal(snap.positions.length, 0);
    assert.equal(snap.skipped.length, 1);
    assert.equal(snap.skipped[0].receiptId, "r-bad");
    assert.match(snap.skipped[0].reason, /mark failed/);
  });

  it("appends to an existing blotter file without rewriting history", async () => {
    const storePath = writeStore([receipt()]);
    const blotterPath = path.join(dir, "blotter.jsonl");
    const q = stubQuote({ to: { asset: "contra", amount: "312.5", notional: "312.50" } });
    await updateBlotter({ storePath, blotterPath, fetchImpl: q });
    await updateBlotter({ storePath, blotterPath, fetchImpl: q });
    const lines = fs.readFileSync(blotterPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.notEqual(JSON.parse(lines[0]).snapshotId, JSON.parse(lines[1]).snapshotId);
  });
});

describe("blotterKeyInfo", () => {
  it("defaults to Definitive's public dev key with no env key set", () => {
    const info = blotterKeyInfo();
    assert.equal(info.key, PUBLIC_DEV_KEY);
    assert.equal(info.source, "public-dev-key");
  });

  it("prefers FLASH_API_KEY when set", () => {
    process.env.FLASH_API_KEY = "dpka_userkey";
    const info = blotterKeyInfo();
    assert.equal(info.key, "dpka_userkey");
    assert.equal(info.source, "env:FLASH_API_KEY");
  });
});
