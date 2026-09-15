// Leader signal model: a published trade signal followers can copy.
// A signal is intent only — it never moves money by itself.

export const STRATEGIES = [
  "market",
  "limit",
  "twap",
  "stop", // stop-buy (breakout / dip-buy entry)
  "stop-loss",
  "take-profit",
  "bracket",
  "dca", // orchestrated strategy: executed as legs over the Flash orders API
];

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

export function validateSignal(raw) {
  const errors = [];
  const s = { ...(raw || {}) };

  if (typeof s.id !== "string" || !s.id.trim()) errors.push("id is required");
  if (typeof s.leaderId !== "string" || !s.leaderId.trim())
    errors.push("leaderId is required");
  if (typeof s.chain !== "string" || !s.chain.trim())
    errors.push("chain is required");
  if (!HEX40.test(s.targetAsset || ""))
    errors.push("targetAsset must be a 0x contract address");
  if (!HEX40.test(s.contraAsset || ""))
    errors.push("contraAsset must be a 0x contract address");
  if (s.orderSide !== "buy" && s.orderSide !== "sell")
    errors.push('orderSide must be "buy" or "sell"');
  if (!STRATEGIES.includes(s.strategy))
    errors.push(`strategy must be one of ${STRATEGIES.join(", ")}`);
  if (!/^\d+(\.\d+)?$/.test(String(s.notionalUsd ?? "")) || Number(s.notionalUsd) <= 0)
    errors.push("notionalUsd must be a positive decimal string");
  if (typeof s.rationale !== "string" || !s.rationale.trim())
    errors.push("rationale is required");
  if (isNaN(Date.parse(s.issuedAt))) errors.push("issuedAt must be ISO-8601");
  if (isNaN(Date.parse(s.expiresAt))) errors.push("expiresAt must be ISO-8601");
  if (
    !isNaN(Date.parse(s.issuedAt)) &&
    !isNaN(Date.parse(s.expiresAt)) &&
    Date.parse(s.expiresAt) <= Date.parse(s.issuedAt)
  )
    errors.push("expiresAt must be after issuedAt");

  // strategy-specific params: a leader signal must carry everything the
  // executor needs, so malformed intent is rejected at publish time.
  s.params = s.params && typeof s.params === "object" ? { ...s.params } : {};
  const p = s.params;
  const priceStr = (v) => typeof v === "string" && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0;
  if (s.strategy === "limit" && !priceStr(p.limitPrice))
    errors.push("limit strategy needs params.limitPrice (positive decimal string)");
  if (["stop", "stop-loss", "take-profit"].includes(s.strategy) && !priceStr(p.triggerPrice))
    errors.push(`${s.strategy} strategy needs params.triggerPrice (positive decimal string)`);
  if (s.strategy === "twap" && !(Number(p.durationSeconds) > 0))
    errors.push("twap strategy needs params.durationSeconds (positive number)");
  if (s.strategy === "bracket") {
    const legs = p.bracketLegs;
    if (!Array.isArray(legs) || legs.length === 0)
      errors.push("bracket strategy needs params.bracketLegs (non-empty array)");
    else if (!legs.every((l) => l && priceStr(l.price) && ["stop-loss", "take-profit"].includes(l.kind)))
      errors.push("bracketLegs[] entries need { price, kind: 'stop-loss' | 'take-profit' }");
  }
  if (s.strategy === "dca" && p.dcaLegs !== undefined && !(Number(p.dcaLegs) >= 2))
    errors.push("dca strategy needs params.dcaLegs of at least 2 when set");

  if (errors.length) {
    const err = new Error(`invalid signal: ${errors.join("; ")}`);
    err.code = "INVALID_SIGNAL";
    err.errors = errors;
    throw err;
  }
  return Object.freeze(s);
}

// Canonical form for hashing / idempotency keys: keys sorted recursively so
// the same signal always serializes identically regardless of key order.
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])])
    );
  }
  return value;
}

export function canonicalSignal(s) {
  return JSON.stringify(
    sortKeys({
      id: s.id,
      leaderId: s.leaderId,
      chain: s.chain,
      targetAsset: s.targetAsset.toLowerCase(),
      contraAsset: s.contraAsset.toLowerCase(),
      orderSide: s.orderSide,
      strategy: s.strategy,
      notionalUsd: String(s.notionalUsd),
      params: s.params,
      rationale: s.rationale,
      issuedAt: s.issuedAt,
      expiresAt: s.expiresAt,
    })
  );
}
