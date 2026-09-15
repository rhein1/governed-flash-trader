// Fork-gated signal evaluation, enforced by the real Agoragentic Risk Fork
// lifecycle contract (vendor/risk-fork, @agoragentic/risk-fork 0.1.0-alpha.1).
//
// "Clone state never authority": the follower's decision state is forked
// (deep-cloned into a savepoint capsule) BEFORE anything risky happens. The
// mandate gate runs against the fork, never against the caller's live store.
// Only a gate-approved decision is clean-committed back to the controller;
// anything else aborts and the fork is destroyed. Execution (quote/submit)
// is allowed only on the COMMITTED path — enforced by construction, not by
// convention: runForkedGate returns gateResult only together with the
// terminal lifecycle, and callers must check decision === "allow".
//
// Scope note (honest boundaries): this is the experimental fork-before-risk
// contract and its bounded lifecycle evidence. It does NOT claim production
// containment, live protection, or the ability to undo an external action.

import { createLifecycle, transitionLifecycle, verifyLifecycle } from "../vendor/risk-fork/lifecycle.mjs";
import { canonicalize, sha256Ref } from "../vendor/risk-fork/canonical.mjs";
import { evaluateGate } from "./gate.js";

const CLEAN_ACTOR = "clean_controller";

// Evidence for fork destruction: the package requires status=verified plus a
// ref and a hash for the terminal destruction transitions.
function destructionEvidence(runId, capsule) {
  return {
    status: "verified",
    ref: detail(`fork_destroyed;run=${runId}`),
    hash: sha256Ref(canonicalize({ run: runId, forkHash: sha256Ref(canonicalize(capsule.signal)) })),
    detail: detail(`fork_destroyed;run=${runId}`),
  };
}

function step(lifecycle, to, { reason, evidence = {}, fork_resource_state, now }) {
  return transitionLifecycle(lifecycle, {
    actor: CLEAN_ACTOR,
    expected_version: lifecycle.version,
    expected_chain_head: lifecycle.chain_head,
    to,
    reason,
    evidence,
    at: now,
    ...(fork_resource_state ? { fork_resource_state } : {}),
  });
}

function detail(s) {
  // Bounded evidence: the package caps evidence.detail at 500 chars and
  // requires an opaque reference shape (no whitespace, no paths).
  return String(s).replace(/\s+/g, "_").slice(0, 400);
}

/**
 * Evaluate a leader signal through the fork-before-risk lifecycle.
 *
 * @param {object} args
 * @param {object} args.signal    validated leader signal
 * @param {object} args.mandate   validated follower mandate
 * @param {object} args.context   { spentTodayUsd, consumedSignalIds } (now is taken from args.now)
 * @param {number|null} args.referencePriceUsd  price for trigger evaluation (paper/demo)
 * @param {Date|string} args.now
 * @returns {{ lifecycle, gateResult, decision }} — decision is "allow"|"block"
 */
export function runForkedGate({ signal, mandate, context, referencePriceUsd = null, now = new Date() }) {
  const at = new Date(now);
  const runId = `follow-${signal.id}-${mandate.followerId}`;

  // Fork: snapshot the full decision state into a savepoint capsule before
  // risk. This is the "clone state never authority" step — from here on, the
  // gate works only on the clone.
  const capsule = structuredClone({ signal, mandate, context });

  let lifecycle = createLifecycle({
    actor: CLEAN_ACTOR,
    run_id: runId,
    requested_at: at,
    reason: "signal_follow_requested",
    evidence: {
      detail: detail(`signal=${signal.id};follower=${mandate.followerId};leader=${signal.leaderId}`),
    },
  });

  lifecycle = step(lifecycle, "SAVEPOINTING", {
    now: at,
    reason: "forking follower decision state before risk",
    evidence: {
      hash: sha256Ref(canonicalize(capsule.signal)),
      detail: detail(`savepoint;signal=${capsule.signal.id};mandate=${capsule.mandate.followerId}`),
    },
  });
  lifecycle = step(lifecycle, "SAVEPOINT_READY", {
    now: at,
    reason: "decision state cloned; caller state untouched",
    evidence: { detail: detail("fork_state_captured;authority=clean_controller") },
  });
  lifecycle = step(lifecycle, "FORK_STARTING", {
    now: at,
    reason: "fork resource starting",
    fork_resource_state: "ACTIVE",
  });
  lifecycle = step(lifecycle, "FORK_READY", {
    now: at,
    reason: "fork ready for gated execution",
  });
  lifecycle = step(lifecycle, "EXECUTING", {
    now: at,
    reason: "mandate gate executing against the fork (no client invocation yet)",
  });

  // The mandate gate runs on the FORK clone — never on caller state, and
  // before any Flash client invocation. The gate is a pure function of the
  // fork: it cannot spend, sign, submit, or mutate.
  const gateResult = evaluateGate({
    signal: structuredClone(capsule.signal),
    mandate: structuredClone(capsule.mandate),
    context: {
      now: at,
      spentTodayUsd: capsule.context.spentTodayUsd,
      consumedSignalIds: capsule.context.consumedSignalIds,
    },
    referencePriceUsd,
  });

  const taintEvidence = {
    hash: sha256Ref(canonicalize({ checks: gateResult.checks, decision: gateResult.decision })),
    detail: detail(
      `taint scan: gate=${gateResult.decision} reasons=${gateResult.reasons.join(",") || "none"}`
    ),
  };

  if (gateResult.decision === "block") {
    // Tainted fork: the mandate refuses this signal. Abort the fork and
    // destroy it. The caller mints a not_submitted receipt; the client is
    // never invoked on this path.
    lifecycle = step(lifecycle, "ABORTING", {
      now: at,
      reason: "mandate gate blocked the signal; fork aborted before client invocation",
      evidence: taintEvidence,
    });
    lifecycle = step(lifecycle, "ABORTED", { now: at, reason: "fork aborted" });
    lifecycle = step(lifecycle, "DESTROYING", {
      now: at,
      reason: "destroying aborted fork",
      fork_resource_state: "DESTROY_REQUESTED",
    });
    lifecycle = step(lifecycle, "DESTROYED", {
      now: at,
      reason: "fork destroyed; no client invocation occurred",
      fork_resource_state: "DESTROYED",
      evidence: destructionEvidence(runId, capsule),
    });
  } else {
    // Clean fork: the mandate allows this signal. Validate the decision,
    // then clean-commit: only the approved decision (not the fork's mutable
    // state) returns to the controller. The caller may now execute.
    lifecycle = step(lifecycle, "TAINTED", {
      now: at,
      reason: "taint scan complete",
      evidence: taintEvidence,
    });
    lifecycle = step(lifecycle, "VALIDATING", {
      now: at,
      reason: "validating gate decision evidence",
      evidence: { detail: detail(`decision=allow checks=${gateResult.checks.length} protection=${gateResult.protectionAttached}`) },
    });
    lifecycle = step(lifecycle, "COMMIT_READY", {
      now: at,
      reason: "gate decision validated; ready to clean-commit",
    });
    lifecycle = step(lifecycle, "PRECOMMIT_DESTROYING", {
      now: at,
      reason: "destroying fork before committing the clean decision",
      fork_resource_state: "DESTROY_REQUESTED",
    });
    lifecycle = step(lifecycle, "CLEAN_COMMIT_READY", {
      now: at,
      reason: "fork destroyed; clean decision ready",
      fork_resource_state: "DESTROYED",
      evidence: destructionEvidence(runId, capsule),
    });
    lifecycle = step(lifecycle, "COMMITTING", {
      now: at,
      reason: "committing approved decision to the clean controller",
      evidence: {
        detail: detail(`committing_allow_decision;authority=clean_controller`),
      },
    });
    lifecycle = step(lifecycle, "COMMITTED", {
      now: at,
      reason: "decision committed; caller may now invoke the client",
      fork_resource_state: "DESTROYED",
    });
  }

  verifyLifecycle(lifecycle);
  return { lifecycle, gateResult, decision: gateResult.decision };
}

/**
 * Compact bounded evidence for receipts: run id, terminal state, chain
 * head hash, and event count. No unbounded payloads.
 */
export function forkEvidence(lifecycle) {
  return {
    riskForkPackage: "@agoragentic/risk-fork@0.1.0-alpha.1 (vendored)",
    runId: lifecycle.run_id,
    terminalState: lifecycle.state,
    events: lifecycle.events.length,
    chainHead: lifecycle.chain_head,
  };
}
