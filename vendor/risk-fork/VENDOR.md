# Vendored: @agoragentic/risk-fork lifecycle contracts

## Provenance

- **Package:** `@agoragentic/risk-fork` (Agoragentic Risk Fork)
- **Version:** `0.1.0-alpha.1`
- **Source:** `~/workspace/agoragentic-integrations/risk-fork`
  (canonical: https://github.com/rhein1/agoragentic-integrations/tree/main/risk-fork)
- **Vendored on:** 2026-09-15
- **License:** Apache-2.0 — see `LICENSE` (copied verbatim)
- **Attribution:** see `NOTICE` (copied verbatim)

## Why vendored instead of an npm dependency

The package is **not published to npm** (`npm view @agoragentic/risk-fork`
returns 404), so it cannot be installed as a registry dependency.
A `file:` dependency would point outside this repository and break for
anyone cloning from GitHub. Vendoring the modules keeps the build
deterministic and self-contained for public clones.

**Tradeoff:** vendored code can drift from upstream. If the upstream package
is published later, prefer the published dependency and delete this folder.
Until then, treat these files as read-only pins — do not hand-edit them;
re-vendor from the upstream source instead.

## What was vendored

Only the modules needed for the fork-before-risk lifecycle contract
(dependency-closed subset of `src/`):

- `lifecycle.mjs` — create/transition/verify the fork lifecycle state machine
- `canonical.mjs` — canonical JSON + sha256 refs (used for evidence hashing)
- `constants.mjs` — run states, resource states, evidence statuses
- `util.mjs` — assertions and validation helpers

These four modules import only each other and `node:crypto` / `node:path`
— no third-party runtime dependencies.
