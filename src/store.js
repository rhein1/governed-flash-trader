// Idempotency + spend store (JSON file, atomic writes).
//
// Records: consumed signal ids (-> receipt), per-day spend per follower,
// and the receipts themselves. The gate consults this state; the follower
// updates it only after a decision is final.

import fs from "node:fs";
import path from "node:path";

function dayKey(date, followerId) {
  return `${new Date(date).toISOString().slice(0, 10)}:${followerId}`;
}

export function blankStore() {
  return { consumed: {}, dailySpend: {}, receipts: [] };
}

export function loadStore(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const s = JSON.parse(raw);
    return { consumed: s.consumed ?? {}, dailySpend: s.dailySpend ?? {}, receipts: s.receipts ?? [] };
  } catch (err) {
    if (err.code === "ENOENT") return blankStore();
    throw err;
  }
}

export function saveStore(filePath, store) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, filePath);
}

export function isConsumed(store, signalId) {
  return Object.hasOwn(store.consumed, signalId);
}

export function spentTodayUsd(store, now, followerId) {
  return Number(store.dailySpend[dayKey(now, followerId)] ?? 0);
}

// Finalize a decision: record consumption + spend + receipt atomically.
export function recordDecision(store, { signalId, followerId, now, notionalUsd, receipt }) {
  store.consumed[signalId] = receipt.receiptId;
  if (receipt.outcome === "settled") {
    const k = dayKey(now, followerId);
    store.dailySpend[k] = Number(store.dailySpend[k] ?? 0) + Number(notionalUsd);
  }
  store.receipts.push(receipt);
  return store;
}
