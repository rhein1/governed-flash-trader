// Runner tests: offset persistence across restarts, --once-style single pass,
// new-signal pickup, duplicate-id skips via the idempotency store, malformed
// line tolerance, and paper v1 quote sanity (the paper.js field-name fix).

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runPass,
  loadStoreWithRunner,
  createClient,
  readFeedTolerant,
  blankRunnerState,
} from "../src/runner.js";
import { buildOrderRequest } from "../src/flash.js";
import { paperQuote } from "../src/paper.js";
import { publishSignal } from "../src/leader.js";
import { validateMandate } from "../src/mandate.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOW = new Date("2026-09-16T12:00:00Z");

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gft-runner-test-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const feedPath = () => path.join(dir, "feed.jsonl");
const storePath = () => path.join(dir, "store.json");

const mandate = () =>
  validateMandate({
    followerId: "follower-finch",
    leaderId: "leader-mara",
    assetAllowlist: [{ chain: "base", targetAsset: WETH, symbol: "WETH" }],
    maxSpendPerTradeUsd: "500",
    maxSpendPerDayUsd: "1500",
    stopLossPct: 5,
    validFrom: "2026-09-16T11:00:00Z",
    validUntil: "2026-09-16T18:00:00Z",
  });

const signal = (id, over = {}) => ({
  id,
  leaderId: "leader-mara",
  chain: "base",
  targetAsset: WETH,
  contraAsset: USDC,
  orderSide: "buy",
  strategy: "limit",
  notionalUsd: "250",
  params: { limitPrice: "3800" },
  rationale: "test signal",
  issuedAt: "2026-09-16T11:55:00Z",
  expiresAt: "2026-09-16T13:00:00Z",
  ...over,
});

function ctx(over = {}) {
  const m = mandate();
  const { client, mode } = createClient({ live: false });
  const store = loadStoreWithRunner(storePath());
  return { feedPath: feedPath(), mandate: m, store, storePath: storePath(), client, mode, now: NOW, ...over };
}

describe("paper v1 quote sanity", () => {
  it("prices WETH off the 3850 reference with v1 field names", () => {
    const req = buildOrderRequest(signal("sig-x-1"));
    assert.equal(req.orderType, "limit");
    assert.equal(req.targetChain, "base");
    const q = paperQuote(req);
    assert.equal(q.quote.orderType, "limit");
    assert.equal(q.quote.targetChain, "base");
    const price = q.quote.quote.price;
    assert.ok(price > 3850 * 0.99 && price < 3850 * 1.01, `price ${price} near 3850`);
  });
});

describe("runPass single pass", () => {
  it("processes every new signal, persists cursor + receipts, logs outcomes", async () => {
    publishSignal(feedPath(), signal("sig-001"));
    publishSignal(feedPath(), signal("sig-002"));
    const c = ctx();
    const outcomes = [];
    const summary = await runPass({ ...c, onSignal: (o) => outcomes.push(o) });

    assert.equal(summary.processed, 2);
    assert.equal(summary.seen, 2);
    assert.deepEqual(
      outcomes.map((o) => o.signalId),
      ["sig-001", "sig-002"]
    );
    assert.ok(outcomes.every((o) => o.outcome === "settled" && o.decision === "allow"));
    assert.deepEqual(outcomes[0].orderTypes, ["limit"]);
    assert.ok(outcomes.every((o) => typeof o.receiptId === "string" && o.mode === "paper"));

    // Cursor + receipts persisted to the store file.
    const reloaded = loadStoreWithRunner(storePath());
    assert.equal(reloaded.runner.lastSignalId, "sig-002");
    assert.equal(reloaded.receipts.length, 2);
    assert.equal(reloaded.runner.stats.processed, 2);
    assert.equal(reloaded.runner.stats.allowed, 2);
  });
});

describe("restart behavior", () => {
  it("picks up only new signals; never reprocesses", async () => {
    publishSignal(feedPath(), signal("sig-001"));
    const c1 = ctx();
    await runPass({ ...c1, now: NOW });
    assert.equal(loadStoreWithRunner(storePath()).receipts.length, 1);

    // Simulate a restart: fresh process state, same store file, one new signal.
    publishSignal(feedPath(), signal("sig-002"));
    const c2 = ctx();
    const summary = await runPass({ ...c2, now: NOW });

    assert.equal(summary.processed, 1);
    assert.equal(summary.outcomes[0].signalId, "sig-002");
    const reloaded = loadStoreWithRunner(storePath());
    assert.equal(reloaded.receipts.length, 2);
    assert.equal(reloaded.runner.lastSignalId, "sig-002");
    // A third restart with nothing new processes nothing.
    const summary2 = await runPass({ ...ctx(), now: NOW });
    assert.equal(summary2.processed, 0);
    assert.equal(loadStoreWithRunner(storePath()).receipts.length, 2);
  });

  it("skips duplicate signal ids via the idempotency store", async () => {
    publishSignal(feedPath(), signal("sig-001"));
    await runPass({ ...ctx(), now: NOW });

    // Re-published duplicate id (leader error / replay attack).
    publishSignal(feedPath(), signal("sig-001", { notionalUsd: "100" }));
    publishSignal(feedPath(), signal("sig-002"));
    const summary = await runPass({ ...ctx(), now: NOW });

    assert.equal(summary.processed, 1);
    assert.equal(summary.outcomes[0].signalId, "sig-002");
    const reloaded = loadStoreWithRunner(storePath());
    assert.equal(reloaded.receipts.length, 2);
    assert.ok(reloaded.runner.stats.skippedConsumed >= 1);
  });

  it("tolerates malformed feed lines without killing the pass", async () => {
    publishSignal(feedPath(), signal("sig-001"));
    fs.appendFileSync(feedPath(), "this is not json\n");
    fs.appendFileSync(feedPath(), '{"id":"sig-bad"}\n'); // valid JSON, invalid signal
    publishSignal(feedPath(), signal("sig-002"));
    const summary = await runPass({ ...ctx(), now: NOW });

    assert.equal(summary.processed, 2);
    assert.equal(summary.malformed, 2);
    assert.equal(loadStoreWithRunner(storePath()).receipts.length, 2);
  });
});

describe("readFeedTolerant", () => {
  it("returns empty for a missing feed file", () => {
    assert.deepEqual(readFeedTolerant(path.join(dir, "nope.jsonl")), { signals: [], malformed: 0 });
  });
});

describe("createClient", () => {
  it("defaults to paper with zero credentials", () => {
    const { client, mode } = createClient();
    assert.equal(mode, "paper");
    assert.equal(client.mode, "paper");
  });

  it("refuses live mode without a real FLASH_API_KEY", () => {
    const saved = process.env.FLASH_API_KEY;
    delete process.env.FLASH_API_KEY;
    try {
      assert.throws(() => createClient({ live: true }), (e) => e.code === "FLASH_CREDENTIALS_REFUSED");
    } finally {
      if (saved !== undefined) process.env.FLASH_API_KEY = saved;
    }
  });
});

describe("blankRunnerState", () => {
  it("starts with a null cursor and zeroed stats", () => {
    const s = blankRunnerState();
    assert.equal(s.lastSignalId, null);
    assert.equal(s.stats.processed, 0);
  });
});
