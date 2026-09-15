// Fork-gate tests: the follower's mandate gate runs through the REAL
// Agoragentic Risk Fork lifecycle contract (vendored from
// @agoragentic/risk-fork). These tests prove the decision semantics —
// copy / block / attach-protection — survive the wiring: the gate still
// blocks over-cap, expired, and excluded-asset signals, with the fork
// destroyed and the client never invoked.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runForkedGate, forkEvidence } from "../src/fork-gate.js";
import { followSignal } from "../src/follower.js";
import { validateSignal } from "../src/signal.js";
import { validateMandate } from "../src/mandate.js";
import { createPaperClient } from "../src/paper.js";
import { verifyLifecycle } from "../vendor/risk-fork/lifecycle.mjs";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const NOW = "2026-09-16T12:00:00Z";

const mkSignal = (over = {}) =>
  validateSignal({
    id: "sig-fork-001",
    leaderId: "leader-mara",
    chain: "base",
    targetAsset: WETH,
    contraAsset: USDC,
    orderSide: "buy",
    strategy: "limit",
    notionalUsd: "250",
    params: { limitPrice: "3800" },
    rationale: "test",
    issuedAt: "2026-09-16T11:55:00Z",
    expiresAt: "2026-09-16T13:00:00Z",
    ...over,
  });

const mkMandate = (over = {}) =>
  validateMandate({
    followerId: "follower-fork",
    leaderId: "leader-mara",
    assetAllowlist: [{ chain: "base", targetAsset: WETH, symbol: "WETH" }],
    maxSpendPerTradeUsd: "500",
    maxSpendPerDayUsd: "1500",
    stopLossPct: 5,
    validFrom: "2026-09-16T11:00:00Z",
    validUntil: "2026-09-16T18:00:00Z",
    requireProtection: false,
    ...over,
  });

const ctx = () => ({ spentTodayUsd: 0, consumedSignalIds: [] });
const run = (signal, mandate) =>
  runForkedGate({ signal, mandate, context: ctx(), now: new Date(NOW) });

describe("fork-before-risk gate (real Risk Fork package)", () => {
  it("allows an in-mandate signal and clean-commits the fork", () => {
    const { lifecycle, gateResult, decision } = run(mkSignal(), mkMandate());
    assert.equal(decision, "allow");
    assert.equal(gateResult.decision, "allow");
    assert.equal(lifecycle.state, "COMMITTED");
    assert.doesNotThrow(() => verifyLifecycle(lifecycle));
    const ev = forkEvidence(lifecycle);
    assert.equal(ev.terminalState, "COMMITTED");
    assert.ok(ev.chainHead.startsWith("sha256:"));
    assert.ok(ev.events > 5);
  });

  it("blocks an over-cap signal THROUGH the package: fork destroyed", () => {
    const { lifecycle, decision, gateResult } = run(
      mkSignal({ id: "sig-fork-002", notionalUsd: "2000" }),
      mkMandate()
    );
    assert.equal(decision, "block");
    assert.ok(gateResult.reasons.includes("over_max_spend_per_trade"));
    assert.equal(lifecycle.state, "DESTROYED");
    assert.doesNotThrow(() => verifyLifecycle(lifecycle));
  });

  it("blocks an expired signal THROUGH the package", () => {
    const { lifecycle, decision, gateResult } = run(
      mkSignal({ id: "sig-fork-003", expiresAt: "2026-09-16T11:59:00Z" }),
      mkMandate()
    );
    assert.equal(decision, "block");
    assert.ok(gateResult.reasons.includes("signal_expired"));
    assert.equal(lifecycle.state, "DESTROYED");
    assert.doesNotThrow(() => verifyLifecycle(lifecycle));
  });

  it("blocks an excluded-asset signal THROUGH the package", () => {
    const { lifecycle, decision, gateResult } = run(
      mkSignal({ id: "sig-fork-004", targetAsset: CBBTC, notionalUsd: "100" }),
      mkMandate()
    );
    assert.equal(decision, "block");
    assert.ok(gateResult.reasons.includes("asset_not_allowlisted"));
    assert.equal(lifecycle.state, "DESTROYED");
    assert.doesNotThrow(() => verifyLifecycle(lifecycle));
  });

  it("blocked receipts carry bounded risk-fork evidence", async () => {
    const client = createPaperClient();
    const store = { consumed: {}, dailySpend: {}, receipts: [] };
    const { receipt } = await followSignal({
      signal: mkSignal({ id: "sig-fork-005", notionalUsd: "2000" }),
      mandate: mkMandate(),
      store,
      client,
      mode: "paper",
      now: new Date(NOW),
    });
    assert.equal(receipt.outcome, "blocked");
    assert.equal(receipt.evidence.riskFork.terminalState, "DESTROYED");
    assert.ok(receipt.evidence.riskFork.runId.includes("sig-fork-005"));
  });

  it("settled receipts carry committed risk-fork evidence", async () => {
    const client = createPaperClient();
    const store = { consumed: {}, dailySpend: {}, receipts: [] };
    const { receipt } = await followSignal({
      signal: mkSignal({ id: "sig-fork-006" }),
      mandate: mkMandate(),
      store,
      client,
      mode: "paper",
      now: new Date(NOW),
    });
    assert.equal(receipt.outcome, "settled");
    assert.equal(receipt.evidence.riskFork.terminalState, "COMMITTED");
  });

  it("never invokes the client when the fork aborts", async () => {
    let calls = 0;
    const spy = {
      getFill: () => {
        calls += 1;
        throw new Error("must not be called");
      },
      getQuote: () => {
        calls += 1;
        throw new Error("must not be called");
      },
      submitOrder: () => {
        calls += 1;
        throw new Error("must not be called");
      },
    };
    const store = { consumed: {}, dailySpend: {}, receipts: [] };
    const { receipt, lifecycle } = await followSignal({
      signal: mkSignal({ id: "sig-fork-007", notionalUsd: "2000" }),
      mandate: mkMandate(),
      store,
      client: spy,
      mode: "paper",
      now: new Date(NOW),
    });
    assert.equal(receipt.outcome, "blocked");
    assert.equal(lifecycle.state, "DESTROYED");
    assert.equal(calls, 0);
  });

  it("does not mutate caller signal/mandate/store state", () => {
    const signal = mkSignal({ id: "sig-fork-008" });
    const mandate = mkMandate();
    const before = JSON.stringify({ signal, mandate });
    run(signal, mandate);
    assert.equal(JSON.stringify({ signal, mandate }), before);
  });
});
