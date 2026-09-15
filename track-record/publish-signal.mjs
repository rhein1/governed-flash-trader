// Track-record signal publisher: appends one leader signal per run,
// rotating through templates. Run on a schedule (cron) to build a
// multi-day paper track record for the hackathon demo.
//
//   node track-record/publish-signal.mjs
//
// Signals stay inside the follower mandate (leader-mara, WETH on base,
// <= $500 notional). Paper mode: fills are simulated, blotter marks at
// live quotes. Honest labels throughout.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSignal } from "../src/signal.js";
import { publishSignal } from "../src/leader.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const feedPath = path.join(root, "feed.jsonl");
const statePath = path.join(root, "state.json");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

const TEMPLATES = [
  {
    strategy: "twap",
    orderSide: "buy",
    notionalUsd: "250",
    params: { durationSeconds: 3600, twapBucketCount: 6 },
    rationale: "ETH grinding up on the 4h; scaling in with a 1h TWAP to avoid slippage.",
  },
  {
    strategy: "limit",
    orderSide: "buy",
    notionalUsd: "200",
    params: { limitPrice: "2450" },
    rationale: "Bid stacked under the overnight low; buying the retest with a tight invalidation.",
  },
  {
    strategy: "market",
    orderSide: "sell",
    notionalUsd: "150",
    params: {},
    rationale: "Taking partial profit into strength; trimming the runner.",
  },
  {
    strategy: "limit",
    orderSide: "buy",
    notionalUsd: "300",
    params: { limitPrice: "2400" },
    rationale: "Deeper bid at the weekly value-area low; adding on weakness.",
  },
];

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { next: 0, published: [] };
  }
}

const state = loadState();
const t = TEMPLATES[state.next % TEMPLATES.length];
const now = new Date();
const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
const id = `sig-track-${stamp}-${String(state.next + 1).padStart(3, "0")}`;

const signal = validateSignal({
  id,
  leaderId: "leader-mara",
  chain: "base",
  targetAsset: WETH,
  contraAsset: USDC,
  orderSide: t.orderSide,
  strategy: t.strategy,
  notionalUsd: t.notionalUsd,
  params: t.params,
  rationale: t.rationale,
  issuedAt: now.toISOString(),
  expiresAt: new Date(now.getTime() + 24 * 3600 * 1000).toISOString(),
});

const published = publishSignal(feedPath, signal);
state.next += 1;
state.published.push({ id: published.id, at: now.toISOString() });
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
console.log(JSON.stringify({ published: published.id, strategy: published.strategy, notionalUsd: published.notionalUsd }));
