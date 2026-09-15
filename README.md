# governed-flash-trader

A **governed social/copy-trading agent** on [Definitive Flash](https://www.definitive.fi/flash-api).
Followers don't hand a leader a blank check — they issue a **bounded mandate**
(asset allowlist, per-trade and per-day spend caps, mandatory stop-loss, expiry
window), and every copied signal passes a **fork-before-risk gate** before any
signing or submission. Blocked trades emit `not_submitted` evidence and never
touch a wallet or the Flash API.

Built for the **Runtime NYC Definitive Flash — Best Social Trading Build** track.
Submission deadline: **Saturday, September 19, 2026, 4 PM EDT**.

## Paper quickstart (no keys, no network, no money)

```bash
npm install        # no npm runtime dependencies (the one external module is vendored, not installed)
npm test           # 69 tests, all green
npm run demo       # scripted 6-act walkthrough: 1 approval, 4 blocks
node bin/gft.js demo personas   # 2-minute social-trading demo: 1 signal, 3 followers via A2A
```

The demo is fully deterministic: fixed clock, deterministic paper venue, fixed
reference prices. Run it twice, get byte-identical receipts.

Try the pieces by hand:

```bash
# Leader publishes a signal to the local feed
node bin/gft.js leader publish --signal examples/signal-limit.json --feed ./feed.jsonl

# Follower copies it through the gate (paper mode by default)
node bin/gft.js follower follow --signal examples/signal-limit.json \
  --mandate examples/mandate.json --store ./store.json

# Inspect the receipts
node bin/gft.js receipts --store ./store.json
```

## Architecture

```
 leader                        follower
┌──────────┐   signal     ┌──────────────────────────────────────────┐
│ leader   │─────────────▶│ 1. validate signal + mandate             │
│ publishes│   (JSONL     │ 2. GATE (fork-before-risk, pure, cloned   │
│ signal   │    feed)     │    state — never touches authority)      │
└──────────┘              │    allow? ──no──▶ not_submitted receipt  │
                         │      │                                   │
                         │     yes                                  │
                         │      ▼                                   │
                         │ 3. quote (Flash v1 REST, live market data)   │
                         │ 4. sign (x-definitive-api-key header)      │
                         │ 5. submit (paper: simulated; live:         │
                         │    quote-only — submission needs a funder  │
                         │    wallet this build does not hold)        │
                         │ 6. settled receipt                       │
                         └──────────────────────────────────────────┘
```

The gate (`src/gate.js`) is a **pure function**: it clones signal, mandate, and
context, evaluates nine check families, and returns `allow` or `block`. It holds
no credentials and performs no I/O — by construction, a blocked trade cannot
reach the signing or submission code, because those steps only run on `allow`.

Receipts (`src/receipts.js`) separate the four stages every trade must show:

| stage          | settled trade | blocked trade        |
|----------------|---------------|----------------------|
| authorization  | allow + checks | block + reasons     |
| signature      | signed        | not_applicable       |
| submission     | submitted     | **not_submitted**    |
| settlement     | settled       | not_applicable       |

Blocked trades carry `evidence.notSubmitted` with the exact reasons and check
results — the audit trail for "why didn't this trade happen".

Idempotency (`src/store.js`): consumed signal ids, per-day spend per follower,
and receipts are recorded atomically. A replayed signal id blocks as
`duplicate_signal`; spend only accrues on `settled`.

## Flash advanced orders

The agent uses Definitive Flash's v1 API (`POST https://flash.definitive.fi/v1/quote`),
authenticated with a single `x-definitive-api-key` header (`dpka_…`) — no HMAC,
no secret. Verified 2026-09-15 against the live API and Definitive's official
`@definitive-fi/flash-mcp` client.

Supported leader strategies and their Flash order types:

| signal strategy | Flash orderType | v1 params |
|-----------------|-----------------|-----------|
| market          | `market`         | immediate execution |
| limit           | `limit`          | `limitNotionalPrice` (USD) |
| twap            | `twap`           | `durationSeconds` (min 300) + optional `twapBucketCount` |
| stop            | `stop`           | stop-buy entry, `triggers: [{notionalPrice, triggerType}]` + optional `limitNotionalPrice` |
| stop-loss       | `stop-loss`      | protective exit, sell side, `triggers: [{notionalPrice, triggerType: "lower"}]` |
| take-profit     | `take-profit`    | profit exit, sell side, `triggers: [{notionalPrice, triggerType: "upper"}]` |
| bracket         | `bracket`        | up to two triggers: lower stop-loss + upper take-profit |
| dca             | orchestrated     | **not a native v1 `orderType`**: executed as N governed limit-order legs, each leg independently quoted, gated, and receipted |

DCA honesty note: Flash's v1 quote API documents `market`, `limit`,
`twap`, `stop`, `stop-loss`, `take-profit`, and `bracket`. DCA exists as a
platform feature, not as a REST order type, so a `dca` signal expands into N
limit-order legs under one receipt — every leg still passes the gate and gets
its own quote → signature → submission trail.

## Mandate semantics

A mandate (`src/mandate.js`) is the follower's standing instruction:

- **leaderId** — only this leader's signals are in scope
- **assetAllowlist** — `{ chain, targetAsset, symbol }[]`; anything else blocks
  with `asset_not_allowlisted`
- **maxSpendPerTradeUsd / maxSpendPerDayUsd** — per-trade and rolling-daily caps
- **stopLossPct** — every followed position must carry stop-loss protection at
  least this tight. Signals with their own looser stop block
  (`stop_loss_too_loose`); signals with none get a stop-loss attached from the
  mandate — simulated in paper mode, submitted as a real stop-loss order in
  live mode (derived from the entry price; live refuses rather than trade
  unprotected when no entry price is derivable)
- **validFrom / validUntil** — the mandate's own expiry window, independent of
  each signal's `expiresAt`
- **requireProtection** (default `true`)

The gate additionally enforces signal expiry, replay protection, and strategy
support — nine check families total, all reported per-check on the receipt.

## Governance: fork-before-risk, enforced by the real contract

The follower gate is not hand-rolled plumbing. Every signal is evaluated
through the **actual Agoragentic Risk Fork lifecycle contract**
(`@agoragentic/risk-fork` v0.1.0-alpha.1), vendored under
`vendor/risk-fork/` (the package is not on npm; a `file:` dependency would
break public clones — see `vendor/risk-fork/VENDOR.md` for the provenance
note and the tradeoff).

What the contract enforces (`src/fork-gate.js`):

1. **Fork state before risk** — the signal, mandate, and spend context are
   deep-cloned into a savepoint capsule; the gate runs only on the clone.
2. **Mandate checked before client invocation** — the lifecycle only reaches
   `COMMITTED` on an allow decision. On block the fork transitions
   `EXECUTING → ABORTING → DESTROYED` and the Flash client is never
   invoked — enforced by construction (tests assert a spy client receives
   zero calls on blocked signals).
3. **Bounded evidence** — every receipt carries `evidence.riskFork`
   (`runId`, terminal state, event count, chain-head hash), and each
   lifecycle transition is hash-chained and verifiable with the package's
   own `verifyLifecycle`.

The invariant is Agoragentic's: **clone state, never authority**. The
package supplies the enforcement contract, not new trading logic — the
decision semantics (copy / block / attach-protection) are unchanged.

**Claim boundary (read this):** Risk Fork is an *experimental*
fork-before-risk contract with bounded evidence. This integration does
**not** claim production containment, live protection, or the ability to
undo an external action. It proves a governed decision pipeline with
cryptographically chained evidence — nothing more.

## Social layer: a discoverable leader (A2A)

The leader is a discoverable agent, not just a file:

- **Agent card** (`a2a/agent-card.json`, A2A protocol v0.3.0): name,
  description, skills (`publish-signal`), endpoints, authentication: none.
  Pattern mirrors the Agoragentic card at
  `agoragentic.com/.well-known/agent-card.json`.
- **Local A2A surface** (`src/a2a.js`): `GET /.well-known/agent-card.json`
  and JSON-RPC `getSignals` / `getSignal` over plain HTTP.

```bash
# Serve the leader surface locally (loopback only):
node bin/gft-runner.js --a2a-port 8787 --feed ./feed.jsonl

# Fetch the card:
curl http://127.0.0.1:8787/.well-known/agent-card.json
```

This is a **local reference implementation, not a hosted multi-tenant
service** — it binds `127.0.0.1` only and serves the local feed. The
three persona followers (`degen`, `conservative`, `whale`) discover the
leader through its card and fetch signals via `getSignals`; the persona
path never hardcodes a feed path. `node bin/gft.js demo personas` runs
the whole thing — one leader signal, three mandates, three fates — in
about two minutes, fully deterministic in paper mode.

## Live setup

Live mode is **opt-in, fail-closed, and quote-only**:

1. Copy `.env.example` to `.env` and set `FLASH_API_KEY` (from your Definitive
   account: API Keys → Create a new key → Access Type = Flash — never commit it).
   The key alone can only request quotes; it cannot move funds.
2. Pass `--live` explicitly. Without it, everything runs in paper mode.
3. Without a real key, the client **refuses** (`FLASH_CREDENTIALS_REFUSED`)
   before any network call.
4. Submission stays disabled in this build: Flash's `POST /v1/order` requires a
   funder wallet signature this project does not hold, so live `submitOrder`
   refuses (`LIVE_SUBMIT_UNAVAILABLE`) and the refusal is recorded as a
   submission-stage receipt. Live mode therefore runs the mandate gate against
   **real market quotes** — including live pricing for TWAP, stop-loss, and the
   other advanced order types — without any possibility of moving funds.

```bash
node bin/gft.js follower follow --signal s.json --mandate m.json --store store.json --live
```

Live DCA signals must carry an explicit `params.limitPrice` — paper mode may
fall back to its deterministic reference price, but live mode will not invent a
price. No trades, funding, or wallet operations happen in this repo's paper
path; live quotes are the owner's explicit, credentialed action.

## X post

Submission requires an X post tagging `@DefinitiveFi` with its URL in the
Runtime form. Post URL: **TODO — owner to post and paste URL here**.

## Project layout

```
src/
  signal.js    leader signal model + validation + canonical form
  mandate.js   follower mandate model + validation
  gate.js      pure fork-before-risk mandate gate (no I/O, no authority)
  fork-gate.js gate wired through the real Risk Fork lifecycle contract
  flash.js     Definitive Flash v1 REST client (api-key header, quote/status/cancel, order builders)
  paper.js     deterministic paper venue (same client interface, zero network)
  leader.js    signal publishing to a local JSONL feed
  follower.js  follow pipeline: fork -> gate -> quote -> sign -> submit -> receipt
  runner.js    continuous follower: tails the feed, persists cursor + stats
  personas.js  three follower personas, discovering the leader via A2A
  blotter.js   paper blotter: marks settled positions against live quotes
  a2a.js       local A2A leader surface: agent card + getSignals JSON-RPC
  receipts.js  four-stage receipts + not_submitted evidence
  store.js     idempotency + spend store (atomic JSON)
vendor/
  risk-fork/   vendored @agoragentic/risk-fork@0.1.0-alpha.1 lifecycle
               contracts (canonical.mjs, constants.mjs, util.mjs,
               lifecycle.mjs) + LICENSE/NOTICE/VENDOR.md — not on npm
a2a/
  agent-card.json  A2A protocol v0.3.0 leader agent card
bin/gft.js     CLI: demo [personas] | leader publish | follower follow | feed | receipts | blotter update
bin/gft-runner.js  continuous runner, with optional --a2a-port A2A surface
test/          69 tests (node:test; no test frameworks, no npm test deps)
examples/      sample signal + mandate
```

## License

MIT — see [LICENSE](LICENSE). Open-sourced for the Runtime NYC track.
