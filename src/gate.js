// Fork-before-risk approval gate.
//
// "Clone state, never authority": the gate works on frozen clones of the
// signal, the mandate, and the follower's current spend/consumption state.
// It is a pure function — no network, no wallet, no signing, no mutation.
// A block decision means the trade is NEVER submitted; the caller mints a
// `not_submitted` receipt instead.

import { assetAllowed } from "./mandate.js";

function check(name, pass, detail) {
  return { name, pass, detail: detail ?? null };
}

/**
 * @param {object} args
 * @param {object} args.signal    validated leader signal
 * @param {object} args.mandate   validated follower mandate
 * @param {object} args.context   { now: Date|string, spentTodayUsd: string|number, consumedSignalIds: string[]|Set }
 * @param {number|null} args.referencePriceUsd  price used to evaluate trigger protection (paper/demo)
 */
export function evaluateGate({ signal, mandate, context, referencePriceUsd = null }) {
  // Clone everything up front: the gate may not mutate caller state.
  const s = structuredClone(signal);
  const m = structuredClone(mandate);
  const now = new Date(context.now).getTime();
  const spentToday = Number(context.spentTodayUsd ?? 0);
  const consumed = new Set(context.consumedSignalIds ?? []);
  const notional = Number(s.notionalUsd);

  const checks = [];
  const reasons = [];

  const fail = (name, reason, detail) => {
    checks.push(check(name, false, detail));
    reasons.push(reason);
  };
  const pass = (name, detail) => checks.push(check(name, true, detail));

  // 1. mandate window
  if (now >= Date.parse(m.validFrom) && now <= Date.parse(m.validUntil)) {
    pass("mandate_window", `${m.validFrom}..${m.validUntil}`);
  } else {
    fail("mandate_window", "mandate_expired_or_not_yet_valid", {
      now: new Date(now).toISOString(),
      validFrom: m.validFrom,
      validUntil: m.validUntil,
    });
  }

  // 2. leader scope
  if (m.leaderId === "*" || m.leaderId === s.leaderId) {
    pass("leader_scope", s.leaderId);
  } else {
    fail("leader_scope", "leader_not_in_scope", {
      signalLeader: s.leaderId,
      mandateLeader: m.leaderId,
    });
  }

  // 3. asset allowlist
  if (assetAllowed(m, s.chain, s.targetAsset)) {
    pass("asset_allowed", `${s.chain}:${s.targetAsset}`);
  } else {
    fail("asset_allowed", "asset_not_allowlisted", {
      chain: s.chain,
      targetAsset: s.targetAsset,
    });
  }

  // 4. signal freshness
  if (now <= Date.parse(s.expiresAt)) {
    pass("signal_fresh", s.expiresAt);
  } else {
    fail("signal_fresh", "signal_expired", { expiresAt: s.expiresAt });
  }

  // 5. per-trade spend
  if (notional <= Number(m.maxSpendPerTradeUsd)) {
    pass("spend_per_trade", `${notional} <= ${m.maxSpendPerTradeUsd}`);
  } else {
    fail("spend_per_trade", "over_max_spend_per_trade", {
      notional,
      max: Number(m.maxSpendPerTradeUsd),
    });
  }

  // 6. per-day spend
  if (spentToday + notional <= Number(m.maxSpendPerDayUsd)) {
    pass("spend_per_day", `${spentToday}+${notional} <= ${m.maxSpendPerDayUsd}`);
  } else {
    fail("spend_per_day", "over_max_spend_per_day", {
      spentToday,
      notional,
      max: Number(m.maxSpendPerDayUsd),
    });
  }

  // 7. replay / idempotency
  if (!consumed.has(s.id)) {
    pass("not_replay", s.id);
  } else {
    fail("not_replay", "duplicate_signal", { signalId: s.id });
  }

  // 8. strategy supported
  const FLASH_TYPES = new Set([
    "market",
    "limit",
    "twap",
    "stop",
    "stop-loss",
    "take-profit",
    "bracket",
  ]);
  const isDca = s.strategy === "dca";
  if (FLASH_TYPES.has(s.strategy) || isDca) {
    pass("strategy_supported", s.strategy);
  } else {
    fail("strategy_supported", "unsupported_strategy", { strategy: s.strategy });
  }

  // 9. stop-loss protection: every followed position must cap downside at most
  // at the mandate's stopLossPct (a smaller trigger depth = tighter protection).
  // - stop-loss / bracket strategies carry their own trigger: evaluate it.
  // - anything else: the follower auto-attaches a stop-loss leg from the mandate.
  let protectionAttached = false;
  if (m.requireProtection) {
    const triggerPct = signalStopLossPct(s, referencePriceUsd);
    if (triggerPct !== null) {
      if (triggerPct <= m.stopLossPct) {
        pass("protection", `signal stop-loss depth ${triggerPct}% <= mandate max ${m.stopLossPct}%`);
      } else {
        fail("protection", "stop_loss_too_loose", {
          signalPct: triggerPct,
          mandatePct: m.stopLossPct,
        });
      }
    } else {
      protectionAttached = true;
      pass("protection", `auto-attach stop-loss at ${m.stopLossPct}% (mandate)`);
    }
  } else {
    pass("protection", "protection not required by mandate");
  }

  const decision = reasons.length === 0 ? "allow" : "block";
  return Object.freeze({
    decision,
    reasons: Object.freeze([...reasons]),
    checks: Object.freeze(checks),
    protectionAttached,
    evaluatedAt: new Date(now).toISOString(),
  });
}

// Returns the signal's own stop-loss tightness (trigger depth %) or null when
// the signal carries no stop-loss trigger (the follower will attach one).
function signalStopLossPct(s, referencePriceUsd) {
  if (!referencePriceUsd) return null;
  const ref = Number(referencePriceUsd);
  let trigger = null;
  if (s.strategy === "stop-loss" || s.strategy === "stop" || s.strategy === "take-profit") {
    trigger = Number(s.params?.triggerPrice);
  } else if (s.strategy === "bracket") {
    const leg = (s.params?.bracketLegs ?? []).find((l) => l.kind === "stop-loss");
    trigger = leg ? Number(leg.price) : NaN;
  }
  if (!(trigger > 0)) return null;
  if (s.orderSide === "sell" && trigger < ref) {
    return ((ref - trigger) / ref) * 100;
  }
  if (s.orderSide === "buy") {
    // protective stop on a long entry expressed vs reference
    return (Math.abs(ref - trigger) / ref) * 100;
  }
  return null;
}
