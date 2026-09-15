// Leader agent: publishes validated trade signals to a local feed (JSONL).
// In production this would be a signed broadcast; here it is a file the
// follower reads, which keeps the demo fully local.

import fs from "node:fs";
import { validateSignal, canonicalSignal } from "./signal.js";

export function publishSignal(feedPath, rawSignal) {
  const signal = validateSignal(rawSignal);
  fs.appendFileSync(feedPath, canonicalSignal(signal) + "\n");
  return signal;
}

export function readFeed(feedPath) {
  let raw;
  try {
    raw = fs.readFileSync(feedPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => validateSignal(JSON.parse(l)));
}
