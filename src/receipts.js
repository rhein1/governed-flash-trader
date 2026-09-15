// Settlement receipts.
//
// Every followed signal produces exactly one receipt that separates the four
// stages: authorization (gate decision) -> signature -> submission -> settlement.
// Blocked or failed trades emit `not_submitted` evidence: they are recorded,
// never retried silently, and never touch a wallet or the Flash API.

import crypto from "node:crypto";

function sha256Hex(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

let seq = 0;
export function newReceiptId() {
  seq += 1;
  return `rcpt-${Date.now().toString(36)}-${String(seq).padStart(3, "0")}`;
}

export function mintBlockedReceipt({ signal, mandate, gateResult, mode }) {
  return Object.freeze({
    receiptId: newReceiptId(),
    signalId: signal.id,
    leaderId: signal.leaderId,
    followerId: mandate.followerId,
    mode,
    decidedAt: gateResult.evaluatedAt,
    mandateSnapshotHash: sha256Hex(JSON.stringify(mandate)),
    outcome: "blocked",
    stages: Object.freeze({
      authorization: Object.freeze({
        status: "decided",
        decision: "block",
        reasons: gateResult.reasons,
        checks: gateResult.checks,
      }),
      // Nothing was signed, submitted, or settled: the gate stopped the trade
      // before any authority was exercised.
      signature: Object.freeze({ status: "not_applicable", detail: "blocked before signing" }),
      submission: Object.freeze({ status: "not_submitted", detail: "blocked before submission" }),
      settlement: Object.freeze({ status: "not_applicable", detail: "nothing submitted" }),
    }),
    evidence: Object.freeze({
      notSubmitted: Object.freeze({
        reasons: gateResult.reasons,
        checks: gateResult.checks.map((c) => ({ name: c.name, pass: c.pass })),
      }),
    }),
  });
}

export function mintSettledReceipt({ signal, mandate, gateResult, mode, execution }) {
  // execution: { legs: [{ orderRequest, quote, orderId, fill, signatureId }] }
  return Object.freeze({
    receiptId: newReceiptId(),
    signalId: signal.id,
    leaderId: signal.leaderId,
    followerId: mandate.followerId,
    mode,
    decidedAt: gateResult.evaluatedAt,
    mandateSnapshotHash: sha256Hex(JSON.stringify(mandate)),
    outcome: "settled",
    stages: Object.freeze({
      authorization: Object.freeze({
        status: "decided",
        decision: "allow",
        reasons: [],
        checks: gateResult.checks,
        protectionAttached: gateResult.protectionAttached,
      }),
      signature: Object.freeze({
        status: "signed",
        signatures: execution.legs.map((l) => ({
          orderId: l.orderId,
          signatureId: l.signatureId,
          scheme: mode === "live" ? "api-key/x-definitive-api-key" : "paper-simulated",
        })),
      }),
      submission: Object.freeze({
        status: "submitted",
        orders: execution.legs.map((l) => ({
          orderType: l.orderRequest.orderType,
          quoteId: l.quoteId,
          orderId: l.orderId,
        })),
      }),
      settlement: Object.freeze({
        status: "settled",
        fills: execution.legs.map((l) => l.fill),
      }),
    }),
    evidence: Object.freeze({}),
  });
}

export function mintFailedReceipt({ signal, mandate, gateResult, mode, stage, error }) {
  return Object.freeze({
    receiptId: newReceiptId(),
    signalId: signal.id,
    leaderId: signal.leaderId,
    followerId: mandate.followerId,
    mode,
    decidedAt: new Date().toISOString(),
    mandateSnapshotHash: sha256Hex(JSON.stringify(mandate)),
    outcome: "failed",
    stages: Object.freeze({
      authorization: Object.freeze({ status: "decided", decision: "allow", checks: gateResult.checks }),
      signature: Object.freeze({ status: stage === "signature" ? "failed" : "not_applicable" }),
      submission: Object.freeze({ status: "not_submitted", detail: `failed at ${stage}` }),
      settlement: Object.freeze({ status: "not_applicable" }),
    }),
    evidence: Object.freeze({
      notSubmitted: Object.freeze({ failedAt: stage, error: String(error?.message ?? error) }),
    }),
  });
}
