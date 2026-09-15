#!/usr/bin/env node
// gft — governed-flash-trader CLI.
//   node bin/gft.js demo                                   # scripted paper demo (no keys, no network)
//   node bin/gft.js leader publish --signal s.json --feed feed.jsonl
//   node bin/gft.js follower follow --signal s.json --mandate m.json --store store.json [--live]
//   node bin/gft.js receipts --store store.json

import fs from "node:fs";
import { validateSignal } from "../src/signal.js";
import { validateMandate } from "../src/mandate.js";
import { publishSignal, readFeed } from "../src/leader.js";
import { followSignal } from "../src/follower.js";
import { loadStore, saveStore, recordDecision } from "../src/store.js";
import { createPaperClient } from "../src/paper.js";
import { getQuote, submitOrder } from "../src/flash.js";

const WETH_BASE = "0x4200000000000000000000000000000000000006";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC_BASE = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf"; // cbBTC (verified: same address Base + mainnet)

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
const has = (name) => process.argv.includes(name);
const cmd = process.argv[2];
const sub = process.argv[3];

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function liveClientOrRefuse() {
  if (!has("--live")) return { client: createPaperClient(), mode: "paper" };
  const apiKey = process.env.FLASH_API_KEY;
  const apiSecret = process.env.FLASH_API_SECRET;
  if (!apiKey || !apiSecret || apiKey.includes("REPLACE_ME")) {
    console.error(
      "live mode refused: set FLASH_API_KEY and FLASH_API_SECRET (see .env.example). Paper mode needs nothing."
    );
    process.exit(2);
  }
  const client = {
    mode: "live",
    // getFill is intentionally null: fill/settlement inspection is out of
    // scope for the hackathon build; the quote+submit receipts still record
    // authorization -> signature -> submission separately.
    getFill: null,
    getQuote: (orderRequest) => getQuote({ apiKey, apiSecret, orderRequest }),
    submitOrder: (orderRequest, quoteId) => submitOrder({ apiKey, apiSecret, orderRequest, quoteId }),
  };
  return { client, mode: "live" };
}

async function cmdLeaderPublish() {
  const signal = publishSignal(arg("--feed", "./feed.jsonl"), readJson(arg("--signal")));
  console.log(JSON.stringify({ published: signal.id, leader: signal.leaderId }, null, 2));
}

async function cmdFollowerFollow() {
  const { client, mode } = liveClientOrRefuse();
  const signal = validateSignal(readJson(arg("--signal")));
  const mandate = validateMandate(readJson(arg("--mandate")));
  const storePath = arg("--store", "./store.json");
  const store = loadStore(storePath);
  const { receipt } = await followSignal({ signal, mandate, store, client, mode });
  recordDecision(store, {
    signalId: signal.id,
    followerId: mandate.followerId,
    now: new Date(),
    notionalUsd: signal.notionalUsd,
    receipt,
  });
  saveStore(storePath, store);
  console.log(JSON.stringify(receipt, null, 2));
}

function cmdReceipts() {
  const store = loadStore(arg("--store", "./store.json"));
  for (const r of store.receipts) {
    console.log(
      `${r.receiptId}  signal=${r.signalId}  outcome=${r.outcome}  mode=${r.mode}  ` +
        `auth=${r.stages.authorization.decision}  submission=${r.stages.submission.status}`
    );
  }
}

// ---------------------------------------------------------------------------
// Scripted demo: leader -> follower, one approval + three blocks + a replay.
// Fully deterministic: fixed clock, paper client, no network, no keys.
// ---------------------------------------------------------------------------
const DEMO_NOW = new Date("2026-09-16T12:00:00Z");

function demoSignal(over) {
  return validateSignal({
    id: "sig-demo-001",
    leaderId: "leader-mara",
    chain: "base",
    targetAsset: WETH_BASE,
    contraAsset: USDC_BASE,
    orderSide: "buy",
    strategy: "limit",
    notionalUsd: "250",
    params: { limitPrice: "3800" },
    rationale: "ETH reclaiming the 4h trend; buying the retest with a tight invalidation.",
    issuedAt: "2026-09-16T11:55:00Z",
    expiresAt: "2026-09-16T13:00:00Z",
    ...over,
  });
}

function demoMandate(over) {
  return validateMandate({
    followerId: "follower-finch",
    leaderId: "leader-mara",
    assetAllowlist: [{ chain: "base", targetAsset: WETH_BASE, symbol: "WETH" }],
    maxSpendPerTradeUsd: "500",
    maxSpendPerDayUsd: "1500",
    stopLossPct: 5,
    validFrom: "2026-09-16T11:00:00Z",
    validUntil: "2026-09-16T18:00:00Z",
    ...over,
  });
}

function banner(t) {
  console.log("\n" + "=".repeat(72));
  console.log(t);
  console.log("=".repeat(72));
}

function showReceipt(r) {
  console.log(`  receipt   : ${r.receiptId}`);
  console.log(`  outcome   : ${r.outcome}   (mode: ${r.mode})`);
  console.log(`  auth      : ${r.stages.authorization.decision}` +
    (r.stages.authorization.reasons?.length ? `  reasons: ${r.stages.authorization.reasons.join(", ")}` : ""));
  console.log(`  signature : ${r.stages.signature.status}`);
  console.log(`  submission: ${r.stages.submission.status}` +
    (r.stages.submission.orders ? `  orders: ${r.stages.submission.orders.map((o) => `${o.orderType}:${o.orderId}`).join(", ")}` : ""));
  console.log(`  settlement: ${r.stages.settlement.status}`);
  if (r.evidence?.notSubmitted) {
    console.log(`  evidence  : not_submitted ${JSON.stringify(r.evidence.notSubmitted.reasons ?? r.evidence.notSubmitted)}`);
  }
  const prot = r.stages.submission.orders?.[0] && r.outcome === "settled";
  if (prot && r.stages.authorization.protectionAttached) {
    console.log(`  protection: auto-attached stop-loss 5% (mandate)`);
  }
}

async function runDemo() {
  const client = createPaperClient();
  const store = { consumed: {}, dailySpend: {}, receipts: [] };
  const mandate = demoMandate();

  banner("[1/6] LEADER publishes a signal — buy WETH, limit $250, with rationale");
  const s1 = demoSignal();
  console.log(`  leader-mara -> signal ${s1.id}: ${s1.orderSide} ${s1.strategy} WETH $${s1.notionalUsd}`);
  console.log(`  rationale: "${s1.rationale}"`);

  banner("[2/6] FOLLOWER mandate check — $250 vs $500/trade cap, WETH allowlisted");
  let r = (await followSignal({ signal: s1, mandate, store, client, mode: "paper", now: DEMO_NOW })).receipt;
  recordDecision(store, { signalId: s1.id, followerId: mandate.followerId, now: DEMO_NOW, notionalUsd: s1.notionalUsd, receipt: r });
  showReceipt(r);

  banner("[3/6] OVERSIZE signal — $2,000 vs $500/trade cap: BLOCKED, never submitted");
  const s2 = demoSignal({ id: "sig-demo-002", notionalUsd: "2000" });
  r = (await followSignal({ signal: s2, mandate, store, client, mode: "paper", now: DEMO_NOW })).receipt;
  recordDecision(store, { signalId: s2.id, followerId: mandate.followerId, now: DEMO_NOW, notionalUsd: s2.notionalUsd, receipt: r });
  showReceipt(r);

  banner("[4/6] OFF-MANDATE asset — cbBTC not on the allowlist: BLOCKED, never submitted");
  const s3 = demoSignal({ id: "sig-demo-003", targetAsset: CBBTC_BASE, notionalUsd: "100" });
  r = (await followSignal({ signal: s3, mandate, store, client, mode: "paper", now: DEMO_NOW })).receipt;
  recordDecision(store, { signalId: s3.id, followerId: mandate.followerId, now: DEMO_NOW, notionalUsd: s3.notionalUsd, receipt: r });
  showReceipt(r);

  banner("[5/6] REPLAY — same signal id as [2/6]: BLOCKED as duplicate, no double-spend");
  r = (await followSignal({ signal: s1, mandate, store, client, mode: "paper", now: DEMO_NOW })).receipt;
  recordDecision(store, { signalId: `${s1.id}#replay`, followerId: mandate.followerId, now: DEMO_NOW, notionalUsd: "0", receipt: r });
  showReceipt(r);

  banner("[6/6] EXPIRED mandate — window ended at 18:00, now 19:30: BLOCKED");
  const stale = demoMandate({ followerId: "follower-wren", validUntil: "2026-09-16T18:00:00Z" });
  const s4 = demoSignal({ id: "sig-demo-004", notionalUsd: "100", expiresAt: "2026-09-16T20:00:00Z" });
  r = (await followSignal({ signal: s4, mandate: stale, store, client, mode: "paper", now: new Date("2026-09-16T19:30:00Z") })).receipt;
  recordDecision(store, { signalId: s4.id, followerId: stale.followerId, now: new Date("2026-09-16T19:30:00Z"), notionalUsd: s4.notionalUsd, receipt: r });
  showReceipt(r);

  banner("SUMMARY — 1 settled, 4 blocked; every block carries not_submitted evidence");
  console.log(`  settled: ${store.receipts.filter((x) => x.outcome === "settled").length}`);
  console.log(`  blocked: ${store.receipts.filter((x) => x.outcome === "blocked").length}`);
  console.log("  paper mode: 0 credentials, 0 network calls, 0 dollars moved.");
}

async function main() {
  if (cmd === "demo") return runDemo();
  if (cmd === "leader" && sub === "publish") return cmdLeaderPublish();
  if (cmd === "follower" && sub === "follow") return cmdFollowerFollow();
  if (cmd === "receipts") return cmdReceipts();
  if (cmd === "feed") {
    for (const s of readFeed(arg("--feed", "./feed.jsonl"))) console.log(`${s.id} ${s.leaderId} ${s.strategy} ${s.targetAsset} $${s.notionalUsd}`);
    return;
  }
  console.error("usage: gft demo | leader publish | follower follow | feed | receipts");
  process.exit(1);
}

main().catch((err) => {
  console.error(`error [${err.code ?? "UNKNOWN"}]: ${err.message}`);
  process.exit(1);
});
