# Demo walkthrough — governed-flash-trader (2–3 minutes)

One command, no keys, no network, fully deterministic:

```bash
npm run demo   # or: node bin/gft.js demo
```

## Act 1 — The leader publishes (0:00–0:30)

Leader `leader-mara` publishes a signal: **buy WETH, limit $3,800, $250
notional**, with a written rationale. A signal is intent only — it moves no
money by itself. Every signal is validated at publish time (address format,
positive notional, strategy-specific params, expiry after issuance).

## Act 2 — The follower's mandate (0:30–1:00)

Follower `follower-finch` has a standing mandate, not a blank check:

- only `leader-mara` is in scope
- only WETH on Base is tradable
- max **$500 per trade**, **$1,500 per day**
- every position carries a **5% stop-loss** (auto-attached if the signal has none)
- the mandate itself expires at 18:00 UTC

## Act 3 — The approved trade (1:00–1:40)

The $250 signal passes all nine gate checks. Watch the receipt's four stages:

```
outcome   : settled   (mode: paper)
auth      : allow
signature : signed
submission: submitted  orders: limit:paper-order-857d3de457de
settlement: settled
protection: auto-attached stop-loss 5% (mandate)
```

The signal carried no stop-loss, so the follower attached one from the mandate
before submitting. Authorization, signature, submission, and settlement are
recorded as separate stages — never blurred together.

## Act 4 — The blocks (1:40–2:40)

Four signals, four blocks — each with `not_submitted` evidence and **zero**
Flash calls:

1. **Oversize** — $2,000 vs the $500/trade cap → `over_max_spend_per_trade`
2. **Off-mandate asset** — cbBTC isn't on the WETH-only allowlist →
   `asset_not_allowlisted`
3. **Replay** — the same signal id as Act 3 → `duplicate_signal` (no double-spend)
4. **Expired mandate** — 19:30 is past the 18:00 window →
   `mandate_expired_or_not_yet_valid`

```
outcome   : blocked   (mode: paper)
auth      : block  reasons: over_max_spend_per_trade, over_max_spend_per_day
signature : not_applicable
submission: not_submitted
settlement: not_applicable
evidence  : not_submitted ["over_max_spend_per_trade","over_max_spend_per_day"]
```

The summary: **1 settled, 4 blocked. 0 credentials, 0 network calls, 0 dollars
moved.**

## What to say on camera

> "Copy trading today is a blank check: you mirror a leader and hope. This is a
> *governed* trader. The follower writes a mandate — which assets, how much per
> trade and per day, mandatory stop-loss, when the permission expires — and a
> fork-before-risk gate checks every signal against it *before* anything is
> signed. The trade you just saw approved went through a Flash limit order with
> an auto-attached stop-loss. The four you saw blocked never reached signing —
> the receipts prove it with `not_submitted` evidence. Advanced order types
> — limit, TWAP, stop, stop-loss, take-profit, bracket, plus DCA as governed
> legs — are how the follower executes; the mandate is what keeps the follower
> safe."

## Behind the scenes

- `npm test` — 40 tests: gate bounds, stop-loss enforcement, replay
  idempotency, blocked-trades-make-zero-Flash-calls (spy client), and an
  openssl-verified HMAC signing vector.
- `node bin/gft.js receipts --store ./store.json` — inspect receipts from a
  manual run.
- Live mode (`--live` + `FLASH_API_KEY`/`FLASH_API_SECRET`) is fail-closed and
  untouched by this demo — paper is the default.
