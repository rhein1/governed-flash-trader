# governed-flash-trader

A **governed social/copy-trading agent** on [Definitive Flash](https://ddp.definitive.fi).
Followers don't hand a leader a blank check — they issue a **bounded mandate**
(asset allowlist, per-trade and per-day spend caps, mandatory stop-loss, expiry
window), and every copied signal passes a **fork-before-risk gate** before any
signing or submission. Blocked trades emit `not_submitted` evidence and never
touch a wallet or the Flash API.

Built for the **Runtime NYC Definitive Flash — Best Social Trading Build** track.
Submission deadline: **Saturday, September 19, 2026, 4 PM EDT**.

## Paper quickstart (no keys, no network, no money)

```bash
npm install        # zero runtime dependencies
npm test           # 40 tests, all green
npm run demo       # scripted 6-act walkthrough: 1 approval, 4 blocks
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
                         │ 3. quote (Flash REST)                    │
                         │ 4. sign (HMAC request auth)              │
                         │ 5. submit (Flash REST)                   │
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

The agent uses Definitive Flash's documented Portfolio REST API
(`POST /v2/portfolio/trade/quote` → `POST /v2/portfolio/trade`), authenticated
with HMAC-SHA256 request signatures
(`x-definitive-api-key`, `x-definitive-timestamp`, `x-definitive-signature`),
per the [request authorization docs](https://ddp.definitive.fi/request-authorization).

Supported leader strategies and their Flash order types:

| signal strategy | Flash order type | notes |
|-----------------|------------------|-------|
| market          | `market`         | immediate execution |
| limit           | `limit`          | `limit.price` + notional qty |
| twap            | `twap`           | `durationSeconds` + optional `targetTWAPBuckets` |
| stop            | `stop`           | stop-buy entry, `trigger` + optional `limit` |
| stop-loss       | `stop-loss`      | protective exit, sell side |
| take-profit     | `take-profit`    | profit exit, sell side |
| bracket         | `bracket`        | `orderTrigger` with stop-loss + take-profit legs |
| dca             | orchestrated     | **not a native REST `type`**: executed as N governed limit-order legs, each leg independently quoted, gated, and receipted |

DCA honesty note: Flash's REST quote API documents `market`, `limit`,
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

## Live setup

Live mode is **opt-in and fail-closed**:

1. Copy `.env.example` to `.env` and set `FLASH_API_KEY` and `FLASH_API_SECRET`
   (from your Definitive Flash account — never commit them).
2. Pass `--live` explicitly. Without it, everything runs in paper mode.
3. Without credentials, the client **refuses to sign** (`FLASH_CREDENTIALS_REFUSED`)
   before any network call.

```bash
node bin/gft.js follower follow --signal s.json --mandate m.json --store store.json --live
```

Live DCA signals must carry an explicit `params.limitPrice` — paper mode may
fall back to its deterministic reference price, but live mode will not invent a
price. No trades, funding, or wallet operations happen in this repo's paper
path; live execution is the owner's explicit, credentialed action.

## X post

Submission requires an X post tagging `@DefinitiveFi` with its URL in the
Runtime form. Post URL: **TODO — owner to post and paste URL here**.

## Project layout

```
src/
  signal.js    leader signal model + validation + canonical form
  mandate.js   follower mandate model + validation
  gate.js      pure fork-before-risk mandate gate (no I/O, no authority)
  flash.js     Definitive Flash REST client (HMAC auth, quote/submit, order builders)
  paper.js     deterministic paper venue (same client interface, zero network)
  leader.js    signal publishing to a local JSONL feed
  follower.js  follow pipeline: gate -> quote -> sign -> submit -> receipt
  receipts.js  four-stage receipts + not_submitted evidence
  store.js     idempotency + spend store (atomic JSON)
bin/gft.js     CLI: demo | leader publish | follower follow | feed | receipts
test/          40 tests (node:test, zero dependencies)
examples/      sample signal + mandate
```

## License

MIT — see [LICENSE](LICENSE). Open-sourced for the Runtime NYC track.
