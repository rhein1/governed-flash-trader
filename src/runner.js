// Runner engine: tails a leader JSONL feed and runs the governed follower
// pipeline for every new signal. Importable and testable; bin/gft-runner.js
// is the thin CLI wrapper (arg parsing, signal handling, loop).
//
// Guarantees:
// - Every signal is attempted exactly once: the persisted cursor
//   (store.runner.lastSignalId) plus the idempotency store's consumed set
//   mean restarts never reprocess.
// - The store (cursor, receipts, spend) is saved after EVERY signal, so a
//   crash or SIGTERM mid-pass loses nothing already decided.
// - The gate is never bypassed: every signal goes through followSignal().
// - No prices are invented: paper mode uses the deterministic venue;
//   live mode uses real Flash quotes and is quote-only by design
//   (src/flash.js submitOrder refuses LIVE_SUBMIT_UNAVAILABLE).
// - A malformed feed line is counted and skipped; it never kills a pass.

import fs from "node:fs";
import { validateSignal } from "./signal.js";
import { followSignal } from "./follower.js";
import { loadStore, saveStore, recordDecision, isConsumed } from "./store.js";
import { createPaperClient } from "./paper.js";
import { getQuote, submitOrder } from "./flash.js";

export function blankRunnerState() {
  return {
    // Lexicographically greatest signal id attempted. Signal ids are expected
    // to increase lexicographically (zero-padded sequence, ISO timestamp
    // prefix, ...). The consumed set below is the backstop for anything else.
    lastSignalId: null,
    stats: {
      startedAt: null,
      passes: 0,
      signalsSeen: 0,
      processed: 0,
      allowed: 0,
      blocked: 0,
      failed: 0,
      skippedConsumed: 0,
      skippedMalformed: 0,
      lastSignalAt: null,
      lastError: null,
    },
  };
}

// loadStore() drops unknown keys, so the runner cursor is re-attached here
// from the raw file. saveStore() writes the whole object back, cursor included.
export function loadStoreWithRunner(storePath) {
  const store = loadStore(storePath);
  const blank = blankRunnerState();
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    store.runner = { ...blank, ...(raw.runner ?? {}) };
    store.runner.stats = { ...blank.stats, ...(store.runner.stats ?? {}) };
  } catch {
    store.runner = blank;
  }
  return store;
}

export function saveStoreWithRunner(storePath, store) {
  saveStore(storePath, store);
}

// Client factory shared with bin/gft.js. Paper is the default (zero
// credentials, zero network). --live needs FLASH_API_KEY and stays
// quote-only: submitOrder() in src/flash.js refuses without a funder wallet.
export function createClient({ live = false } = {}) {
  if (!live) return { client: createPaperClient(), mode: "paper" };
  const apiKey = process.env.FLASH_API_KEY;
  if (!apiKey || apiKey.includes("REPLACE_ME")) {
    const err = new Error(
      "live mode refused: set FLASH_API_KEY (see .env.example). Paper mode needs nothing."
    );
    err.code = "FLASH_CREDENTIALS_REFUSED";
    throw err;
  }
  return {
    client: {
      mode: "live",
      getFill: null,
      getQuote: (orderRequest) => getQuote({ apiKey, orderRequest }),
      submitOrder: (orderRequest, quoteId) => submitOrder({ orderRequest, quoteId }),
    },
    mode: "live",
  };
}

// Tolerant feed reader: one bad line is counted and skipped, never fatal.
export function readFeedTolerant(feedPath) {
  let raw;
  try {
    raw = fs.readFileSync(feedPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { signals: [], malformed: 0 };
    throw err;
  }
  const signals = [];
  let malformed = 0;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      signals.push(validateSignal(JSON.parse(trimmed)));
    } catch {
      malformed += 1;
    }
  }
  return { signals, malformed };
}

function isNewSignal(store, signal) {
  if (isConsumed(store, signal.id)) return false; // idempotency backstop
  const lastId = store.runner?.lastSignalId ?? null;
  return lastId === null || signal.id > lastId;
}

function maxId(a, b) {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  return a > b ? a : b;
}

// One pass over the feed. Returns a summary; calls onSignal(outcome) after
// each processed signal (already persisted by then).
export async function runPass({
  feedPath,
  mandate,
  store,
  storePath,
  client,
  mode,
  now = new Date(),
  onSignal = null,
}) {
  const { signals, malformed } = readFeedTolerant(feedPath);
  const st = store.runner.stats;
  st.passes += 1;
  st.signalsSeen += signals.length;
  st.skippedMalformed += malformed;
  const summary = { pass: st.passes, seen: signals.length, malformed, processed: 0, outcomes: [] };

  for (const signal of signals) {
    if (!isNewSignal(store, signal)) {
      st.skippedConsumed += 1;
      continue;
    }
    const t0 = Date.now();
    let outcome;
    try {
      // The full governed pipeline: gate -> quote -> submit -> receipt.
      // followSignal never throws for pipeline outcomes (it mints failed
      // receipts); the catch below is for runner-level faults only.
      const { receipt, gateResult } = await followSignal({ signal, mandate, store, client, mode, now });
      recordDecision(store, {
        signalId: signal.id,
        followerId: mandate.followerId,
        now,
        notionalUsd: signal.notionalUsd,
        receipt,
      });
      outcome = {
        signalId: signal.id,
        leaderId: signal.leaderId,
        decision: gateResult.decision,
        outcome: receipt.outcome,
        receiptId: receipt.receiptId,
        orderTypes: (receipt.stages.submission.orders ?? []).map((o) => o.orderType),
        mode,
        ms: Date.now() - t0,
      };
      st.processed += 1;
      if (receipt.outcome === "settled") st.allowed += 1;
      else if (receipt.outcome === "blocked") st.blocked += 1;
      else st.failed += 1;
    } catch (err) {
      outcome = {
        signalId: signal.id,
        leaderId: signal.leaderId,
        decision: "error",
        outcome: "runner_error",
        error: `${err.code ?? "UNKNOWN"}: ${err.message}`,
        mode,
        ms: Date.now() - t0,
      };
      st.failed += 1;
      st.lastError = outcome.error;
    }
    // Advance the cursor past every attempted signal: a poison signal can't
    // wedge the runner. Its error is in stats.lastError and the run log.
    store.runner.lastSignalId = maxId(store.runner.lastSignalId, signal.id);
    st.lastSignalAt = new Date().toISOString();
    saveStoreWithRunner(storePath, store);
    summary.processed += 1;
    summary.outcomes.push(outcome);
    if (onSignal) await onSignal(outcome);
  }
  saveStoreWithRunner(storePath, store);
  return summary;
}
