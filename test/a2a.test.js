// A2A leader tests: the agent card validates against the A2A schema
// shape (protocol 0.3.0, publish-signal skill), and persona followers
// obtain signals through the card + JSON-RPC surface — no hardcoded feed
// path anywhere in the persona path.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadAgentCard,
  validateAgentCard,
  serveA2A,
  discoverLeader,
  fetchSignals,
  A2A_PROTOCOL_VERSION,
} from "../src/a2a.js";
import { runPersonas, personasSignal } from "../src/personas.js";
import { validateSignal } from "../src/signal.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("A2A agent card", () => {
  it("loads from the repo and validates against the A2A schema shape", () => {
    const card = loadAgentCard();
    assert.equal(card.protocolVersion, A2A_PROTOCOL_VERSION);
    assert.equal(A2A_PROTOCOL_VERSION, "0.3.0");
    assert.doesNotThrow(() => validateAgentCard(card));
    assert.ok(card.skills.some((s) => s.id === "publish-signal"));
  });

  it("rejects a card missing the publish-signal skill", () => {
    const bad = { ...loadAgentCard(), skills: [] };
    assert.throws(() => validateAgentCard(bad), /publish-signal/);
  });

  it("rejects a card with the wrong protocol version", () => {
    const bad = { ...loadAgentCard(), protocolVersion: "9.9.9" };
    assert.throws(() => validateAgentCard(bad), /protocolVersion/);
  });
});

describe("A2A leader surface", () => {
  it("serves the card at /.well-known/agent-card.json with the bound url", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gft-a2a-"));
    const feedPath = path.join(dir, "feed.jsonl");
    fs.writeFileSync(feedPath, JSON.stringify(personasSignal()) + "\n");
    const a2a = await serveA2A({ feedPath, port: 0 });
    try {
      const card = await discoverLeader(a2a.url);
      assert.equal(card.url, a2a.url);
      assert.equal(card.protocolVersion, "0.3.0");
      const signals = await fetchSignals(a2a.url, { limit: 5 });
      assert.equal(signals.length, 1);
      assert.equal(signals[0].id, "sig-personas-001");
      // Receipt-side validation: every fetched signal is a valid envelope.
      assert.doesNotThrow(() => validateSignal(signals[0]));
    } finally {
      await a2a.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips malformed feed lines instead of breaking discovery", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gft-a2a-"));
    const feedPath = path.join(dir, "feed.jsonl");
    fs.writeFileSync(
      feedPath,
      "not json at all\n" + JSON.stringify(personasSignal()) + "\n"
    );
    const a2a = await serveA2A({ feedPath, port: 0 });
    try {
      const signals = await fetchSignals(a2a.url);
      assert.equal(signals.length, 1);
    } finally {
      await a2a.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("personas via A2A discovery", () => {
  it("three followers get the signal via the card, never a feed path", async () => {
    const { signal, results, leaderUrl } = await runPersonas();
    assert.ok(leaderUrl.startsWith("http://127.0.0.1:"));
    assert.equal(signal.id, "sig-personas-001");
    const outcomes = Object.fromEntries(results.map((r) => [r.name, r.receipt.outcome]));
    assert.deepEqual(outcomes, { degen: "settled", conservative: "blocked", whale: "settled" });
    // Same deterministic fates as the direct path, now with fork evidence.
    for (const r of results) {
      assert.ok(r.receipt.evidence.riskFork);
      assert.ok(["COMMITTED", "DESTROYED"].includes(r.receipt.evidence.riskFork.terminalState));
    }
  });

  it("personas work against a separately-served leader (leaderUrl option)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gft-a2a-"));
    const feedPath = path.join(dir, "feed.jsonl");
    fs.writeFileSync(feedPath, JSON.stringify(personasSignal()) + "\n");
    const a2a = await serveA2A({ feedPath, port: 0 });
    try {
      const { results } = await runPersonas({ leaderUrl: a2a.url });
      const outcomes = Object.fromEntries(results.map((r) => [r.name, r.receipt.outcome]));
      assert.deepEqual(outcomes, { degen: "settled", conservative: "blocked", whale: "settled" });
    } finally {
      await a2a.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
