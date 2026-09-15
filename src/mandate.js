// Follower mandate model: the bounds a follower grants a leader.
// The mandate is checked BEFORE any signing or submission — never after.

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

export function validateMandate(raw) {
  const errors = [];
  const m = { ...(raw || {}) };

  if (typeof m.followerId !== "string" || !m.followerId.trim())
    errors.push("followerId is required");
  if (typeof m.leaderId !== "string" || !m.leaderId.trim())
    errors.push('leaderId is required (use "*" for any leader)');
  if (!Array.isArray(m.assetAllowlist) || m.assetAllowlist.length === 0)
    errors.push("assetAllowlist must be a non-empty array");
  else
    for (const [i, a] of m.assetAllowlist.entries()) {
      if (typeof a.chain !== "string" || !HEX40.test(a.targetAsset || ""))
        errors.push(`assetAllowlist[${i}] needs { chain, targetAsset 0x }`);
    }
  for (const f of ["maxSpendPerTradeUsd", "maxSpendPerDayUsd"]) {
    if (!/^\d+(\.\d+)?$/.test(String(m[f] ?? "")) || Number(m[f]) <= 0)
      errors.push(`${f} must be a positive decimal string`);
  }
  if (
    typeof m.stopLossPct !== "number" ||
    !(m.stopLossPct > 0) ||
    m.stopLossPct >= 100
  )
    errors.push("stopLossPct must be a number in (0, 100)");
  if (isNaN(Date.parse(m.validFrom))) errors.push("validFrom must be ISO-8601");
  if (isNaN(Date.parse(m.validUntil)))
    errors.push("validUntil must be ISO-8601");
  if (
    !isNaN(Date.parse(m.validFrom)) &&
    !isNaN(Date.parse(m.validUntil)) &&
    Date.parse(m.validUntil) <= Date.parse(m.validFrom)
  )
    errors.push("validUntil must be after validFrom");
  if (m.requireProtection !== undefined && typeof m.requireProtection !== "boolean")
    errors.push("requireProtection must be boolean when set");

  m.requireProtection = m.requireProtection ?? true;

  if (errors.length) {
    const err = new Error(`invalid mandate: ${errors.join("; ")}`);
    err.code = "INVALID_MANDATE";
    err.errors = errors;
    throw err;
  }
  return Object.freeze(m);
}

export function assetAllowed(mandate, chain, targetAsset) {
  const t = String(targetAsset).toLowerCase();
  return mandate.assetAllowlist.some(
    (a) => a.chain === chain && String(a.targetAsset).toLowerCase() === t
  );
}
