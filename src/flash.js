// Definitive Flash REST client.
//
// Implements the documented auth + order flow verbatim:
//   https://ddp.definitive.fi/request-authorization
//   https://ddp.definitive.fi/api/trade/quote
//   https://ddp.definitive.fi/api/trade/submit
//
// Flow: build externalOrderRequest -> POST /v2/portfolio/trade/quote
//    -> POST /v2/portfolio/trade { externalOrderRequest, quoteId } -> { orderId }
// Flash handles gas, nonces, MEV protection and retries; the client only
// submits intents.

import crypto from "node:crypto";

export const FLASH_BASE_URL = "https://ddp.definitive.fi";
export const QUOTE_PATH = "/v2/portfolio/trade/quote";
export const SUBMIT_PATH = "/v2/portfolio/trade";

function hmacSha256Hex(secretNoPrefix, message) {
  return crypto.createHmac("sha256", secretNoPrefix).update(message).digest("hex");
}

// Documented prehash:
//   `${method}:${path}?${queryParamsString}:${timestamp}:${sortedHeaders}${bodyString}`
// sortedHeaders = x-definitive-* headers sorted, `key:${JSON.stringify(value)}`, joined by ","
export function preparePrehash({ method, path, timestamp, headers, queryParams = {}, body }) {
  const filtered = Object.entries(headers)
    .filter(([key]) => key.toLowerCase().startsWith("x-definitive-"))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}:${JSON.stringify(value)}`)
    .join(",");
  const queryParamsString = new URLSearchParams(queryParams).toString();
  const bodyString = body ?? "";
  return `${method}:${path}?${queryParamsString}:${timestamp}:${filtered}${bodyString}`;
}

export function signRequest({ apiKey, apiSecret, method, path, queryParams = {}, body, timestamp }) {
  // Fail closed: never sign with missing or placeholder credentials.
  if (
    !apiKey ||
    !apiSecret ||
    /REPLACE_ME/i.test(String(apiKey)) ||
    /REPLACE_ME/i.test(String(apiSecret))
  ) {
    const err = new Error("flash client refuses to sign: missing or placeholder API credentials");
    err.code = "FLASH_CREDENTIALS_REFUSED";
    throw err;
  }
  const ts = timestamp ?? Date.now().toString();
  const headers = {
    "x-definitive-api-key": apiKey,
    "x-definitive-timestamp": ts,
  };
  const bodyString = JSON.stringify(body);
  const prehash = preparePrehash({ method, path, timestamp: ts, headers, queryParams, body: bodyString });
  const secret = String(apiSecret).replace(/^dpks_/, "");
  const signature = hmacSha256Hex(secret, prehash);
  return { headers: { ...headers, "x-definitive-signature": signature }, prehash, signature };
}

export async function signedFetch({ apiKey, apiSecret, method, path, queryParams = {}, body, fetchImpl = fetch }) {
  const { headers } = signRequest({ apiKey, apiSecret, method, path, queryParams, body });
  const qs = new URLSearchParams(queryParams).toString();
  const url = `${FLASH_BASE_URL}${path}${qs ? `?${qs}` : ""}`;
  const res = await fetchImpl(url, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`flash ${method} ${path} failed: ${res.status} ${json.message ?? ""}`.trim());
    err.code = "FLASH_REQUEST_FAILED";
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Map a leader signal to Flash's documented externalOrderRequest shape.
// DCA is a platform feature (not a REST `type`): we execute it as N legs,
// each leg an independent quote->submit of the leg's order type (default limit).
export function buildOrderRequest(signal, { referencePriceUsd = null } = {}) {
  const base = {
    chain: signal.chain,
    targetAsset: signal.targetAsset,
    contraAsset: signal.contraAsset,
    qty: String(signal.notionalUsd), // notional legs; qty semantics documented per-venue
    orderSide: signal.orderSide,
    slippageTolerance: "0.01",
    maxPriceImpact: "0.01",
  };
  const p = signal.params ?? {};

  switch (signal.strategy) {
    case "limit":
      if (!p.limitPrice) throw orderError("limit strategy needs params.limitPrice");
      return { ...base, type: "limit", limit: { price: String(p.limitPrice), isNotional: true } };
    case "twap":
      return {
        ...base,
        type: "twap",
        durationSeconds: Number(p.durationSeconds ?? 3600),
        ...(p.targetTWAPBuckets ? { targetTWAPBuckets: Number(p.targetTWAPBuckets) } : {}),
      };
    case "stop": // stop-buy entry
      if (!p.triggerPrice) throw orderError("stop strategy needs params.triggerPrice");
      return {
        ...base,
        type: "stop",
        triggerType: p.triggerType === "lower" ? "lower" : "upper",
        trigger: { price: String(p.triggerPrice), isNotional: true },
        ...(p.limitPrice ? { limit: { price: String(p.limitPrice), isNotional: true } } : {}),
      };
    case "stop-loss":
      if (signal.orderSide !== "sell") throw orderError("stop-loss orders must be sell side");
      if (!p.triggerPrice) throw orderError("stop-loss strategy needs params.triggerPrice");
      return {
        ...base,
        type: "stop-loss",
        trigger: { price: String(p.triggerPrice), isNotional: true },
        ...(p.limitPrice ? { limit: { price: String(p.limitPrice), isNotional: true } } : {}),
      };
    case "take-profit":
      if (signal.orderSide !== "sell") throw orderError("take-profit orders must be sell side");
      if (!p.triggerPrice) throw orderError("take-profit strategy needs params.triggerPrice");
      return {
        ...base,
        type: "take-profit",
        trigger: { price: String(p.triggerPrice), isNotional: true },
        ...(p.limitPrice ? { limit: { price: String(p.limitPrice), isNotional: true } } : {}),
      };
    case "bracket": {
      const legs = Array.isArray(p.bracketLegs) ? p.bracketLegs : [];
      if (legs.length === 0) throw orderError("bracket strategy needs params.bracketLegs[]");
      return {
        ...base,
        type: "bracket",
        orderTrigger: {
          type: "Trigger_StopBracket",
          limits: legs.map((l) => ({
            price: String(l.price),
            baseAsset: signal.targetAsset,
            quoteAsset: null,
            isLower: l.kind === "stop-loss",
          })),
        },
      };
    }
    case "dca": {
      // DCA as orchestrated legs: the leader's schedule, each leg a limit order.
      const legs = Number(p.dcaLegs ?? 4);
      const perLeg = (Number(signal.notionalUsd) / legs).toFixed(2);
      return {
        dcaLegs: Array.from({ length: legs }, (_, i) => ({
          leg: i + 1,
          of: legs,
          orderRequest: {
            ...base,
            qty: perLeg,
            type: "limit",
            limit: {
              price: String(p.limitPrice ?? referencePriceUsd ?? "0"),
              isNotional: true,
            },
          },
        })),
      };
    }
    case "market":
    default:
      return { ...base, type: "market" };
  }
}

function orderError(msg) {
  const err = new Error(msg);
  err.code = "INVALID_ORDER_REQUEST";
  return err;
}

export async function getQuote({ apiKey, apiSecret, orderRequest, fetchImpl }) {
  return signedFetch({ apiKey, apiSecret, method: "POST", path: QUOTE_PATH, body: orderRequest, fetchImpl });
}

export async function submitOrder({ apiKey, apiSecret, orderRequest, quoteId, fetchImpl }) {
  return signedFetch({
    apiKey,
    apiSecret,
    method: "POST",
    path: SUBMIT_PATH,
    body: { externalOrderRequest: orderRequest, quoteId },
    fetchImpl,
  });
}
