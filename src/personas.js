// Personas demo: ONE leader signal, THREE follower mandates, side by side.
//
// The "social" in social trading, made visceral: the same TWAP signal is
// copied by a degen, blocked by a conservative, and copied-with-protection by
// a whale. Deterministic, paper mode, zero network beyond the loopback
// A2A reference surface.
//
// The followers are genuinely independent agents on the A2A path: each
// persona fetches the leader's agent card and calls getSignals via JSON-RPC
// — the persona path never touches a hardcoded feed path. The leader's
// feed is the leader's own business (here: a temp file for the demo).

import { validateSignal } from "./signal.js";
import { validateMandate } from "./mandate.js";
import { followSignal } from "./follower.js";
import { createPaperClient } from "./paper.js";
import { serveA2A, fetchSignals } from "./a2a.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PERSONAS_NOW = new Date("2026-09-16T12:00:00Z");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

export function personasSignal() {
  return validateSignal({
    id: "sig-personas-001",
    leaderId: "leader-mara",
    chain: "base",
    targetAsset: WETH,
    contraAsset: USDC,
    orderSide: "buy",
    strategy: "twap",
    notionalUsd: "500",
    params: { durationSeconds: 3600, twapBucketCount: 6 },
    rationale: "TWAP into ETH strength over the next hour; six equal slices.",
    issuedAt: "2026-09-16T11:55:00Z",
    expiresAt: "2026-09-16T13:00:00Z",
  });
}

export function personasMandates() {
  const base = {
    leaderId: "leader-mara",
    assetAllowlist: [{ chain: "base", targetAsset: WETH, symbol: "WETH" }],
    validFrom: "2026-09-16T11:00:00Z",
    validUntil: "2026-09-16T18:00:00Z",
  };
  return [
    {
      name: "degen",
      tagline: "high caps, no protection requirement — copies the signal",
      mandate: validateMandate({
        ...base,
        followerId: "follower-degen",
        maxSpendPerTradeUsd: "10000",
        maxSpendPerDayUsd: "50000",
        stopLossPct: 10,
        requireProtection: false,
      }),
    },
    {
      name: "conservative",
      tagline: "$100 per-trade cap — blocks with over-spend evidence",
      mandate: validateMandate({
        ...base,
        followerId: "follower-cautious",
        maxSpendPerTradeUsd: "100",
        maxSpendPerDayUsd: "500",
        stopLossPct: 5,
        requireProtection: true,
      }),
    },
    {
      name: "whale",
      tagline: "copies, but the mandate requires stop-loss — auto-attached",
      mandate: validateMandate({
        ...base,
        followerId: "follower-whale",
        maxSpendPerTradeUsd: "10000",
        maxSpendPerDayUsd: "50000",
        stopLossPct: 5,
        requireProtection: true,
      }),
    },
  ];
}

// Runs every persona against the same signal through the real governed
// pipeline (A2A discovery -> fork-before-risk gate -> quote -> submit ->
// receipt). Returns { signal, results, leaderUrl } with one result per
// persona: { name, tagline, followerId, receipt, gateResult }.
//
// options:
//   now        fixed clock for determinism (default PERSONAS_NOW)
//   leaderUrl  use an already-running leader A2A server (e.g. a gft-runner
//              with --a2a-port in another process). When omitted, a local
//              leader is started on an ephemeral loopback port serving the
//              deterministic demo signal, and stopped afterwards.
export async function runPersonas({ now = PERSONAS_NOW, leaderUrl = null } = {}) {
  const signal = personasSignal();
  let localServer = null;
  let url;
  if (leaderUrl) {
    url = leaderUrl;
  } else {
    const started = await startDemoLeader(signal);
    url = started.url;
    localServer = started.server;
  }
  try {
    const client = createPaperClient();
    const results = [];
    for (const { name, tagline, mandate } of personasMandates()) {
      // Independent follower: discover the leader through its agent card,
      // then fetch signals via the A2A JSON-RPC surface. No feed path.
      const discovered = await fetchSignals(url, { limit: 20 });
      const leaderSignal = discovered.find((s) => s.id === signal.id) ?? discovered[0];
      const store = { consumed: {}, dailySpend: {}, receipts: [] };
      const { receipt, gateResult } = await followSignal({
        signal: leaderSignal,
        mandate,
        store,
        client,
        mode: "paper",
        now,
      });
      results.push({ name, tagline, followerId: mandate.followerId, receipt, gateResult });
    }
    return { signal, results, leaderUrl: url };
  } finally {
    if (localServer) await localServer.close();
  }
}

// The demo leader: serves the deterministic signal over the local A2A
// surface from a temp feed file. This is the LEADER's own publishing path —
// followers only ever see the card and the JSON-RPC methods.
async function startDemoLeader(signal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gft-personas-leader-"));
  const feedPath = path.join(dir, "feed.jsonl");
  fs.writeFileSync(feedPath, JSON.stringify(signal) + "\n");
  const server = await serveA2A({ feedPath, port: 0 });
  const close = async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { url: server.url, server: { close } };
}
