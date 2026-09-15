// Mandate gate tests: every bound must block BEFORE signing/submission,
// and the gate must never mutate its inputs (fork-before-risk).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateGate } from "../src/gate.js";
import { validateMandate } from "../src/mandate.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const NOW = "2026-09-16T12:00:00Z";

const baseSignal = {
  id: "sig-1",
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
};

// Validated once: the gate pipeline always receives validated mandates.
const baseMandate = validateMandate({
  followerId: "follower-finch",
  leaderId: "leader-mara",
  assetAllowlist: [{ chain: "base", targetAsset: WETH, symbol: "WETH" }],
  maxSpendPerTradeUsd: "500",
  maxSpendPerDayUsd: "1500",
  stopLossPct: 5,
  validFrom: "2026-09-16T11:00:00Z",
  validUntil: "2026-09-16T18:00:00Z",
});

const ctx = (over = {}) => ({
  now: NOW,
  spentTodayUsd: 0,
  consumedSignalIds: [],
  ...over,
});

describe("gate: allow path", () => {
  it("allows a signal inside every bound, auto-attaching protection", () => {
    const r = evaluateGate({ signal: baseSignal, mandate: baseMandate, context: ctx() });
    assert.equal(r.decision, "allow");
    assert.deepEqual(r.reasons, []);
    assert.equal(r.protectionAttached, true);
    assert.ok(r.checks.every((c) => c.pass));
  });
});

describe("gate: spend bounds", () => {
  it("blocks over-spend per trade", () => {
    const r = evaluateGate({
      signal: { ...baseSignal, notionalUsd: "2000" },
      mandate: baseMandate,
      context: ctx(),
    });
    assert.equal(r.decision, "block");
    assert.ok(r.reasons.includes("over_max_spend_per_trade"));
  });

  it("blocks when daily cap would be exceeded", () => {
    const r = evaluateGate({
      signal: { ...baseSignal, notionalUsd: "400" },
      mandate: baseMandate,
      context: ctx({ spentTodayUsd: 1200 }),
    });
    assert.equal(r.decision, "block");
    assert.ok(r.reasons.includes("over_max_spend_per_day"));
  });
});

describe("gate: mandate window and scope", () => {
  it("blocks an expired mandate", () => {
    const r = evaluateGate({
      signal: baseSignal,
      mandate: baseMandate,
      context: ctx({ now: "2026-09-16T19:30:00Z" }),
    });
    assert.equal(r.decision, "block");
    assert.ok(r.reasons.includes("mandate_expired_or_not_yet_valid"));
  });

  it("blocks a leader outside the mandate scope", () => {
    const r = evaluateGate({
      signal: { ...baseSignal, leaderId: "leader-eve" },
      mandate: baseMandate,
      context: ctx(),
    });
    assert.equal(r.decision, "block");
    assert.ok(r.reasons.includes("leader_not_in_scope"));
  });

  it("blocks an asset not on the allowlist", () => {
    const r = evaluateGate({
      signal: { ...baseSignal, targetAsset: CBBTC },
      mandate: baseMandate,
      context: ctx(),
    });
    assert.equal(r.decision, "block");
    assert.ok(r.reasons.includes("asset_not_allowlisted"));
  });

  it("blocks an expired signal", () => {
    const r = evaluateGate({
      signal: { ...baseSignal, expiresAt: "2026-09-16T11:59:00Z" },
      mandate: baseMandate,
      context: ctx(),
    });
    assert.equal(r.decision, "block");
    assert.ok(r.reasons.includes("signal_expired"));
  });
});

describe("gate: replay / idempotency", () => {
  it("blocks a duplicate signal id", () => {
    const r = evaluateGate({
      signal: baseSignal,
      mandate: baseMandate,
      context: ctx({ consumedSignalIds: ["sig-1"] }),
    });
    assert.equal(r.decision, "block");
    assert.ok(r.reasons.includes("duplicate_signal"));
  });
});

describe("gate: stop-loss protection", () => {
  it("blocks a signal whose own stop-loss is looser (deeper) than the mandate", () => {
    const loose = {
      ...baseSignal,
      id: "sig-loose",
      orderSide: "sell",
      strategy: "stop-loss",
      params: { triggerPrice: "3400" }, // ~11.7% under a 3850 reference: looser than the 5% mandate
    };
    const r = evaluateGate({
      signal: loose,
      mandate: baseMandate,
      context: ctx(),
      referencePriceUsd: 3850,
    });
    assert.equal(r.decision, "block");
    assert.ok(r.reasons.includes("stop_loss_too_loose"));
  });

  it("allows a signal whose stop-loss is tighter than the mandate", () => {
    const tight = {
      ...baseSignal,
      id: "sig-tight",
      orderSide: "sell",
      strategy: "stop-loss",
      params: { triggerPrice: "3750" }, // ~2.6% under 3850: tighter protection than the 5% mandate
    };
    const r = evaluateGate({
      signal: tight,
      mandate: baseMandate,
      context: ctx(),
      referencePriceUsd: 3850,
    });
    assert.equal(r.decision, "allow");
    assert.equal(r.protectionAttached, false);
  });
});

describe("gate: fork-before-risk purity", () => {
  it("never mutates signal, mandate, or context inputs", () => {
    const signal = structuredClone(baseSignal);
    const mandate = structuredClone(baseMandate);
    const context = ctx();
    const before = JSON.stringify({ signal, mandate, context });
    evaluateGate({ signal, mandate, context });
    assert.equal(JSON.stringify({ signal, mandate, context }), before);
  });

  it("returns frozen results", () => {
    const r = evaluateGate({ signal: baseSignal, mandate: baseMandate, context: ctx() });
    assert.ok(Object.isFrozen(r));
    assert.ok(Object.isFrozen(r.checks));
  });
});
