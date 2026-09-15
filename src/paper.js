// Deterministic paper-mode mock of the Definitive Flash orders API.
//
// Same interface as src/flash.js (getQuote / submitOrder) but performs zero
// network I/O and needs zero credentials. Every output is a pure function of
// the request, so the demo is reproducible byte-for-byte.

import crypto from "node:crypto";

function hash12(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 12);
}

function hashInt(obj, mod) {
  const h = crypto.createHash("sha256").update(JSON.stringify(obj)).digest();
  return h.readUInt32BE(0) % mod;
}

// Reference prices (USD) for demo assets — fixed so paper quotes are stable.
// Real venues would return live quotes; paper mode is a deterministic stand-in.
export const PAPER_REFERENCE_PRICES = {
  "base:0x4200000000000000000000000000000000000006": 3850.0, // WETH
  "base:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": 97250.0, // cbBTC
  "base:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 1.0, // USDC
};

export function paperReferencePrice(chain, targetAsset) {
  return PAPER_REFERENCE_PRICES[`${chain}:${targetAsset.toLowerCase()}`] ?? 100.0;
}

// Deterministic quote: price wobbles ±0.5% off the reference by request hash.
// Field names follow the Flash v1 quote request (targetChain, orderType,
// side) — the same shape buildOrderRequest() produces.
export function paperQuote(orderRequest) {
  const ref = paperReferencePrice(orderRequest.targetChain, orderRequest.targetAsset);
  const wobbleBps = hashInt({ q: "quote", orderRequest }, 100) - 50; // -50..+49 bps
  const price = ref * (1 + wobbleBps / 10000);
  const notional = Number(orderRequest.qty);
  const amountOut = (notional / price).toFixed(8);
  return {
    quote: {
      orderType: orderRequest.orderType,
      targetChain: orderRequest.targetChain,
      targetAsset: orderRequest.targetAsset,
      contraAsset: orderRequest.contraAsset,
      qty: orderRequest.qty,
      side: orderRequest.side,
      quote: {
        id: `paper-quote-${hash12({ q: "id", orderRequest })}`,
        amountOut,
        price,
        priceImpact: (hashInt({ q: "pi", orderRequest }, 50) / 10000).toFixed(4),
      },
      slippageTolerance: orderRequest.maxSlippage,
    },
  };
}

export function paperSubmit(orderRequest, quoteId) {
  if (!quoteId || !String(quoteId).startsWith("paper-quote-")) {
    const err = new Error("paper submit requires a paper quoteId");
    err.code = "PAPER_INVALID_QUOTE";
    throw err;
  }
  return { orderId: `paper-order-${hash12({ s: "order", orderRequest, quoteId })}` };
}

export function paperFill(orderRequest, quote, orderId) {
  const price = quote.quote.quote.price;
  const qtyOut = quote.quote.quote.amountOut;
  return {
    orderId,
    status: "ORDER_STATUS_FILLED",
    fills: [
      {
        fillId: `paper-fill-${hash12({ f: "fill", orderId })}`,
        price: price.toFixed(4),
        qtyOut,
        txHash: `0x${hash12({ t: "tx", orderId })}${hash12({ t: "tx2", orderId })}${hash12({ t: "tx3", orderId })}${hash12({ t: "tx4", orderId })}${hash12({ t: "tx5", orderId })}`.slice(0, 66),
        venue: "paper-venue",
      },
    ],
  };
}

// Adapter exposing the live-client interface over the deterministic mock.
export function createPaperClient() {
  return {
    mode: "paper",
    async getQuote(orderRequest) {
      return paperQuote(orderRequest);
    },
    async submitOrder(orderRequest, quoteId) {
      return paperSubmit(orderRequest, quoteId);
    },
    async getFill(orderRequest, quote, orderId) {
      return paperFill(orderRequest, quote, orderId);
    },
  };
}
