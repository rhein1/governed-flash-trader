// Signal + mandate validation tests.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateSignal, canonicalSignal } from "../src/signal.js";
import { validateMandate } from "../src/mandate.js";

const goodSignal = {
  id: "sig-1",
  leaderId: "leader-mara",
  chain: "base",
  targetAsset: "0x4200000000000000000000000000000000000006",
  contraAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  orderSide: "buy",
  strategy: "limit",
  notionalUsd: "250",
  params: { limitPrice: "3800" },
  rationale: "ok",
  issuedAt: "2026-09-16T11:55:00Z",
  expiresAt: "2026-09-16T13:00:00Z",
};

const goodMandate = {
  followerId: "follower-finch",
  leaderId: "leader-mara",
  assetAllowlist: [{ chain: "base", targetAsset: "0x4200000000000000000000000000000000000006", symbol: "WETH" }],
  maxSpendPerTradeUsd: "500",
  maxSpendPerDayUsd: "1500",
  stopLossPct: 5,
  validFrom: "2026-09-16T11:00:00Z",
  validUntil: "2026-09-16T18:00:00Z",
};

describe("signal validation", () => {
  it("accepts a well-formed signal and freezes it", () => {
    const s = validateSignal(goodSignal);
    assert.equal(s.id, "sig-1");
    assert.ok(Object.isFrozen(s));
  });

  it("rejects non-positive notional", () => {
    assert.throws(() => validateSignal({ ...goodSignal, notionalUsd: "0" }), /notionalUsd/);
    assert.throws(() => validateSignal({ ...goodSignal, notionalUsd: "-5" }), /notionalUsd/);
  });

  it("rejects unknown strategies", () => {
    assert.throws(() => validateSignal({ ...goodSignal, strategy: "yolo" }), /strategy/);
  });

  it("requires matching strategy params", () => {
    assert.throws(() => validateSignal({ ...goodSignal, strategy: "limit", params: {} }), /limitPrice/);
    assert.throws(() => validateSignal({ ...goodSignal, strategy: "twap", params: {} }), /durationSeconds/);
    assert.throws(
      () => validateSignal({ ...goodSignal, strategy: "dca", params: { dcaLegs: 1 } }),
      /at least 2/
    );
  });

  it("canonical form is key-ordered and stable for hashing", () => {
    const a = canonicalSignal(validateSignal(goodSignal));
    const b = canonicalSignal(validateSignal({ ...structuredClone(goodSignal), extra: "x" }));
    assert.equal(a, b);
    assert.ok(a.startsWith('{"chain"'));
  });
});

describe("mandate validation", () => {
  it("accepts a well-formed mandate and freezes it", () => {
    const m = validateMandate(goodMandate);
    assert.equal(m.followerId, "follower-finch");
    assert.ok(Object.isFrozen(m));
  });

  it("requires stopLossPct within (0, 100)", () => {
    assert.throws(() => validateMandate({ ...goodMandate, stopLossPct: 0 }), /stopLossPct/);
    assert.throws(() => validateMandate({ ...goodMandate, stopLossPct: 100 }), /stopLossPct/);
  });

  it("requires a non-empty allowlist and sane spend caps", () => {
    assert.throws(() => validateMandate({ ...goodMandate, assetAllowlist: [] }), /assetAllowlist/);
    assert.throws(() => validateMandate({ ...goodMandate, maxSpendPerTradeUsd: "0" }), /maxSpendPerTradeUsd/);
  });

  it("rejects an inverted validity window", () => {
    assert.throws(
      () =>
        validateMandate({
          ...goodMandate,
          validFrom: "2026-09-16T18:00:00Z",
          validUntil: "2026-09-16T11:00:00Z",
        }),
      /validFrom/
    );
  });
});
