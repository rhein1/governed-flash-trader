#!/usr/bin/env node
// gft-runner — continuous governed follower.
//
//   node bin/gft-runner.js --mandate m.json [--feed feed.jsonl] [--store store.json]
//       [--interval 30] [--live] [--once] [--log runner.log.jsonl] [--a2a-port 8787]
//       [--blotter [blotter.jsonl]]
//
//   node bin/gft-runner.js --a2a-port 8787 [--feed feed.jsonl]
//       # serve-only: just the local A2A leader surface, no following
//
//   --blotter is opt-in mark-to-market: after every pass, settled paper
//   positions are marked against live Flash quotes (read-only) and a
//   snapshot is appended to the blotter JSONL. It is the only runner
//   feature that makes outbound network calls in paper mode.
//
// Tails the leader JSONL feed and runs the governed followSignal() pipeline
// for every new signal. Paper mode is the default (zero credentials, zero
// network); --live prices against real Flash quotes and stays quote-only.
// --a2a-port serves the leader's A2A agent card + getSignals on 127.0.0.1
// (local reference implementation, not a hosted service).
// Restarts never reprocess: the cursor and receipts persist in the store file
// after every signal. SIGINT/SIGTERM finishes the in-flight signal, persists,
// and exits 0.

import fs from "node:fs";
import { validateMandate } from "../src/mandate.js";
import {
  loadStoreWithRunner,
  saveStoreWithRunner,
  createClient,
  runPass,
  runBlotterStep,
} from "../src/runner.js";
import { serveA2A } from "../src/a2a.js";

function arg(name, def = null) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
// arg value that isn't fooled by a following flag: --blotter --once means
// the flag was given without a path, so fall back to the default.
function argPath(name, def) {
  const i = process.argv.indexOf(name);
  if (i === -1) return null; // flag absent
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) return def;
  return v;
}
const has = (name) => process.argv.includes(name);

const mandatePath = arg("--mandate");
const a2aPort = arg("--a2a-port", null);
if (!mandatePath && a2aPort === null) {
  console.error("gft-runner: --mandate <mandate.json> is required (or --a2a-port for serve-only)");
  process.exit(1);
}
const serveOnly = !mandatePath; // --a2a-port without --mandate: just serve the leader surface

const feedPath = arg("--feed", "./feed.jsonl");
const storePath = arg("--store", "./store.json");
const logPath = arg("--log", "./runner.log.jsonl");
const intervalSec = Math.max(1, Number(arg("--interval", "30")) || 30);
const once = has("--once");
const live = has("--live");
// Opt-in mark-to-market: after every pass, mark settled paper positions
// against live Flash quotes. This is the only runner feature that makes
// outbound network calls in paper mode (read-only quotes).
const blotterPath = argPath("--blotter", "./blotter.jsonl");

let shuttingDown = false;
const requestShutdown = () => {
  shuttingDown = true;
};
process.on("SIGINT", requestShutdown);
process.on("SIGTERM", requestShutdown);

function logLine(obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
  console.log(line);
  try {
    fs.appendFileSync(logPath, line + "\n");
  } catch (err) {
    console.error(`gft-runner: cannot append to log ${logPath}: ${err.message}`);
  }
}

// Sleep that wakes early on SIGINT/SIGTERM so shutdown is prompt.
function interruptibleSleep(ms) {
  return new Promise((resolve) => {
    if (shuttingDown || ms <= 0) return resolve();
    const probe = setInterval(() => {
      if (shuttingDown) {
        clearInterval(probe);
        clearTimeout(done);
        resolve();
      }
    }, 100);
    const done = setTimeout(() => {
      clearInterval(probe);
      resolve();
    }, ms);
  });
}

async function main() {
  const mandate = serveOnly ? null : validateMandate(JSON.parse(fs.readFileSync(mandatePath, "utf8")));

  let client;
  let mode;
  try {
    ({ client, mode } = createClient({ live }));
  } catch (err) {
    console.error(`gft-runner: ${err.message}`);
    process.exit(2);
  }

  // Local A2A leader surface (loopback only). Followers discover the leader
  // through the agent card and fetch signals via JSON-RPC.
  let a2a = null;
  if (a2aPort !== null) {
    a2a = await serveA2A({ feedPath, port: Number(a2aPort) });
    logLine({ event: "a2a_serve", url: a2a.url, note: "local-only reference surface, not a hosted service" });
  }

  const store = loadStoreWithRunner(storePath);
  if (!store.runner.stats.startedAt) store.runner.stats.startedAt = new Date().toISOString();
  saveStoreWithRunner(storePath, store);

  logLine({
    event: "runner_start",
    mode,
    feed: feedPath,
    store: storePath,
    intervalSec,
    once,
    serveOnly,
    blotter: blotterPath,
    a2aUrl: a2a?.url ?? null,
    lastSignalId: store.runner.lastSignalId,
  });

  do {
    if (!serveOnly) {
      const summary = await runPass({
        feedPath,
        mandate,
        store,
        storePath,
        client,
        mode,
        onSignal: (outcome) => logLine({ event: "signal", ...outcome }),
      });
      logLine({ event: "pass", ...summary, lastSignalId: store.runner.lastSignalId });
    }
    if (blotterPath) {
      await runBlotterStep({ storePath, blotterPath, onEvent: (e) => logLine(e) });
    }
    if (once || shuttingDown) break;
    await interruptibleSleep(intervalSec * 1000);
  } while (!shuttingDown);

  if (a2a) await a2a.close();
  logLine({
    event: "runner_stop",
    lastSignalId: store.runner.lastSignalId,
    stats: store.runner.stats,
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(`gft-runner: fatal: ${err.message}`);
  process.exit(1);
});
