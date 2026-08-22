# Native data (Phase 4)

How DeFiHub computes a small number of metrics itself, directly from
blockchain data, instead of only displaying DefiLlama/CoinGecko's numbers.
This is a foundation and proof-of-concept — not a replacement for the
external providers, which remain the primary source for almost everything
in the app. See [architecture.md](./architecture.md) for the rest of the
system; this doc covers only what's new.

## Why this exists

[architecture.md](./architecture.md#why-no-direct-rpcindexer) documents a
deliberate earlier decision *not* to build a general RPC-based indexer,
because running RPC infrastructure across 8 chains has a real ongoing cost
with no clear benefit over free aggregator APIs for most metrics. That
reasoning still holds for *most* of DeFiHub's data. It doesn't mean "never
compute anything ourselves" — for a specific, well-understood, narrow class
of on-chain reads (a pool contract's own token balances), DeFiHub already
had a small "on-chain verification" system computing a genuinely
independent TVL figure (see `lib/onchain/`). Phase 4 extends that existing
system — canonical database entities instead of only a config array, real
historical observations instead of only a latest snapshot, and an
explicit code boundary for "native data, with provenance" — rather than
building a second, parallel indexing system next to it.

The goal is not "replace DefiLlama." It's being able to honestly say *this
specific figure was independently computed by DeFiHub from a live on-chain
read*, and expanding that set of figures deliberately, one well-understood
case at a time.

## What already existed before Phase 4

Confirmed by reading the code before writing anything new (per the
project's own instruction not to build a parallel system) — all of this
predates Phase 4 and Phase 4 builds on it rather than replacing it:

| Piece | File(s) | What it does |
|---|---|---|
| Chain/RPC configuration | `lib/chains/rpc-client.ts` | Per-chain RPC URL (operator override or public default), optional per-chain fallback URL, viem `Chain` definitions |
| Resilient RPC client | `lib/chains/rpc-resilient-client.ts` | Retries with full-jitter exponential backoff, failover across configured providers, credential redaction, a deliberately read-only client type |
| RPC error classification | `lib/chains/rpc-errors.ts` | Distinguishes retryable (timeout/rate-limit/transient) from permanent (malformed/config) failures, walking viem's error `.cause` chain |
| Reorg/finality assumptions | `lib/chains/confirmations.ts` | Per-chain confirmation depth (Ethereum 12, Polygon 128, others 20) - documented, not uniform |
| On-chain token decimals | `lib/chains/token-decimals.ts` | Batched `decimals()` reads via multicall, strict uint8 validation, failures tracked separately, never defaulted |
| Indexing checkpoint state | `lib/indexing/state.ts` | Generic `(chainSlug, component)` cursor, atomic upsert, cursor never regresses |
| Event-log ingestion primitives | `lib/indexing/events.ts` | Chunked `eth_getLogs`, resumable cursor-based scanning, confirmation-depth safety |
| Structured logging / sync tracking | `lib/observability/` | `logger.ts`, `sync-run.ts` (the `sync_runs` table), `sync-health.ts` |
| Provider abstraction | `lib/providers/types.ts` | `DefiDataProvider`, `PriceProvider`, `TokenDiscoveryProvider` interfaces; CoinGecko/DefiLlama are the only implementations today |
| Native AMM pool TVL calculation | `lib/onchain/verify-pool.ts`, `lib/onchain/config.ts` | Sums a pool contract's own ERC-20 balances, normalizes by decimals, values in USD - DeFiHub's own math, not copied from DefiLlama |
| Native single-figure protocol TVL | `lib/onchain/verify-protocol-tvl.ts` | Reads a protocol's own canonical accounting figure directly (e.g. Lido's `getTotalPooledEther()`) |

If you're about to build something that sounds like "RPC client," "retry
logic," "checkpoint," or "reorg safety," check this table first — it
probably already exists.

## What Phase 4 added

1. **Canonical `pools` / `pool_tokens` tables** (`lib/database/schema.ts`).
   `lib/onchain/config.ts`'s `VERIFIED_POOLS` array stays the source of
   truth an engineer edits and reviews (see its own module comment on why
   pools are hand-curated, never auto-discovered) — these tables are the
   derived, queryable representation of those same entries.
   `lib/onchain/pools.ts`'s `syncPoolsFromConfig()` upserts them by
   `configKey` every time `verifyAllPools()` runs, so they never drift from
   the config.
2. **`historical_observations` table** — a generic, append-only time series
   (`chainId`, `entityType`, `entityId`, `metric`, `value`, `timestamp`,
   `blockNumber`, `blockHash`, `priceSource`, `priceRetrievedAt`,
   `calculationInputs`, `source`, `calculationVersion`). `onchain_verifications`
   (pre-existing) stays as the fast "latest value" lookup the protocol
   page's `OnchainVerificationCard` already reads — a single upserted row
   per pool, no history. `historical_observations` is the durable history
   that upsert was previously discarding on every overwrite.
   `verifyAllPools()` now writes to both on every successful verification.
   `onchain_verifications.tvl_usd` stays fixed at its existing 2-decimal
   contract; `historical_observations.value` (`numeric(32,8)`) is rounded
   independently from the same underlying figure, so a real sub-cent pool
   TVL contribution doesn't get floored to `$0.00` before it ever reaches
   the higher-precision column. See [Provenance & replay](#provenance--replay)
   below for the four new columns.
3. **`computePoolTvl`** (`lib/onchain/verify-pool.ts`) — the actual
   "balance → normalized amount → USD value → pool TVL" math, extracted
   into a pure, directly-testable function (see
   `lib/onchain/verify-pool.test.ts`'s deterministic worked examples).
   Previously inline inside `verifyPoolsOnChain`, functionally unchanged by
   the extraction.
4. **Pool query layer** (`lib/database/queries/pools.ts`) —
   `getVerifiedPools()`, and `getPoolTvlHistory(poolId, since)` with
   server-side date-range pushdown (never loads unbounded history), same
   convention as `getChainHistory`/`getProtocolHistory`/`getTokenHistory`.

## Canonical data model

```text
chains ──┬──< pools >──── protocols (optional)
         │      │
         │      └──< pool_tokens
         │
         └──< historical_observations >── entityType + entityId (e.g. "pool" + pools.id)
```

- **`pools`** — one row per verified AMM pool. `configKey` joins back to
  `VERIFIED_POOLS`. `chainId` and `protocolId` (nullable) are real foreign
  keys, not denormalized strings.
- **`pool_tokens`** — every token a pool contract holds a balance of.
  `decimals` is nullable and never defaulted (see
  `lib/chains/token-decimals.ts`'s own reasoning) — though in practice
  every current entry has a human-confirmed real value from the config.
- **`historical_observations`** — deliberately not pool-specific. A future
  native metric (a different AMM adapter, a native price source) writes
  into this same table with a different `entityType`/`metric` rather than
  needing a new history table. `entityType` + `entityId` is a plain pair,
  not a polymorphic foreign key (Postgres has no clean native support for
  that) — a consumer that knows `entityType === "pool"` joins back to
  `pools` itself. `blockHash`, `priceSource`, `priceRetrievedAt`, and
  `calculationInputs` are all nullable — real for every row written by the
  current `verifyAllPools()` flow, `null` for anything recorded before
  those columns existed. Nothing is ever backfilled into them.
- **No separate `contracts` table.** `pools.address` / `pool_tokens.address`
  are plain address strings. A generic contract registry (ABI storage,
  multi-purpose tracking) is a reasonable next step once there's a second
  concrete need for one beyond "an address on a specific pool/token row" —
  deliberately not built speculatively (see the project's own
  "avoid premature overengineering" instruction).

## Native TVL calculation

```text
Pool contract's own ERC-20 balanceOf() for each held token   [on-chain, native]
        × (10 ** -decimals)                                   [normalization]
        × USD price                                           [external input - CoinGecko]
        ↓
   per-token USD value
        Σ
   DeFiHub-calculated pool TVL                                 [native]
```

Only the *price* is external. The balance read, decimals normalization,
per-token valuation, and summation are all DeFiHub's own computation
(`computePoolTvl` in `lib/onchain/verify-pool.ts`) — this is the literal
distinction Phase 4 asked to preserve: "External: token USD price.
DeFiHub-native: balance, decimals normalization, USD valuation, pool TVL
calculation." A future native price source (see
[Price provider abstraction](#price-provider-abstraction) below) can
replace the CoinGecko input without touching this calculation at all.

**Why this doesn't replace a protocol's headline TVL figure.** A verified
pool's TVL is a complete, correct number *for that one pool*. It is not a
protocol's total TVL — Uniswap V3 alone has many thousands of pools, and
this app verifies a handful. Summing "the pools we happen to have verified"
and presenting it as "Uniswap V3's native TVL, replacing DefiLlama's
figure" would materially understate reality and mislabel a partial number
as a complete one — exactly what the project's "never falsely label
externally-sourced data as native, or vice versa" rule exists to prevent.
That's why there's no `getProtocolTvl()` with a native/external toggle:
the honest version of that interface only exists at the granularity where
DeFiHub's calculation genuinely *is* the whole answer, which today is one
pool, not a whole protocol. The existing `OnchainVerificationCard` already
gets this right — it shows the on-chain-verified figure as an explicit,
narrowly-scoped independent cross-check next to (not instead of) the
protocol's real DefiLlama TVL, and says so.

**The internal data interface Phase 4 asked for** is, at the granularity
where it's honest, `getPoolTvlHistory()` / `getVerifiedPools()`
(`lib/database/queries/pools.ts`): the caller asks for a pool's data and
gets back a real, provenance-tagged result (`source: "onchain-verification"`,
a `calculationVersion`, a real block number) without needing to know
anything about viem, multicall, or CoinGecko. That pattern — a typed,
provenance-carrying result object, source ambient to the query rather than
threaded through every caller — is what scales to more native metrics as
coverage grows.

## Price provider abstraction

```text
PriceProvider (lib/providers/types.ts)
 └── implemented today by CoinGeckoProvider (lib/providers/coingecko.ts)
```

Pre-existing, not new to Phase 4 — `getPrices(coingeckoIds): Promise<NormalizedPrice[]>`
is already provider-agnostic; nothing outside `lib/providers/` sees a raw
CoinGecko response shape. `computePoolTvl` takes prices as a plain
`Map<string, number>` parameter, not a CoinGecko-specific type — a future
on-chain price source (e.g., reading a DEX's own spot price or a Chainlink
feed) only needs to implement the same `PriceProvider` interface and swap
the instance constructed in `lib/providers/index.ts`; the TVL calculation
itself doesn't change. Phase 4 doesn't attempt this — price discovery
robust enough to trust over a free aggregator API is a substantially
harder problem than reading a contract's own token balance, and out of
scope for a foundation phase (see the spec's own "do not build a
decentralized oracle network").

## Provenance & replay

Every successful `verifyAllPools()` observation now carries enough to
answer "what exactly produced this number, and can it be reproduced?"
without guessing:

- **`blockHash`** — the pinned block's own hash, not just its number,
  captured via `client.getBlock({ blockNumber })` in the same
  `withResilientClient` call (and against the same provider) as the
  multicall it's paired with. A block *number* alone doesn't identify
  which chain history it belonged to if that height was later reorged onto
  a different canonical block; the hash does.
- **`priceSource`** — the concrete `PriceProvider`'s own `name` (e.g.
  `"coingecko"`), read from the provider instance itself
  (`lib/providers/types.ts`'s `PriceProvider.name`) rather than
  hardcoded — stays correct automatically if the constructed provider is
  ever swapped.
- **`priceRetrievedAt`** — one timestamp captured the moment
  `priceProvider.getPrices()` actually returns, shared by every pool in
  that run (matching `historical_observations.timestamp`'s own
  one-timestamp-per-run convention).
- **`calculationInputs`** — the exact per-token snapshot `computePoolTvl`
  used: `symbol`, `coingeckoId`, `decimals`, `balanceRaw` (the raw on-chain
  integer, as a string), and `priceUsd`. This is what makes an observation
  *replayable*: feeding these fields straight back into `computePoolTvl`
  reproduces the stored `value` exactly, not just approximately — see
  `verify-pool.test.ts`'s "replays a persisted calculation-inputs
  snapshot" test and `lib/database/queries/pools.test.ts`'s DB round-trip
  version of the same check.

**Reorg detection.** `lib/onchain/reorg.ts`'s `checkBlockHashStillCanonical`
compares a stored `blockHash` against what that same block number resolves
to right now, via an injected reader (so it's unit-testable without a live
RPC call — see `reorg.test.ts`). It returns one of three states, not a
boolean — `"confirmed"`, `"reorged"`, or `"unknown"` (a transient read
failure is never reported as a confirmed reorg). `readBlockHashOnChain` is
the real, RPC-backed reader for production use. **Not yet wired into the
verification cron or any scheduled check** — it exists as a tested,
ready-to-use primitive, consistent with this codebase's "primitives first,
one concrete example, no speculative scheduling" pattern elsewhere (e.g.
`lib/indexing/events.ts`). Actually re-checking historical observations on
a schedule is a reasonable next step, not something this change invents a
cron for.

## Historical TVL bug (audit, root cause, fix)

**Symptom reported:** 30-day and 90-day (and, per the user's report,
possibly other) historical TVL chart ranges sometimes showed
malformed/incomplete content instead of the expected chart, encountered
during manual exploration.

**Investigation.** Traced the full path (chart component → range-switch
fetch effect → API route → query function → database) across every chain,
every protocol (all 3,417), every token (all 458), and every chart range,
checking for `NaN`/`Infinity`/invalid timestamps/malformed serialization at
each layer. The query layer and API responses were completely clean in
every case checked — no data-shape bug reproduced there. Live reproduction
in a real browser (range-switching, chart tooltips, sparse/short-history
entities) also found nothing at the UI layer under normal conditions.

**Root cause, found via live reproduction under load.** `RangedAreaChart`
(`components/charts/ranged-area-chart.tsx`) fetches a new range's data on
demand (every range except the server-rendered default). If that fetch
*fails* — confirmed reproducible via the history API routes' own per-IP
rate limit (`lib/security/rate-limit.ts`), which was realistic to exhaust
through ordinary active exploration (switching ranges across a handful of
pages in one session), not just abuse — the component silently fell back
to rendering whatever range's data it already had (typically the original
default), *while the range picker still showed the newly-selected, failed
range as active*. The chart never went blank and never surfaced an error;
it kept showing a real chart, just one for the wrong period, with only a
small, easy-to-miss caption disclosing why. That mismatch — a chart
confidently displaying data that doesn't correspond to its own selected
label — is what a user encountering it during active exploration would
reasonably describe as the data looking wrong/incomplete.

**Fix** (two parts, both required):

1. **Never show mismatched data.** Extracted the display-decision logic
   into a pure, testable function (`lib/charts/chart-display-state.ts`,
   `computeChartDisplayState`). A fetch error for the *currently selected*
   range now returns `{ filtered: [], showError: true }` instead of
   falling back to different-range data. `RangedAreaChart` renders an
   explicit "Couldn't load this range. Retry." state in place of the plot
   — never a chart, real or otherwise, that doesn't correspond to what's
   selected.
2. **Reduce how often it happens at all.** The three history API routes'
   rate limit was raised from 60/min to 180/min per IP (still a real,
   meaningful cap — just one with headroom for legitimate exploration
   rather than being realistic to trip through ordinary use).

**A second, related bug found during the same audit:**
`getGlobalTvlHistory()` (`lib/database/queries/chains.ts`, backs the
homepage's global TVL chart) ran `Number(r.tvl)` unconditionally on a
`SUM(tvl)` aggregate. Postgres's `SUM()` returns SQL `NULL` (not 0) for a
day where every contributing `chain_metrics` row has a null `tvl` — and
`Number(null)` evaluates to `0` in JavaScript, silently turning "no chain
reported TVL that day" into a confident, wrong `$0` data point. Confirmed
via the schema that `chain_metrics.tvl` is genuinely nullable, so this was
a real, reachable (if not currently manifesting in live data — checked:
zero rows currently have a null `tvl`) violation of "missing data must
never become a fabricated zero." Fixed to preserve `null`; every consumer
(`computeTvlChanges`, every `RangedAreaChart` caller) already expected and
correctly handled a nullable point — `app/page.tsx` even had a
`tvl as number | null` cast anticipating this that the old implementation
made permanently unreachable.

**Regression tests:**
- `lib/charts/chart-display-state.test.ts` — the exact bug scenario (a
  fetch error for the selected range must never fall back to a different
  range's cached data), plus the surrounding pending/partial/empty-range
  cases.
- `lib/database/queries/chains.test.ts`'s `getGlobalTvlHistory` describe
  block — an all-null day returns `null` not `0`; a mixed null/real day
  sums only the real rows; a normal day is unaffected.

Both were verified to actually catch their bug (temporarily reverted the
fix, confirmed the test failed, restored it, confirmed it passed) before
being treated as done.

## Reliability & security

- **Secrets:** operator RPC URLs (which commonly embed a provider API key
  in the path) are redacted to scheme+host before ever reaching a log line
  or a thrown error (`lib/chains/rpc-resilient-client.ts`'s
  `redactRpcUrl`/`redactUrlInMessage`) — pre-existing, unchanged by Phase 4.
- **Idempotent writes:** `historical_observations` has a unique index on
  `(entityType, entityId, metric, timestamp)`; `verifyAllPools()` inserts
  with `onConflictDoNothing()`, so a retried/re-triggered run never
  double-writes the same observation.
- **Reorg safety:** every on-chain read in `verify-pool.ts` pins to
  `head - confirmationsFor(chainSlug)`, not the raw chain head, using the
  pre-existing per-chain confirmation depths in `lib/chains/confirmations.ts`.
  Each observation also persists the pinned block's hash (not just its
  number), and `lib/onchain/reorg.ts` can check whether that hash is still
  canonical after the fact — see [Provenance & replay](#provenance--replay).
- **Never-fabricated values:** a failed balance read or missing price fails
  that pool's whole computation (`computePoolTvl` returns an explicit
  error) rather than substituting zero or a guessed price; `pool_tokens.decimals`
  stays `null` rather than defaulting to 18 if it's ever unconfirmed.

## How to add another chain

1. Add the chain to `lib/config/chains.ts` / seed it into `chains` (see
   [database.md](./database.md)) — required for the app generally, not
   specific to native data.
2. Add its RPC URL to `DEFAULT_RPC_URLS` (and, if you want an operator
   override, a matching env var) in `lib/chains/rpc-client.ts`.
3. Add a confirmation depth to `CONFIRMATIONS_BY_CHAIN` in
   `lib/chains/confirmations.ts` — research the chain's actual reorg
   behavior rather than reusing the default; see that file's own comment
   for why Polygon's is so much deeper than Ethereum's.
4. Multicall3 is already assumed deployed at the standard deterministic
   address for every EVM chain (`lib/chains/rpc-client.ts`'s
   `MULTICALL3_ADDRESS`) — verify that's actually true for a genuinely new
   chain before relying on it silently.

## How to add another verified AMM pool (or a new AMM adapter)

**Adding a pool for an AMM shape already supported** (a contract whose own
ERC-20 balances are the pool's TVL — true for Uniswap V2/V3-style and
structurally similar DEXes): add an entry to `VERIFIED_POOLS` in
`lib/onchain/config.ts`. Every field needs to be human-confirmed, not
guessed — see the existing entries' comments for the standard of evidence
(pool address confirmed via `token0()`/`token1()` reads or an explorer, each
token's `coingeckoId` confirmed via CoinGecko's own per-contract lookup,
not assumed from the symbol — several existing entries document a case
where a chain-specific WETH listing has a *different* CoinGecko id than
Ethereum's). The next `syncPoolsFromConfig()` run (on every
`verifyAllPools()` call) picks it up automatically — no other code change
needed.

**A genuinely different AMM shape** (a pool whose TVL isn't simply the sum
of its own ERC-20 balances — e.g. a pool that holds LP-wrapped positions
rather than raw tokens) needs a new adapter, not a `VERIFIED_POOLS` entry:
write a new pure calculation function analogous to `computePoolTvl`, wire
it into a chain-read function analogous to `verifyPoolsOnChain`, and give
it its own `calculationVersion` tag so its observations are distinguishable
in `historical_observations` from the existing `pool-balance-sum-v1`
pools. Do not extend `computePoolTvl` itself to secretly special-case a
different accounting shape inside the same function — see
`lib/onchain/config.ts`'s own extensive Rocket Pool research note for what
happens when a shape gets force-fit into the wrong category (a
~29%-understated figure that took real investigation to catch).

## Known limitations

- Six verified pools across five chains — a proof of concept, not
  meaningful DEX coverage. See `VERIFIED_POOLS` in `lib/onchain/config.ts`
  for the current list.
- No protocol-level native TVL — see
  [Native TVL calculation](#native-tvl-calculation) above for why that
  would currently be dishonest, not just incomplete.
- Price is still entirely external (CoinGecko) — see
  [Price provider abstraction](#price-provider-abstraction).
- `historical_observations` only has real depth from the point Phase 4
  shipped forward — there's no backfill of pre-Phase-4 verified-TVL history
  (the pre-existing `onchain_verifications` table only ever stored the
  latest value, so there was nothing to backfill from).
- No UI surfaces `historical_observations` yet (no pool-TVL history chart)
  — deliberately deferred to avoid a UI change beyond what Phase 4's scope
  calls for; the query layer (`getPoolTvlHistory`) is ready for one.
- Lending/vault-style protocols (exchange-rate and debt accounting, not a
  single contract balance or a single accounting call) remain explicitly
  out of scope — see `lib/onchain/config.ts`'s own category boundary
  discussion.
- `checkBlockHashStillCanonical` (see [Provenance & replay](#provenance--replay))
  is a tested, standalone utility, not an automated check — nothing
  currently re-verifies an old observation's pinned block against the
  chain's current state on a schedule.
