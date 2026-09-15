// End-to-end follower pipeline tests in paper mode:
//   approved signal -> settled receipt with separated stages
//   blocked signal  -> not_submitted receipt, and the Flash client is NEVER called

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { followSignal } from "../src/follower.js";
import { createPaperClient } from "../src/paper.js";
import { validateMandate } from "../src/mandate.js";
import { blankStore, loadStore, recordDecision, isConsumed, spentTodayUsd } from "../src/store.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NOW = new Date("2026-09-16T12:00:00Z");

const signal = (over = {}) => ({
  id: "sig-e2e-1",
  leaderId: "leader-mara",
  chain: "base",
  targetAsset: WETH,
  contraAsset: USDC,
  orderSide: "buy",
  strategy: "limit",
  notionalUsd: "250",
  params: { limitPrice: "3800" },
  rationale: "e2e",
  issuedAt: "2026-09-16T11:55:00Z",
  expiresAt: "2026-09-16T13:00:00Z",
  ...over,
});

const mandate = (over = {}) =>
  validateMandate({
    followerId: "follower-finch",
    leaderId: "leader-mara",
    assetAllowlist: [{ chain: "base", targetAsset: WETH, symbol: "WETH" }],
    maxSpendPerTradeUsd: "500",
    maxSpendPerDayUsd: "1500",
    stopLossPct: 5,
    validFrom: "2026-09-16T11:00:00Z",
    validUntil: "2026-09-16T18:00:00Z",
    ...over,
  });

// A spy client that records every call; used to prove blocked trades
// make ZERO Flash calls.
function spyClient() {
  const calls = [];
  return {
    calls,
    mode: "paper",
    async getQuote(orderRequest) {
      calls.push(["getQuote", orderRequest]);
      return createPaperClient().getQuote(orderRequest);
    },
    async submitOrder(orderRequest, quoteId) {
      calls.push(["submitOrder", orderRequest, quoteId]);
      return createPaperClient().submitOrder(orderRequest, quoteId);
    },
    async getFill(orderRequest, quote, orderId) {
      calls.push(["getFill", orderRequest, quote, orderId]);
      return createPaperClient().getFill(orderRequest, quote, orderId);
    },
  };
}

describe("paper end-to-end: approved signal", () => {
  it("settles with separated authorization/signature/submission/settlement stages", async () => {
    const client = spyClient();
    const store = loadStore("/tmp/gft-test-store.json");
    const { receipt, gateResult } = await followSignal({
      signal: signal(),
      mandate: mandate(),
      store,
      client,
      mode: "paper",
      now: NOW,
    });

    assert.equal(gateResult.decision, "allow");
    assert.equal(receipt.outcome, "settled");
    assert.equal(receipt.stages.authorization.decision, "allow");
    assert.equal(receipt.stages.signature.status, "signed");
    assert.equal(receipt.stages.submission.status, "submitted");
    assert.equal(receipt.stages.settlement.status, "settled");
    assert.equal(receipt.stages.submission.orders.length, 1);
    assert.match(receipt.stages.submission.orders[0].orderId, /^paper-order-/);
    assert.ok(client.calls.length >= 3, "quote + submit + fill were invoked");
    assert.equal(isConsumed(store, "sig-e2e-1"), false, "store untouched until recorded");
  });

  it("records spend and consumption when the decision is finalized", async () => {
    const client = spyClient();
    const store = loadStore("/tmp/gft-test-store.json");
    const { receipt } = await followSignal({
      signal: signal({ id: "sig-e2e-2" }),
      mandate: mandate(),
      store,
      client,
      mode: "paper",
      now: NOW,
    });
    recordDecision(store, {
      signalId: "sig-e2e-2",
      followerId: "follower-finch",
      now: NOW,
      notionalUsd: "250",
      receipt,
    });
    assert.equal(isConsumed(store, "sig-e2e-2"), true);
    assert.equal(spentTodayUsd(store, NOW, "follower-finch"), 250);
  });
});

describe("paper end-to-end: blocked signal", () => {
  it("emits not_submitted evidence and makes ZERO Flash calls (over-spend)", async () => {
    const client = spyClient();
    const store = loadStore("/tmp/gft-test-store.json");
    const { receipt, gateResult } = await followSignal({
      signal: signal({ id: "sig-e2e-big", notionalUsd: "2000" }),
      mandate: mandate(),
      store,
      client,
      mode: "paper",
      now: NOW,
    });

    assert.equal(gateResult.decision, "block");
    assert.equal(receipt.outcome, "blocked");
    assert.equal(receipt.stages.submission.status, "not_submitted");
    assert.equal(receipt.stages.signature.status, "not_applicable");
    assert.deepEqual(receipt.evidence.notSubmitted.reasons, ["over_max_spend_per_trade", "over_max_spend_per_day"]);
    assert.equal(client.calls.length, 0, "blocked trade must never touch the Flash client");
  });

  it("blocked trades add no spend but do record the decision", async () => {
    const client = spyClient();
    const store = loadStore("/tmp/gft-test-store.json");
    const { receipt } = await followSignal({
      signal: signal({ id: "sig-e2e-off", targetAsset: "0x0000000000000000000000000000000000000001" }),
      mandate: mandate(),
      store,
      client,
      mode: "paper",
      now: NOW,
    });
    recordDecision(store, {
      signalId: "sig-e2e-off",
      followerId: "follower-finch",
      now: NOW,
      notionalUsd: "250",
      receipt,
    });
    assert.equal(receipt.outcome, "blocked");
    assert.equal(spentTodayUsd(store, NOW, "follower-finch"), 0);
    assert.equal(client.calls.length, 0);
  });

  it("a replayed signal id is blocked as duplicate", async () => {
    const client = spyClient();
    const store = loadStore("/tmp/gft-test-store.json");
    const { receipt } = await followSignal({
      signal: signal({ id: "sig-e2e-2" }),
      mandate: mandate(),
      store: { ...store, consumed: { "sig-e2e-2": "rcpt-old" }, dailySpend: {}, receipts: [] },
      client,
      mode: "paper",
      now: NOW,
    });
    assert.equal(receipt.outcome, "blocked");
    assert.deepEqual(receipt.evidence.notSubmitted.reasons, ["duplicate_signal"]);
    assert.equal(client.calls.length, 0);
  });
});

describe("live-mode protection attach (mock client, zero credentials)", () => {
  // Mock live client: same interface as the real one, no network, no keys.
  const mockLiveClient = () => {
    const calls = [];
    return {
      calls,
      mode: "live",
      getFill: null,
      async getQuote(orderRequest) {
        calls.push(["getQuote", orderRequest.type]);
        return { quoteId: `live-q-${calls.length}` };
      },
      async submitOrder(orderRequest, quoteId) {
        calls.push(["submitOrder", orderRequest.type, quoteId]);
        return { orderId: `live-o-${calls.length}` };
      },
    };
  };

  it("submits a real stop-loss order when the signal carries none", async () => {
    const client = mockLiveClient();
    const { receipt, gateResult } = await followSignal({
      signal: signal({ id: "sig-live-1" }), // limit buy @ 3800, no stop-loss
      mandate: mandate(),
      store: blankStore(),
      client,
      mode: "live",
      now: NOW,
    });
    assert.equal(gateResult.decision, "allow");
    assert.equal(gateResult.protectionAttached, true);
    assert.equal(receipt.outcome, "settled");
    assert.equal(receipt.stages.submission.orders.length, 2);
    assert.equal(receipt.stages.submission.orders[0].orderType, "limit");
    assert.equal(receipt.stages.submission.orders[1].orderType, "stop-loss");
    // 3800 entry, 5% mandate -> 3610 trigger
    const stopQuotes = client.calls.filter((c) => c[0] === "getQuote" && c[1] === "stop-loss");
    assert.equal(stopQuotes.length, 1);
    assert.deepEqual(client.calls.map((c) => c[0]), [
      "getQuote",
      "submitOrder",
      "getQuote",
      "submitOrder",
    ]);
  });

  it("refuses live attach when no entry price is derivable (market signal)", async () => {
    const client = mockLiveClient();
    const { receipt } = await followSignal({
      signal: signal({ id: "sig-live-2", strategy: "market", params: {} }),
      mandate: mandate(),
      store: blankStore(),
      client,
      mode: "live",
      now: NOW,
    });
    // Entry was quoted+submitted, but protection could not be attached:
    // fail closed with not_submitted evidence instead of trading unprotected.
    assert.equal(receipt.outcome, "failed");
    assert.equal(receipt.stages.submission.status, "not_submitted");
    assert.equal(receipt.evidence.notSubmitted.failedAt, "submission");
  });
});
