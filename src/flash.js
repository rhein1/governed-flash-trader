// Definitive Flash REST client (v1).
//
// Verified 2026-09-15 against the live API and Definitive's official
// @definitive-fi/flash-mcp client (github.com/DefinitiveCo/flash-mcp):
//   base:   https://flash.definitive.fi/v1
//   auth:   `x-definitive-api-key: dpka_…` header only — no HMAC, no secret.
//   quote:  POST /quote
//   status: GET  /orders/{orderId}
//   cancel: POST /orders/{orderId}/cancel
//
// Quote fields: targetChain, contraChain, targetAsset, contraAsset, side
// ("buy"|"sell"), qty (decimal string; spent units — contraAsset units for
// buys, targetAsset units for sells), orderType one of market | limit | twap |
// stop | stop-loss | take-profit | bracket.
// Advanced params: limitNotionalPrice (USD limit price, required for limit),
// durationSeconds + twapBucketCount (twap), triggers[] of
// {notionalPrice, triggerType: "upper"|"lower"} max 2 (stop / stop-loss /
// take-profit / bracket), expireTime (ISO-8601, for limit/trigger orders).
//
// Live submission is intentionally unavailable in this build: POST /order
// requires funderAddress + userSignature + evmOrderTypedData produced by a
// locally signing wallet, and this project holds no wallet and never will
// without the owner's explicit setup. Live mode therefore runs the mandate
// gate against REAL quotes (live market data, live advanced-order pricing)
// and refuses to submit. Paper mode (the default) simulates the full
// quote -> submit pipeline with zero credentials.

export const FLASH_BASE_URL = "https://flash.definitive.fi/v1";
export const QUOTE_PATH = "/quote";
export const ORDER_PATH = "/order";
export const orderStatusPath = (orderId) => `/orders/${encodeURIComponent(orderId)}`;
export const orderCancelPath = (orderId) => `/orders/${encodeURIComponent(orderId)}/cancel`;

export const ORDER_TYPES = Object.freeze([
  "market",
  "limit",
  "twap",
  "stop",
  "stop-loss",
  "take-profit",
  "bracket",
]);

function credentialsRefused() {
  const err = new Error("flash client refuses: missing or placeholder FLASH_API_KEY");
  err.code = "FLASH_CREDENTIALS_REFUSED";
  return err;
}

// Fail closed: never touch the network without a real key.
export function assertApiKey(apiKey) {
  if (!apiKey || /REPLACE_ME/i.test(String(apiKey)) || /^(sk|test|example)/i.test(String(apiKey).trim())) {
    throw credentialsRefused();
  }
  return String(apiKey);
}

export async function apiFetch({ apiKey, method, path, body, fetchImpl = fetch }) {
  const key = assertApiKey(apiKey);
  const res = await fetchImpl(`${FLASH_BASE_URL}${path}`, {
    method,
    headers: { "x-definitive-api-key": key, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text.length ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.error?.message ?? json?.message ?? text.slice(0, 300);
    const err = new Error(`flash ${method} ${path} failed: ${res.status} ${msg}`.trim());
    err.code = "FLASH_REQUEST_FAILED";
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Map a leader signal to a Flash v1 quote request. DCA is not a native v1
// orderType: the leader's schedule expands to N governed limit legs, each an
// independent quote request (the follower quotes/submits each leg in turn).
export function buildOrderRequest(signal, { referencePriceUsd = null } = {}) {
  const base = {
    targetChain: signal.chain,
    contraChain: signal.contraChain ?? signal.chain,
    targetAsset: signal.targetAsset,
    contraAsset: signal.contraAsset,
    side: signal.orderSide,
    // Buys spend contraAsset units; sells spend targetAsset units. A sell
    // signal carries notionalUsd, so qty is the notional and the venue prices
    // it — documented simplification, never silently converted.
    qty: String(signal.notionalUsd),
    maxSlippage: "0.01",
    maxPriceImpact: "0.01",
  };
  const p = signal.params ?? {};
  const expireTime = p.expireTime ? { expireTime: String(p.expireTime) } : {};

  switch (signal.strategy) {
    case "limit":
      if (!p.limitPrice) throw orderError("limit strategy needs params.limitPrice");
      return {
        ...base,
        orderType: "limit",
        limitNotionalPrice: String(p.limitPrice),
        ...expireTime,
      };
    case "twap": {
      const durationSeconds = Number(p.durationSeconds ?? 3600);
      if (!Number.isFinite(durationSeconds) || durationSeconds < 300) {
        throw orderError("twap strategy needs params.durationSeconds >= 300");
      }
      return {
        ...base,
        orderType: "twap",
        durationSeconds,
        ...(p.twapBucketCount ? { twapBucketCount: Number(p.twapBucketCount) } : {}),
      };
    }
    case "stop": {
      // Stop-buy entry: trigger fires when price moves up through the level.
      if (!p.triggerPrice) throw orderError("stop strategy needs params.triggerPrice");
      return {
        ...base,
        orderType: "stop",
        triggers: [
          {
            notionalPrice: String(p.triggerPrice),
            triggerType: p.triggerType === "lower" ? "lower" : "upper",
          },
        ],
        ...(p.limitPrice ? { limitNotionalPrice: String(p.limitPrice) } : {}),
        ...expireTime,
      };
    }
    case "stop-loss":
      if (signal.orderSide !== "sell") throw orderError("stop-loss orders must be sell side");
      if (!p.triggerPrice) throw orderError("stop-loss strategy needs params.triggerPrice");
      return {
        ...base,
        orderType: "stop-loss",
        triggers: [{ notionalPrice: String(p.triggerPrice), triggerType: "lower" }],
        ...(p.limitPrice ? { limitNotionalPrice: String(p.limitPrice) } : {}),
        ...expireTime,
      };
    case "take-profit":
      if (signal.orderSide !== "sell") throw orderError("take-profit orders must be sell side");
      if (!p.triggerPrice) throw orderError("take-profit strategy needs params.triggerPrice");
      return {
        ...base,
        orderType: "take-profit",
        triggers: [{ notionalPrice: String(p.triggerPrice), triggerType: "upper" }],
        ...(p.limitPrice ? { limitNotionalPrice: String(p.limitPrice) } : {}),
        ...expireTime,
      };
    case "bracket": {
      // Bracket = up to two triggers on one order: a lower stop-loss and an
      // upper take-profit. v1 expresses this via the triggers array (max 2).
      const legs = Array.isArray(p.bracketLegs) ? p.bracketLegs : [];
      if (legs.length === 0 || legs.length > 2) {
        throw orderError("bracket strategy needs params.bracketLegs[1..2]");
      }
      return {
        ...base,
        orderType: "bracket",
        triggers: legs.map((l) => {
          if (!l.price || (l.kind !== "stop-loss" && l.kind !== "take-profit")) {
            throw orderError("bracket legs need {price, kind: stop-loss|take-profit}");
          }
          return {
            notionalPrice: String(l.price),
            triggerType: l.kind === "stop-loss" ? "lower" : "upper",
          };
        }),
        ...expireTime,
      };
    }
    case "dca": {
      const legs = Number(p.dcaLegs ?? 4);
      if (!Number.isInteger(legs) || legs < 2 || legs > 24) {
        throw orderError("dca strategy needs params.dcaLegs as an integer 2..24");
      }
      const perLeg = (Number(signal.notionalUsd) / legs).toFixed(2);
      return {
        dcaLegs: Array.from({ length: legs }, (_, i) => ({
          leg: i + 1,
          of: legs,
          orderRequest: {
            ...base,
            qty: perLeg,
            orderType: "limit",
            limitNotionalPrice: String(p.limitPrice ?? referencePriceUsd ?? "0"),
            ...expireTime,
          },
        })),
      };
    }
    case "market":
    default:
      return { ...base, orderType: "market" };
  }
}

function orderError(msg) {
  const err = new Error(msg);
  err.code = "INVALID_ORDER_REQUEST";
  return err;
}

// Read-only: prices an order request against live markets. No wallet, no
// signing, no funds movement — the key alone cannot trade.
export async function getQuote({ apiKey, orderRequest, fetchImpl }) {
  return apiFetch({ apiKey, method: "POST", path: QUOTE_PATH, body: orderRequest, fetchImpl });
}

export async function getOrder({ apiKey, orderId, fetchImpl }) {
  return apiFetch({ apiKey, method: "GET", path: orderStatusPath(orderId), fetchImpl });
}

export async function cancelOrder({ apiKey, orderId, fetchImpl }) {
  return apiFetch({ apiKey, method: "POST", path: orderCancelPath(orderId), fetchImpl });
}

// Fail closed by design: live submission needs a funder wallet signature
// (funderAddress + userSignature + evmOrderTypedData) and this build holds
// no wallet. The interface is kept so the follower pipeline is structurally
// identical in both modes; the refusal is recorded as a submission-stage
// receipt, never silently skipped.
export async function submitOrder() {
  const err = new Error(
    "live submit refused: no funder wallet configured — live mode is quote-only. " +
      "Attach a signing wallet out-of-band to enable submission."
  );
  err.code = "LIVE_SUBMIT_UNAVAILABLE";
  throw err;
}
