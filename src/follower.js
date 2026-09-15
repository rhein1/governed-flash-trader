// Follower agent: copies a leader signal through the governed pipeline.
//
//   signal -> gate (fork-before-risk) -> [block: not_submitted receipt]
//                                     -> [allow: quote -> submit -> (protection leg) -> receipt]
//
// The gate runs on cloned state before ANY signing or submission. A block
// means the Flash client is never invoked — enforced by construction, and
// asserted in tests with a spy client.

import { evaluateGate } from "./gate.js";
import { buildOrderRequest } from "./flash.js";
import { paperReferencePrice } from "./paper.js";
import { mintBlockedReceipt, mintSettledReceipt, mintFailedReceipt } from "./receipts.js";
import { isConsumed, spentTodayUsd } from "./store.js";

export async function followSignal({ signal, mandate, store, client, mode, now = new Date() }) {
  const consumedIds = Object.keys(store.consumed);
  const gateResult = evaluateGate({
    signal,
    mandate,
    context: {
      now,
      spentTodayUsd: spentTodayUsd(store, now, mandate.followerId),
      consumedSignalIds: consumedIds,
    },
    referencePriceUsd: paperReferencePrice(signal.chain, signal.targetAsset),
  });

  if (gateResult.decision === "block") {
    return { receipt: mintBlockedReceipt({ signal, mandate, gateResult, mode }), gateResult };
  }

  try {
    const legs = await executeAllowed({ signal, mandate, gateResult, client, mode });
    const receipt = mintSettledReceipt({ signal, mandate, gateResult, mode, execution: { legs } });
    return { receipt, gateResult };
  } catch (error) {
    const receipt = mintFailedReceipt({ signal, mandate, gateResult, mode, stage: "submission", error });
    return { receipt, gateResult, error };
  }
}

async function executeAllowed({ signal, mandate, gateResult, client, mode }) {
  // Live DCA needs an explicit per-leg limit price: paper mode can fall back
  // to its deterministic reference price, but live mode must not invent one.
  if (mode === "live" && signal.strategy === "dca" && !signal.params?.limitPrice) {
    const err = new Error("live DCA requires params.limitPrice on the signal");
    err.code = "INVALID_ORDER_REQUEST";
    throw err;
  }
  const built = buildOrderRequest(signal, {
    referencePriceUsd: mode === "paper" ? paperReferencePrice(signal.chain, signal.targetAsset) : null,
  });
  // DCA signals expand to legs; every other strategy is a single order.
  const orderRequests = built.dcaLegs ? built.dcaLegs.map((l) => l.orderRequest) : [built];

  const legs = [];
  for (const orderRequest of orderRequests) {
    const quote = await client.getQuote(orderRequest);
    const quoteId = quoteIdOf(quote);
    if (!quoteId) throw new Error("quote returned no id");
    const { orderId } = await client.submitOrder(orderRequest, quoteId);
    const signatureId =
      mode === "live" ? `apikey:${String(quoteId).slice(0, 18)}` : `paper-sig:${String(orderId).slice(-8)}`;
    const fill = client.getFill ? await client.getFill(orderRequest, quote, orderId) : null;
    legs.push({ orderRequest, quote, quoteId, orderId, signatureId, fill });
  }

  // Protection: if the mandate requires it and the signal carried none, the
  // follower attaches a stop-loss from the mandate. Paper mode annotates the
  // receipt (simulation); live mode submits a real stop-loss order derived
  // from the entry price — a followed position is never left unprotected.
  if (gateResult.protectionAttached && legs.length > 0) {
    if (mode === "paper") {
      legs[0] = {
        ...legs[0],
        attachedProtection: {
          type: "stop-loss",
          stopLossPct: mandate.stopLossPct,
          simulated: true,
          note: `paper-simulated auto-attach: stop-loss at ${mandate.stopLossPct}% (mandate)`,
        },
      };
    } else {
      legs.push(await attachLiveStopLoss({ signal, mandate, client, notionalUsd: signal.notionalUsd }));
    }
  }
  return legs;
}

// Entry price the follower can derive without a price oracle: limit/stop
// signals name their price. Anything else cannot be protected automatically.
function entryPriceOf(signal) {
  const p = signal.params ?? {};
  if (signal.strategy === "limit" && Number(p.limitPrice) > 0) return Number(p.limitPrice);
  if (signal.strategy === "stop" && Number(p.limitPrice ?? p.triggerPrice) > 0)
    return Number(p.limitPrice ?? p.triggerPrice);
  return null;
}

function quoteIdOf(quote) {
  return quote?.quote?.quote?.id ?? quote?.quoteId ?? quote?.id ?? null;
}

async function attachLiveStopLoss({ signal, mandate, client, notionalUsd }) {
  const entryPrice = entryPriceOf(signal);
  if (!entryPrice) {
    const err = new Error(
      `live protection attach refused: cannot derive an entry price from strategy "${signal.strategy}" — signal must carry its own stop-loss`
    );
    err.code = "INVALID_ORDER_REQUEST";
    throw err;
  }
  const triggerPrice = (entryPrice * (1 - mandate.stopLossPct / 100)).toFixed(8);
  const orderRequest = buildOrderRequest({
    chain: signal.chain,
    targetAsset: signal.targetAsset,
    contraAsset: signal.contraAsset,
    orderSide: "sell",
    strategy: "stop-loss",
    notionalUsd: String(notionalUsd),
    params: { triggerPrice },
  });
  const quote = await client.getQuote(orderRequest);
  const quoteId = quoteIdOf(quote);
  if (!quoteId) throw new Error("quote returned no id");
  const { orderId } = await client.submitOrder(orderRequest, quoteId);
  return {
    orderRequest,
    quote,
    quoteId,
    orderId,
    signatureId: `apikey:${String(quoteId).slice(0, 18)}`,
    fill: null,
    attachedProtection: {
      type: "stop-loss",
      stopLossPct: mandate.stopLossPct,
      triggerPrice,
      note: `live-attached from mandate: stop-loss trigger ${triggerPrice} (${mandate.stopLossPct}% under entry ${entryPrice})`,
    },
  };
}

export { isConsumed };
