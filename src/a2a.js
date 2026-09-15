// A2A leader surface: a minimal, LOCAL-ONLY reference implementation.
//
// The leader is discoverable through a standard A2A agent card
// (a2a/agent-card.json, protocol v0.3.0) and exposes a tiny JSON-RPC 2.0
// surface:
//
//   GET  /.well-known/agent-card.json   -> agent card (url field = bound address)
//   POST /  {jsonrpc:"2.0", method:"getSignals", params:{limit}, id}
//                                         -> { result: [signalEnvelope, ...] }
//   POST /  {jsonrpc:"2.0", method:"getSignal", params:{id}, id}
//                                         -> { result: signalEnvelope | null }
//
// This is a local reference implementation, not a hosted multi-tenant
// service: it binds 127.0.0.1 only. Followers discover the leader via the
// card and fetch signals via JSON-RPC — the persona path never hardcodes a
// feed path.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSignal } from "./signal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const A2A_PROTOCOL_VERSION = "0.3.0";

export function loadAgentCard() {
  const cardPath = path.join(__dirname, "..", "a2a", "agent-card.json");
  return JSON.parse(fs.readFileSync(cardPath, "utf8"));
}

// Validate the card against the A2A schema shape we serve and rely on.
// This is a local shape check, not the full A2A JSON Schema — the README
// labels it as such.
export function validateAgentCard(card) {
  const problems = [];
  const need = (cond, msg) => {
    if (!cond) problems.push(msg);
  };
  need(card && typeof card === "object", "card must be an object");
  need(typeof card?.name === "string" && card.name.length > 0, "card.name must be a non-empty string");
  need(typeof card?.description === "string" && card.description.length > 0, "card.description must be a non-empty string");
  need(card?.protocolVersion === A2A_PROTOCOL_VERSION, `card.protocolVersion must be ${A2A_PROTOCOL_VERSION}`);
  need(typeof card?.url === "string" && card.url.length > 0, "card.url must be a non-empty string");
  need(Array.isArray(card?.skills) && card.skills.length > 0, "card.skills must be a non-empty array");
  const publish = card?.skills?.find((s) => s.id === "publish-signal");
  need(!!publish, 'card.skills must include a skill with id "publish-signal"');
  need(typeof publish?.description === "string" && publish.description.length > 0, "publish-signal skill must have a description");
  if (problems.length) {
    const err = new Error(`invalid A2A agent card: ${problems.join("; ")}`);
    err.code = "INVALID_AGENT_CARD";
    err.problems = problems;
    throw err;
  }
  return card;
}

function readRecentSignals(feedPath, limit = 20) {
  const signals = [];
  let raw;
  try {
    raw = fs.readFileSync(feedPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      signals.push(validateSignal(JSON.parse(trimmed)));
    } catch {
      // Malformed feed lines are skipped by the serving layer, exactly as
      // the runner does; a bad line must not break discovery.
    }
  }
  return signals.slice(-Math.max(1, limit));
}

// Starts the local A2A server. Returns { url, server, close }.
// Binds 127.0.0.1 only: this is a local reference surface.
export async function serveA2A({ feedPath, port = 8787, host = "127.0.0.1" }) {
  const card = loadAgentCard();
  let boundUrl = null; // set once the socket binds; card.url tracks it
  const server = http.createServer((req, res) => {
    const send = (status, body, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
      const served = { ...card, url: boundUrl ?? `http://${host}:${port}` };
      return send(200, JSON.stringify(served, null, 2));
    }
    if (req.method === "POST" && (req.url === "/" || req.url === "/jsonrpc")) {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1_000_000) req.destroy();
      });
      req.on("end", () => {
        let msg;
        try {
          msg = JSON.parse(body);
        } catch {
          return send(200, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
        }
        const { method, params = {}, id = null } = msg ?? {};
        const ok = (result) => send(200, JSON.stringify({ jsonrpc: "2.0", id, result }));
        const fail = (code, message) => send(200, JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
        if (msg?.jsonrpc !== "2.0") return fail(-32600, "invalid request: jsonrpc must be 2.0");
        if (method === "getSignals") {
          return ok(readRecentSignals(feedPath, params.limit ?? 20));
        }
        if (method === "getSignal") {
          const found = readRecentSignals(feedPath, 1000).find((s) => s.id === params.id) ?? null;
          return ok(found);
        }
        return fail(-32601, `method not found: ${method}`);
      });
      return;
    }
    return send(404, JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const boundPort = typeof address === "object" ? address.port : port;
  const url = `http://${host}:${boundPort}`;
  boundUrl = url;
  return {
    url,
    server,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ---------------------------------------------------------------------------
// Follower-side discovery client: card -> endpoint -> signals.
// ---------------------------------------------------------------------------

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GET ${url} -> ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`GET ${url}: invalid JSON`));
          }
        });
      })
      .on("error", reject);
  });
}

function httpPostJson(url, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(new Error(`POST ${url}: invalid JSON`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

// Discover the leader: fetch the agent card, validate its shape, return it.
export async function discoverLeader(baseUrl) {
  const card = await httpGetJson(`${baseUrl}/.well-known/agent-card.json`);
  return validateAgentCard(card);
}

// Fetch signals through the discovered card's JSON-RPC endpoint.
// Every signal is re-validated as a signal envelope on receipt.
export async function fetchSignals(baseUrl, { limit = 20 } = {}) {
  const card = await discoverLeader(baseUrl);
  const endpoint = card.endpoints?.jsonrpc ?? "/";
  const reply = await httpPostJson(
    `${card.url.replace(/\/$/, "")}${endpoint.startsWith("/") ? endpoint : "/" + endpoint}`,
    { jsonrpc: "2.0", id: "gft-1", method: "getSignals", params: { limit } }
  );
  if (reply.error) {
    const err = new Error(`getSignals failed: ${reply.error.message}`);
    err.code = "A2A_RPC_ERROR";
    throw err;
  }
  return (reply.result ?? []).map((s) => validateSignal(s));
}
