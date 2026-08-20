# Architecture

## Overview

DeFiHub is a Next.js (App Router) monolith: server-rendered pages, API route
handlers, and standalone ingestion workers all live in one codebase and
deploy as one Vercel project. There is no separate backend service, no
message queue, and no in-house blockchain indexer — all on-chain data comes
from two free, public aggregator APIs (DefiLlama and CoinGecko) rather than
direct RPC calls. See [Data pipeline](#data-pipeline) for why.

```
Sync workers (cron-triggered)
        │
        ▼
Provider abstraction (lib/providers) ── DefiLlama / CoinGecko adapters
        │
        ▼
PostgreSQL (Drizzle ORM, lib/database)
        │
        ├──► Query functions (lib/database/queries/*) — the only code that
        │     touches the DB directly; pages and API routes never write raw SQL
        │
        ▼
   ┌────┴─────┐
   ▼          ▼
App Router   Public API (/api/v1/*)
pages                │
   │                 ▼
   ▼            External consumers
Server-rendered UI
   │
   ▼
AI layer (lib/ai) — reads already-verified DB data, never invents figures
```

## Data pipeline

**Blockchain data → workers → normalization → database → queries → API/UI → AI.**

1. **Workers** (`workers/*/sync.ts`) are standalone scripts, runnable directly
   (`npm run sync:tokens`) or via a cron route (`app/api/cron/sync-tokens`,
   authenticated with `CRON_SECRET`). Each one calls a single provider method,
   normalizes the response, and upserts into Postgres.
2. **Provider abstraction** (`lib/providers/types.ts`) defines
   `DefiDataProvider`, `PriceProvider`, and `TokenDiscoveryProvider`
   interfaces. `lib/providers/defillama.ts` and `lib/providers/coingecko.ts`
   are the only two implementations today; every response is validated with
   a Zod schema before it reaches application code, so a shape change on the
   provider's end fails loudly (`ProviderUnavailableError`) instead of
   inserting malformed data. Swapping or adding a provider means implementing
   one of these interfaces and changing the one line that constructs it in
   `lib/providers/index.ts` — nothing else in the app imports provider
   internals directly.
3. **Database** (`lib/database/schema.ts`, Drizzle ORM) is the source of
   truth. Raw provider responses are normalized before they're stored —
   there's no separate "raw" table; normalization happens in the provider
   adapter, one step before the insert.
4. **Query functions** (`lib/database/queries/*.ts`) are the only code
   allowed to query the database directly. Pages, API routes, and workers
   all go through these — this is what keeps a query correct in one place
   instead of copy-pasted SQL drifting across call sites.
5. **API/UI** — the same query functions back both the server-rendered pages
   and the public `/api/v1/*` endpoints, so they can never disagree about
   what a given filter returns.
6. **AI** (`lib/ai/protocol-summary.ts`) sits on top of the verified data
   layer, not beside it — it's given already-computed figures (TVL, fees,
   category) and asked to summarize them, never asked to produce a number on
   its own. See [Source transparency](#source-transparency--methodology).

### Why no direct RPC/indexer

An earlier instruction set for this project asked for a
blockchain → indexer → normalization pipeline built directly on RPC data.
That was deliberately not built: running RPC infrastructure (self-hosted or
a paid provider like Alchemy) across 8 chains is a real, ongoing cost with
no clear benefit over DefiLlama and CoinGecko, which already aggregate,
normalize, and serve the same TVL/price/yield data for free. The provider
abstraction layer exists specifically so this can change later — a
`DefiDataProvider` backed by an indexer is a drop-in replacement — but there
was no reason to build and pay for that infrastructure before it's needed.

### On-chain verification (a small, growing, still-bounded indexer)

`lib/onchain/` reads on-chain figures directly from a free public RPC
endpoint — multi-chain, via the shared viem client config in
`lib/chains/rpc-client.ts` (the same one the `/wallet` feature uses) —
for a hand-picked, well-understood set of entries, and shows the
resulting TVL on each protocol's page as an independent cross-check next
to the DefiLlama figure. Two categories, both bounded by the same
underlying test (below), not two arbitrary carve-outs:

- **AMM pools** (`lib/onchain/config.ts`'s `VERIFIED_POOLS`,
  `lib/onchain/verify-pool.ts`): TVL is the sum of a pool contract's own
  ERC-20 token balances — true for Uniswap V2/V3 and structurally similar
  DEXes regardless of chain, since it never touches the pool's internal
  swap math, only what the contract actually holds.
  `verify-pool.ts` batches every pool on the same chain into one
  `multicall()` call rather than one RPC round-trip per token.
- **Single-figure protocol accounting** (`VERIFIED_PROTOCOL_TVLS`,
  `lib/onchain/verify-protocol-tvl.ts`): some protocols already expose
  one unambiguous "total value under management" figure directly via a
  dedicated view function on their own core contract, because their own
  logic depends on that figure being correct (e.g. a liquid-staking
  token's exchange rate is *derived from* its issuing contract's
  total-staked figure) — reading it is exactly as first-party as summing
  an AMM pool's balances, just a different shape of "the contract's own
  accounting." Lido is the current example: `getTotalPooledEther()` on
  the stETH contract.

The real boundary isn't "AMM good, everything else excluded" - it's
whether the contract *already computes and exposes* the figure as one
number. That's what rules out something like an Aave reserve: TVL there
isn't one call, it's aToken exchange-rate and debt accounting
reconstructed across many separate reserves, with real methodology
choices (gross vs. net of borrows, which price for which asset) - a
fundamentally different, harder problem than reading a value the
protocol was already maintaining for itself. Every entry in either
category still needs a human to confirm the contract address, chain, and
that the read genuinely is the protocol's own canonical figure before
it's added - not auto-discovered, and not extended to arbitrary contracts
generically. Verifying a protocol's most prominent pool(s), or its
single headline accounting figure, is not the same claim as having
independently verified that protocol's entire reported TVL down to every
edge case - the UI and this doc stay explicit about exactly what's
covered.

Prices still come from CoinGecko (`lib/providers/coingecko.ts`) — this
indexer replaces DefiLlama's TVL computation with our own, but doesn't
attempt to replace price discovery, which is a separate, much harder
problem than reading a contract's own balance.

Cost: zero — free public RPC endpoints, no paid tier, refreshed every 30
minutes by `workers/onchain/verify.ts` (the per-chain `*_RPC_URL` env vars
documented in `.env.example` let you swap in a paid provider later if a
public endpoint gets rate-limited).

## Graceful degradation

No single failing dependency should take down the rest of the app. In
practice:

- Every provider call is wrapped so a failure raises `ProviderUnavailableError`
  rather than throwing an unhandled exception; sync workers catch this, log a
  warning, and exit cleanly rather than crashing — one chain's sync failing
  doesn't block the others (they're separate worker invocations).
- Optional integrations (`ANTHROPIC_API_KEY`, `RESEND_API_KEY`,
  `COINGECKO_API_KEY`) all follow the same pattern: check for the env var at
  module load, and if it's absent, degrade to a documented fallback (feature
  hidden, email logged to console, lower rate limit) instead of throwing.
  Nothing fabricates data or a fake success in place of a missing credential.
- Public API and page routes return typed error responses (`apiError()` /
  `NextResponse.json({error}, {status})`) with a generic message to the
  client; the real error is logged server-side only, never leaked in the
  response body.

## Auth & sessions

Auth.js v5, JWT session strategy (required by the Credentials provider —
there's no `sessions` table). Email/password uses bcrypt-hashed passwords;
Google OAuth is optional and hidden entirely when
`AUTH_GOOGLE_ID`/`AUTH_GOOGLE_SECRET` aren't set. `proxy.ts` (Next 16's
replacement for `middleware.ts`) gates `/dashboard`, `/alerts`, and
`/settings` behind a session check and sets a per-request CSP nonce.

## Rate limiting

In-memory sliding-window limiter (`lib/security/rate-limit.ts`), keyed by IP
or user ID depending on the route. This is a deliberate, documented
trade-off: it resets on redeploy and doesn't share state across instances,
which is correctly sized for the current single-instance deployment. Move to
a shared store (Redis) before running more than one instance — don't add
that infrastructure speculatively before it's needed.

## Source transparency & methodology

Every metric traces back to a provider and a timestamp: `protocol_metrics`,
`chain_metrics`, and `token_prices` all store a `timestamp` column per
snapshot, and the footer on every page credits DefiLlama (protocol/chain/
yield data) and CoinGecko (token prices) by name. TVL and yield figures are
DefiLlama's own methodology (this app doesn't recompute them); token prices
and market caps are CoinGecko's. See [data-sources.md](./data-sources.md)
for the exact endpoints and known limitations of each.

## Observability

Every worker and API route logs failures server-side (`console.error`/
`console.warn` with a `[component]` prefix — e.g. `[tokens]`,
`[cron:sync-tokens]`) without exposing internals to the client. There's no
dedicated log aggregation or metrics dashboard yet — Vercel's own function
logs are the current source of truth. If/when a hosted logging or APM tool
is added, evaluate cost against a free tier (e.g. Vercel's own log drains)
before committing to a paid one — see the cost-control note in the README.
