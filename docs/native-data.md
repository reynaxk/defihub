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
  `calculationInputs` are all nullable *at the column level* — real for
  every row written by the current `verifyAllPools()` flow, `null` for
  anything recorded before those columns existed. Nothing is ever
  backfilled into them. `blockHash` specifically is further constrained: a
  `historical_observations_pool_tvl_requires_block_identity` CHECK
  constraint (added `NOT VALID` - see [Idempotent writes, at block granularity](#reliability--security))
  means a *new* row with `entityType: "pool"`, `metric: "tvl_usd"` can
  never have a null `blockHash` going forward, even though old rows that
  predate the column still legitimately do (grandfathered in, never
  dropped or rewritten).
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
CoinGecko response shape. The provider's own `priceUsd` is necessarily a
JS `number` (that interface doesn't change), but `verifyAllPools` converts
every price to an exact decimal string (`priceToExactDecimalString`)
immediately after fetching, before it ever reaches `computePoolTvl` -
which itself takes prices as `Map<string, string>`, not
`Map<string, number>`, so nothing downstream of that one conversion point
touches a floating-point price at all. See
[Exact-decimal precision](#exact-decimal-precision) below. Phase 4 predicted
a future on-chain price source could simply implement this same
`PriceProvider` interface and swap the instance in `lib/providers/index.ts`.
Phase 5.3's real price engine (`lib/onchain/pricing/`, see
[Native price engine (Phase 5.3)](#native-price-engine-phase-53)) does not
do that, deliberately: `PriceProvider.getPrices` returns one bare `number`
per id, with no room for per-source provenance, confidence, or a genuine
reject/aggregate decision — exactly the things that make an on-chain price
trustworthy enough to use at all. Phase 5.3 instead built its own richer
pipeline and integrates as a narrow, confidence-gated *override* into
`verifyAllPools`'s existing price map, not as a drop-in `PriceProvider`
implementation. Price discovery robust enough to trust over a free
aggregator API is still a substantially harder problem than reading a
contract's own token balance — this is a first, narrow, honestly-scoped
attempt at it, not a general solution (see the spec's own "do not build a
decentralized oracle network").

## Exact-decimal precision

`computePoolTvl`'s entire pipeline - balance normalization, price, each
token's USD value, and the running TVL total - stays exact BigInt/
fixed-point arithmetic from the first raw on-chain integer through to the
function's own return value, which is an exact decimal **string**, never a
`number`. This isn't just an internal implementation detail: a `number`
can't represent a value beyond `Number.MAX_SAFE_INTEGER` (2^53, ~9e15) and
a real fractional component (e.g. a sub-cent remainder) at the same time,
and neither a pool's TVL nor a token's price is guaranteed to stay under
that ceiling forever. Two conversions bound the whole exact region:

- **In**: `priceToExactDecimalString` (`lib/onchain/verify-pool.ts`) is the
  one place a price is still a `number` - it prefers
  `Number.prototype.toString()` over `toFixed()`, since for any "clean"
  provider price (the common case) `toString()` recovers the shortest
  decimal that round-trips to the same double, which for those values *is*
  the original clean decimal (e.g. `0.1`, not that double's true binary
  expansion, `0.100000000000000005551115...`).
- **Out**: `roundExactDecimal` rescales `computePoolTvl`'s exact string
  down to a smaller, table-specific scale (2 decimals for
  `onchain_verifications`, 8 for `historical_observations`) via BigInt
  division with explicit rounding - never `Number(...).toFixed(n)`, which
  rounds a floating-point *approximation* of the value rather than the
  value's own exact digits. This rounding is a real, intentional narrowing,
  not a formality: `computePoolTvl` itself carries 30 decimal places of
  precision internally, so a calculation can genuinely have more fractional
  digits than a storage column's declared scale can hold. "Exact" below
  means *exact within each column's own declared precision* - `numeric(32,8)`
  is a finite, 8-decimal contract, not unlimited precision.

This exactness carries all the way to storage and back: `historical_observations.value`
(`numeric(32,8)`) is returned by drizzle/postgres.js as a string by
default (confirmed - `numeric()` without an explicit `mode` infers
`string`, not `number`), and `getPoolTvlHistory` (`lib/database/queries/pools.ts`)
passes that string straight through rather than wrapping it in `Number(...)`.
`HistoricalObservationCalculationInput.priceUsd` (the provenance snapshot -
see [Provenance & replay](#provenance--replay)) is the same exact string
`computePoolTvl` itself consumed, so replaying a stored observation never
needs a lossy round-trip through `Number` in either direction - but because
the *stored* value was already rounded to 8 decimals on the way in, a
raw/unrounded replay only matches it when the original calculation happened
to need 8 or fewer fractional digits. A replay comparison must apply the
same `roundExactDecimal(..., 8)` the original write used before comparing
- see `lib/database/queries/pools.test.ts`'s "replays a value whose exact
calculation has more than 8 fractional digits" test, which checks both
halves: the raw replay reproducing the *true* exact calculation, and only
the rounded replay matching what's actually in the database.

The one place a `number` legitimately still appears is `onchain_verifications`'
own reader (`getVerificationsForProtocol`, `getVerifiedPools`) - a
2-decimal, UI-display-only value the existing `OnchainVerificationCard`
renders. That's the "clearly intentional display boundary" the exact
pipeline converts at - never earlier. See
[The Number(...) boundary, precisely](#the-number-boundary-precisely)
below for why that specific conversion is safe at this app's real TVL
magnitudes, and why "2^53" alone understates where cent-level precision
actually starts being at risk.

## The Number(...) boundary, precisely

`Number.MAX_SAFE_INTEGER` (2^53, ~9.007e15) is the boundary for exactly
representing a plain *integer* as a double - not the boundary for a
financial value that also needs to keep 2 decimal places (cents) exact. A
double has roughly 15-17 significant decimal digits of precision, total,
shared between the integer part and the fraction. Reserving 2 of those
digits for cents means the integer part can safely carry at most
~13-15 digits before cent-level information starts silently eroding -
concretely, somewhere in the *tens of trillions of dollars*, not the
quadrillions "2^53 is huge" might suggest if the 2 decimal places aren't
accounted for.

This is also not "overflow" - nothing throws, warns, or produces `Infinity`
or `NaN`. A double silently rounds a `numeric` string like
`"12345678901234.57"` to the nearest value it can actually represent during
the binary floating-point conversion `Number(...)` performs, which may
differ in the cents place with no signal that it happened. That's the real
risk `Number(...)` carries: silent precision loss on conversion, not a
loud failure.

None of this makes `onchain_verifications`' own `Number(r.tvlUsd)` calls
unsafe *for the pools this app currently verifies* - a handful of AMM
pools (see `VERIFIED_POOLS` in `lib/onchain/config.ts`) whose real TVL is
nowhere near tens of trillions of dollars. That's a fact about today's
dataset and expected operating range, not a mathematical property this
column, this function, or this codebase actually enforces - nothing here
caps what a future pool's TVL could be, and this doc doesn't claim
otherwise. It's why that conversion is confined to genuinely display-only
readers (`OnchainVerificationResult`, `VerifiedPoolListItem`) that exist
specifically to feed a UI number - the *safety* comes from that boundary
being narrow and display-only, not from an assumption that large values
can't occur - and why nothing else in this pipeline reaches for
`Number(...)` on a value that's meant to stay exact regardless of
magnitude - `historical_observations.value` never does.

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
  integer, as a string), and `priceUsd` (the same exact decimal string
  `computePoolTvl` itself consumed - see
  [Exact-decimal precision](#exact-decimal-precision) - not a `number`).
  This is what makes an observation *replayable*: feeding these fields
  straight back into `computePoolTvl` reproduces the *true* exact
  calculation - and once that replay is rounded to the same 8-decimal
  storage precision `historical_observations.value` uses (`roundExactDecimal`,
  not `Number(...).toFixed()`), it reproduces the stored `value` too. The
  raw, unrounded replay only equals the stored value directly when the
  original calculation happened to need 8 or fewer fractional digits - see
  `verify-pool.test.ts`'s "replays a persisted calculation-inputs snapshot"
  test (an 8-or-fewer-digit case) and
  `lib/database/queries/pools.test.ts`'s "replays a value whose exact
  calculation has more than 8 fractional digits" test, which checks both
  the true exact replay and the rounded-to-match-storage comparison
  explicitly.

**Reorg detection.** `lib/onchain/reorg.ts`'s `checkBlockHashStillCanonical`
compares a stored `blockHash` against what that same block number resolves
to right now, via an injected reader (so it's unit-testable without a live
RPC call — see `reorg.test.ts`). It returns one of three states, not a
boolean — `"confirmed"`, `"reorged"`, or `"unknown"` (a transient read
failure is never reported as a confirmed reorg). `readBlockHashOnChain` is
the real, RPC-backed reader for production use.

**Wired into scheduled work as of Phase 5.1, generalized to vaults in
Phase 5.2.** `workers/onchain/recheck-reorgs.ts` runs on its own cron
(`app/api/cron/recheck-reorgs`) and automatically rechecks recent
block-hash-pinned `historical_observations` rows for both pool and vault
entities, through this same `checkBlockHashStillCanonical` primitive — no
separate check for each entity type. A row confirmed reorged away from
canonical history is never deleted or rewritten; it's marked invalid via
`historicalObservations.reorgInvalidatedAt` (set by `markObservationReorged`,
`lib/database/queries/onchain-recheck.ts`), which excludes it from
canonical results (`getPoolTvlHistory`/`getVaultTvlHistory`) while leaving
every other provenance field untouched for debugging/audit. The legacy
`VERIFIED_PROTOCOL_TVLS` entries (Lido, Aave) remain outside this recheck's
coverage — they predate block-hash provenance entirely (`onchain_verifications`
has no `blockHash` column), so there's nothing for a recheck to compare
against; see `recheck-reorgs.ts`'s own module comment for that gap.

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
- **Idempotent writes, at block granularity:** identity is the block a
  native pool observation represents, not the wall-clock moment it was
  recorded - `timestamp` (`runTimestamp`) differs on every retry even for
  the exact same chain block, so a `(entityType, entityId, metric,
  timestamp)` index (this table's original dedup guard) could never
  actually catch a retried observation of the same block. Two partial
  unique indexes on `historical_observations` — `historical_observations_block_hash_identity_unique`
  (`entityType, entityId, metric, blockNumber, blockHash`, scoped to rows
  where both are known) and `historical_observations_block_only_identity_unique`
  (`entityType, entityId, metric, blockNumber`, scoped to rows with a block
  number but no hash) — together make "same pool, same block number, same
  block hash" a single observation, while "same block number, a *different*
  hash" (a reorg) stays a distinct one, explicitly null-safe for a missing
  hash rather than relying on ordinary SQL NULL semantics. `recordPoolVerification`
  (`lib/onchain/verify-pool.ts`) always targets the "hash known" index for a
  pool/tvl_usd row now (never a bare `onConflictDoNothing()`, which would
  silently absorb a conflict against any unique index on the table) -
  `historical_observations_pool_tvl_requires_block_identity` (below) means
  that's the only one such a row can ever match; the "block number only"
  index remains for a hypothetical future entityType/metric that has a
  block number but genuinely no hash to attach. See
  `lib/onchain/verify-pool.integration.test.ts`'s block-identity tests.
- **Block hash is required, not merely preferred, for pool TVL history:**
  a native pool TVL observation without a real block hash isn't reliable
  provenance - it can never be checked against a reorg later (see
  [Reorg detection](#provenance--replay) below). "Real" is checked, not
  assumed: `recordPoolVerification` validates `blockHash` against
  `VALID_BLOCK_HASH` (`/^0x[0-9a-fA-F]{64}$/` - the exact shape of a real
  32-byte EVM hash) before writing anything, and refuses to write the
  `historical_observations` row at all when the hash is missing, empty, or
  malformed (it still commits the `onchain_verifications` "latest value"
  row either way - a bad hash doesn't make the current TVL figure itself
  untrustworthy, only the durable history record of it). That skip is
  logged (`logger.warn`, `component: "onchain"`) rather than silent -
  see `lib/observability/logger.ts` - specifically so an operator can
  notice if it ever starts happening, rather than incomplete provenance
  quietly piling up unnoticed. The database enforces the same rule
  independently via the `historical_observations_pool_tvl_requires_block_identity`
  CHECK constraint on `historical_observations` (rejecting both `NULL`
  and `''`), scoped specifically to `entityType = 'pool' AND metric =
  'tvl_usd'` - not a table-wide `NOT NULL` on the column, since a
  different, future metric could legitimately have no block-level
  provenance at all. Full 64-hex-character format validation is an
  application-layer concern (`VALID_BLOCK_HASH`); the database constraint
  is deliberately coarser - never null, never empty - matching how this
  schema's other `CHECK` constraints (e.g. `users_email_lowercase`) stay
  simple rather than encoding a full format grammar in SQL. In the
  current implementation, `verifyPoolsOnChain` always fetches the block
  hash via the same `client.getBlock({ blockNumber })` call it already
  needed for reorg-safety provenance (see
  [Provenance & replay](#provenance--replay)) - there's no separate,
  duplicate RPC request for it - so a missing/invalid hash is a defensive
  case (a malformed RPC response, or a future code path) rather than one
  that occurs in ordinary operation today. There is deliberately no
  "retry the same block" mechanism: the next scheduled verification run
  (whatever block is current by then) is the retry.
  The constraint was added `NOT VALID`, not fully validated - real rows
  from before `blockHash` tracking existed are grandfathered in rather
  than rejected or backfilled; see the migration's own comment
  (`lib/database/migrations/0026_pool_tvl_requires_block_identity.sql`)
  for why validating them would be both impossible (they're genuinely
  missing data, not a defect to fix) and unnecessary (the constraint still
  fully applies to every new write).
- **Migration lock safety, honestly scoped:** this project's migration
  runner (`drizzle-kit`'s built-in `migrate()`, via `npm run db:migrate`)
  wraps every pending migration file - and every statement in it - in one
  Postgres transaction, and Postgres refuses `CREATE`/`DROP INDEX
  CONCURRENTLY` inside a transaction block. Genuinely online index/constraint
  changes aren't something this tooling can express, so neither migration
  claims to be lock-free: `0025_pool_observation_block_identity.sql`'s two
  `CREATE UNIQUE INDEX` statements (both now `IF NOT EXISTS`) hold a `SHARE`
  lock - blocking concurrent writes, not reads - for as long as each index
  build takes, and `0026`'s `ADD CONSTRAINT ... CHECK (...) NOT VALID` takes
  only a brief metadata lock (no table scan, since it's deliberately not
  validated - see above). For a small/dev table this is a non-issue,
  confirmed at implementation time by running both migrations against a
  database that already had real `historical_observations` rows. For a
  production database where that table has grown large enough for a
  write-blocking window to matter, `0025` ships an actual companion deploy
  step, not just a comment to copy SQL from -
  `npm run db:migrate:0025-concurrent-indexes`
  (`lib/database/migrations/scripts/0025-create-block-identity-indexes-concurrently.ts`)
  runs the equivalent `CREATE`/`DROP INDEX CONCURRENTLY` statements as
  plain top-level (non-transactional) calls, since that's the only way
  Postgres allows `CONCURRENTLY` at all. Run before `npm run db:migrate`;
  every statement on both sides is `IF [NOT] EXISTS`, so running the
  concurrent script first is always safe (including against a database
  that already applied 0025 the normal way, or a small/dev database where
  it isn't needed) - whichever path runs first leaves nothing for the
  other to do. This is the safest strategy actually available within this
  project's migration setup, genuinely integrated into how the project
  deploys - not a claim of true zero-downtime, since running the script is
  still a real, separate step a deploy has to take before `db:migrate`.
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

## How to add another verified ERC-4626 vault

ERC-4626 (`VERIFIED_VAULTS` in `lib/onchain/config.ts`, `lib/onchain/verify-vault.ts`,
Phase 5.2) is a third, genuinely reusable category — a standardized
interface (`asset()`, `totalAssets()`) every compliant vault implements
identically, unlike `VERIFIED_PROTOCOL_TVLS`' "direct" entries below (each
hand-written against that specific protocol's own function names). Adding
another compliant vault is a config entry, not new code: append to
`VERIFIED_VAULTS` with the same standard of evidence as a pool entry (the
vault address AND its `asset()` result both independently confirmed, e.g.
via a block explorer tagging the contract "ERC-4626" and cross-checking the
underlying address against the constructor arguments — see the existing
sDAI/sUSDe entries' comments). `syncVaultsFromConfig()` (called from every
`verifyAllVaults()` run) picks it up automatically. TVL calculation reuses
`computePoolTvl` unmodified (the N=1 case of "sum of balance × price across
the tokens this contract holds") — do not write new arithmetic for a vault
entry; if a vault's real accounting isn't "one direct `totalAssets()`
call" (e.g. a vault that itself holds LP-wrapped positions rather than a
single underlying asset), that's a genuinely different shape needing its
own adapter, the same reasoning as the AMM section above.

## Native price engine (Phase 5.3)

Everything above (Phase 4 – 5.2) computes a native *balance* (a pool's own
token holdings, a vault's `totalAssets()`) but still converts it to USD via
CoinGecko — see [Price provider abstraction](#price-provider-abstraction)'s
own "Phase 4 doesn't attempt this" note. Phase 5.3 is the first attempt at
the other half: a small, honest, on-chain-derived USD price for a hand-
curated set of *reference assets*, under `lib/onchain/pricing/`.

```text
lib/onchain/pricing/
 ├── types.ts              PriceSourceKind, PriceConfidence, PriceLabel, CandidatePriceSource
 ├── config.ts              REFERENCE_ASSETS - the hand-curated dependency graph (see below)
 ├── reference-graph.ts     resolveReferenceOrder - topological sort + cycle detection
 ├── uniswap-v2.ts          deriveV2Price - the one real, reusable AMM adapter
 ├── aggregate.ts           staleness/outlier rejection, liquidity-weighted blend, confidence
 ├── engine.ts              priceReferenceAssetsOnChain / resolveReferenceAssetOutcome
 ├── tokens.ts              syncReferenceAssetTokens - keeps `tokens` rows in sync with config
 ├── record-price-observation.ts   the atomic write (historical_observations only - see below)
 ├── price-reference-assets.ts     priceAllReferenceAssets - the top-level entry point
 ├── queries.ts             getNativeTokenPrice - latest still-canonical price for a token
 └── tvl-integration.ts     the controlled TVL source-selection policy (see below)
```

### Why an on-chain reserve ratio needs a reference asset at all

A Uniswap V2 pool's `getReserves()` gives an exact ratio — N units of token1
per unit of token0 — never a USD value on its own. Converting that ratio to
a USD price needs one further USD price for whichever side is being treated
as the reference. That, in turn, needs its own reference, and so on — an
on-chain reserve ratio alone can never bootstrap an absolute dollar value
from nothing. Every real on-chain pricing system resolves this the same
way: designate one asset's USD value by definition (an *anchor*), then
derive everything else from real pools priced against it or against an
already-derived asset. `REFERENCE_ASSETS` in `config.ts` does exactly this,
Ethereum-only, for five assets:

```text
usdc-ethereum (anchor, $1.00 by definition)
 ├── weth-ethereum   (from the real, already-verified USDC/WETH V2 pool)
 │    └── wbtc-ethereum   (from the real WBTC/WETH V2 pool - a genuine two-level chain)
 ├── usdt-ethereum   (from the real USDC/USDT V2 pool - NOT assumed $1.00)
 └── dai-ethereum    (from the real DAI/USDC V2 pool - NOT assumed $1.00)
```

Every pool address above was independently verified two ways before being
added: (1) called the real Uniswap V2 Factory's `getPair()` live on-chain to
confirm the address, and (2) called `token0()`/`token1()` on the resulting
pair to confirm which token is which (see each entry's own comment in
`config.ts` for the exact addresses and reserve figures observed at
verification time). USDC being the anchor is a **definitional choice, not a
claim that its peg was independently verified on-chain** — this is stated
plainly rather than glossed over; see
[Known limitations](#known-limitations) below. USDT and DAI, by contrast,
get a genuinely on-chain-derived price: their real pool's current reserve
ratio against USDC, not an assumed 1:1 peg — at verification time both
showed a small, real deviation from exactly $1.00, which is retained, not
rounded away.

`reference-graph.ts`'s `resolveReferenceOrder` turns this into an explicit,
tested topological order (Kahn's algorithm) and throws if the graph is ever
made circular — see `reference-graph.test.ts`'s dedicated cycle-detection
cases. `engine.ts`'s `priceReferenceAssetsOnChain` then prices every
reference asset on one chain in exactly the same batched, block-pinned way
`verifyPoolsOnChain`/`verifyVaultsOnChain` already do (see
[Native TVL calculation](#native-tvl-calculation) above): one multicall
covering every configured pool's `getReserves()`/`token0()`/`token1()`, one
`getBlockNumber()` fetched first and pinned to a confirmation-adjusted
height, all inside one `withResilientClient` call. Every reference asset on
a given chain is therefore priced from the exact same block.

### Multiple sources, aggregation, and confidence

If a token had more than one configured source pool, `aggregate.ts`'s
`aggregatePrices` would (1) reject any source older than
`PRICING_THRESHOLDS.MAX_SOURCE_AGE_MS`, (2) reject any surviving source
whose price deviates more than `MAX_DEVIATION_FROM_MEDIAN_BPS` from the
cross-source median as an outlier, then (3) compute a liquidity-weighted
mean of what's left — never a naive average, so one shallow pool can't
count as much as a much deeper one. Every source considered, included or
rejected, is retained with its own reason in the observation's
`calculation_inputs` (a `PriceSourceObservation[]`, `schema.ts`) — the
answer to "why does DeFiHub think this token is worth $X" is always
reconstructable from that one column. Today's real `REFERENCE_ASSETS`
config has exactly one source pool per derived asset, so this multi-source
path is real and tested (`aggregate.test.ts`) but not yet exercised in
production — adding a second independently-verified pool for an existing
asset is a config-only change, the same "config entry, not new code"
pattern as adding a pool/vault.

`classifyConfidence` (also `aggregate.ts`) is a fixed, deterministic
decision tree — never a model — over included-source count, total
liquidity, and cross-source agreement: `HIGH` requires 2+ comfortably-liquid
sources agreeing within `HIGH_CONFIDENCE_AGREEMENT_BPS`; `MEDIUM` covers a
single comfortably-liquid source (real and usable, but not independently
corroborated) or multiple sources that disagree more than that; `LOW` is
insufficient total liquidity; `INVALID` is zero surviving sources. The
anchor (`usdc-ethereum`) is hand-classified `MEDIUM` — trustworthy by
design, but explicitly never `HIGH`, since `HIGH` means "independently
corroborated by multiple on-chain sources this run" and an anchor's price
isn't corroborated by anything, it's declared. Every one of today's real
derived assets (single-source) tops out at `MEDIUM` for the same reason —
by design, not as a bug: `HIGH` is reserved for genuine multi-source
agreement.

### Provenance: extending `historical_observations`, not a new table

Per this doc's own [Provenance & replay](#provenance--replay) precedent —
prefer extending the existing generic observation table over adding a new
one — a native token price is `historical_observations` with `entityType:
"token"` (`entityId` → `tokens.id`), `metric: "price_usd"`. Two new nullable
columns were added (`confidence`, `price_label`, migration
`0030_token_price_confidence_and_label.sql`) because "is this price good
enough to use for X" needs to be a plain, indexed `WHERE`-filterable column,
not something unpacked from JSON every time — the same reasoning `blockHash`
itself is a real column rather than being left inside `calculationInputs`.
A third `NOT VALID` CHECK constraint (migration
`0029_token_price_observation_provenance.sql`) requires real block identity
for every `(entityType: "token", metric: "price_usd")` row, the same rule
already enforced for pool/vault `tvl_usd` rows, added the same low-cost way
(see [Reliability & security](#reliability--security) below).

Unlike pools/vaults, a price observation deliberately does **not** also
upsert into `onchain_verifications` — that table's `tvl_usd`/`poolAddress`
columns are TVL-shaped, and there's no honest analog for "the latest price
of a token." `getNativeTokenPrice` (`queries.ts`) reads the latest
still-canonical `historical_observations` row directly instead, using the
same `historical_observations_entity_idx` index every other "give me the
latest observation" query in this app already relies on. See
`record-price-observation.ts`'s own module comment for the full reasoning.

### Reorg safety

`workers/onchain/recheck-reorgs.ts` (Phase 5.1, generalized to vaults in
Phase 5.2) was generalized a third time for token price observations, the
exact same way: `RecheckEntityType` gained `"token"`,
`getVerifiedTokenPriceEntities()` (`lib/database/queries/onchain-recheck.ts`)
joins `historical_observations` → `tokens` → `chains` to find every token
this engine has actually priced, and `getObservationsNeedingRecheck` now
takes an explicit `metric` parameter (`"price_usd"` for tokens, `"tvl_usd"`
for pools/vaults) rather than hardcoding one. No new job, no new lock, no
new cron — the same `indexingState` checkpoints, the same advisory lock,
the same `reorgInvalidatedAt` mechanics. A reorged price observation is
marked invalidated, never deleted or overwritten, and `getNativeTokenPrice`
excludes it from canonical results the same way `getPoolTvlHistory`/
`getVaultTvlHistory` already do.

### TVL integration: a controlled, confidence-gated override — not a replacement

`lib/onchain/pricing/tvl-integration.ts`'s `resolveNativePriceOverrides` is
wired into `verifyAllPools` (`verify-pool.ts`) only, right after CoinGecko's
own prices are fetched: for any of a pool's own tokens whose `coingeckoId`
matches a configured reference asset *and* has a `HIGH`/`MEDIUM`-confidence
native price on record, that price silently overrides the CoinGecko one in
the same `priceById` map `computePoolTvl` already consumes — `computePoolTvl`
itself is completely unmodified. `LOW`/`INVALID`-confidence native prices
are never used for this. The whole lookup is wrapped in its own try/catch:
a failure here degrades to the CoinGecko price this pipeline already
trusted before Phase 5.3 existed, never aborts a verification run that
would otherwise have succeeded. Every pool's `historical_observations.priceSource`
is tagged accordingly — `"onchain-pricing-engine"` if every token used a
native override, the external provider's own name unchanged if none did, or
`"hybrid:onchain-pricing-engine+coingecko"` if it's a genuine mix (see
`PriceLabel`'s own comment on why a mix must never be mislabeled as either
pure kind) — so the resulting TVL figure's provenance is always honest about
what actually priced it. **Not** wired into `verifyAllVaults`: of the two
configured vaults, only sDAI's underlying (DAI) is a configured reference
asset, and the risk/benefit of touching the vault path for one partial case
didn't clear the bar this round — a mechanical next step, not a gap hidden
here.

### What this is not

Not a decentralized oracle network, not TWAP-based (spot reserve ratio at
one pinned block, the same "this app's own live read" model pools/vaults
already use), not multi-chain yet (Ethereum only — the graph/engine
architecture is chain-agnostic, but every real `REFERENCE_ASSETS` entry
needs its own independently-verified pool address before a second chain is
added, the same standard of evidence every existing entry in this file
already requires), and not wired into every price the app shows — only the
five reference assets above, only where `verifyAllPools` already runs, only
above the `MEDIUM` confidence bar. See
[Known limitations](#known-limitations) below for the complete, honest
accounting.

## Native volume/fee/revenue engine (Phase 5.4)

Phase 5.3 answered "what is this pool worth" from DeFiHub's own on-chain
reads. Phase 5.4 answers a genuinely different question - "how much trading
actually happened here, and what did it cost/earn" - from the same
discipline: decode real `Swap` events, compute USD values from Phase 5.3's
own already-verified prices, and never claim a number this app didn't
actually derive from the chain.

### Coverage: exactly one adapter, one pool, on purpose

`lib/onchain/volume/config.ts`'s `VOLUME_SOURCE_POOLS` has exactly one real
entry: the same Uniswap V2 USDC/WETH pool already verified in
`VERIFIED_POOLS` and already reused as a price source in `REFERENCE_ASSETS`
(the pool address is confirmed identical across all three config files, not
re-derived). One adapter (`lib/onchain/volume/uniswap-v2.ts`), one protocol
shape, reused rather than generalized prematurely - see this task's own
priority order (a reusable event-indexing *foundation* first, breadth
later).

### Volume: input-side-only, never double-counted

`computeSwapVolumeUsd` (`uniswap-v2.ts`) prices the USD value of a swap's
INPUT side(s) only - never `token0 USD + token1 USD`, which would count the
same economic trade twice. Live sampling during development (100 real
blocks, 24 real swaps) found zero dual-input swaps - the rare dual-input
case (both `amount0In`/`amount1In` nonzero in one event) is still handled by
summing both input sides once each, not treated as two separate trades.

### Fees vs. revenue: two different numbers, on purpose

`computeSwapFeeUsd` applies the pool's own **verified** fee (30 bps for a
genuine, factory-deployed Uniswap V2 pair - trusted because the pair's own
`factory()` call was confirmed to match the real Uniswap V2 Factory address,
never a hardcoded global assumption for every V2-shaped pool). This is the
**LP trading fee** - what liquidity providers earn - not protocol revenue.

Protocol revenue (`lib/onchain/volume/protocol-fee.ts`) is a different,
harder question: Uniswap V2's protocol-fee switch (`factory.feeTo()`) only
mints new LP shares to a fee recipient at the next `Mint`/`Burn` call,
proportional to `sqrt(k)` growth since the last liquidity event - not a
simple percentage of volume. This phase reads `feeTo()` live and reports
exactly two honest outcomes: `feeTo() == 0x0` → revenue is **verifiably,
exactly zero** (a direct on-chain fact); `feeTo() != 0x0` → revenue is
**unavailable**, with the reason stated, because computing the realized
amount requires tracking every `Mint`/`Burn` event plus the pool's `kLast`
state - not implemented this phase. Live-verified fact: this phase's one
configured pool has an **active** fee switch, so its revenue is reported as
unavailable, not fabricated as `volume × some fraction`.

### Raw events vs. aggregate observations - two tables, two purposes

`swap_events` (new table) stores one row per real on-chain `Swap` event -
raw amounts, block/tx identity, **zero USD or price data** - so the raw
truth survives a pricing failure untouched (Section 22's "preserve raw
amounts" applies at the row level). Idempotency key: unique on `(poolId,
transactionHash, logIndex)`. Aggregate `volume_usd`/`fees_usd`/`revenue_usd`
figures reuse `historical_observations` (entityType `"pool"`, same table
`tvl_usd` already uses) - one row per indexing run per metric, pinned to the
block/hash of the last swap actually observed that run (not the scanned
range's technical upper bound), with a new `VolumeCalculationInput` shape in
`calculation_inputs` (from-block/to-block, swap counts, priced vs. unpriced
counts, both tokens' price and source). A run where every swap primes
cleanly is `HIGH` confidence; a run where none did is `LOW`; mixed is
`MEDIUM` - reusing `historical_observations.confidence` for this metric
family (see `classifyVolumeConfidence`, `aggregate.ts`) rather than
inventing a parallel column.

### Event indexing: the existing foundation, extended

`workers/onchain/volume.ts` calls the exact same `scanFromCursor` primitive
`lib/indexing/events.ts` already provided (Phase 5's own foundation-only
scope) - same checkpoint-based resumability, same confirmation-depth safety.
Two real-world constraints discovered live against this app's default
free-tier RPC (`ethereum-rpc.publicnode.com`), both handled explicitly
rather than papered over:

- **Per-call range size**: `eth_getLogs` calls succeed up to roughly 90-94
  blocks and fail above that - well below `lib/indexing/events.ts`'s own
  2000-block default. The volume indexer passes its own explicit,
  conservative `chunkSize` (50) rather than relying on that default.
- **Depth from the current chain head**: separately, and more surprisingly,
  this provider's free tier does not serve `eth_getLogs` for *any* block
  more than roughly 100-110 blocks behind the current chain head at all -
  confirmed by testing single-block ranges at increasing depth. This means
  a fixed, config-time `startBlock` becomes unreachable through this
  provider within about 20 minutes of being chosen. `effectiveStartBlock`
  (`engine.ts`) fixes this: the first-ever scan for a pool starts from
  whichever is more recent of the configured `startBlock` and "current head
  minus a safe lookback window" - never further back than the provider can
  actually serve, regardless of how stale the config value has become.
  Once a real cursor exists this has no effect; a pool that has already
  begun indexing just keeps advancing from its own position.

### Idempotency and reorg safety

Every write in this module is `onConflictDoNothing` against a deterministic
identity - `(poolId, transactionHash, logIndex)` for raw events, the same
`(entityType, entityId, metric, blockNumber, blockHash)` partial unique
index every other `historical_observations` writer already uses for
aggregates - so a re-scanned range (a retried run, a restarted worker) never
double-counts. `lib/onchain/volume/reorg.ts` is a **separate, dedicated**
recheck path, not a fourth generalization of
`workers/onchain/recheck-reorgs.ts`'s existing pool/vault/token machinery -
see that file's own header comment for the specific reason: the existing
job's cursor key doesn't include `metric`, which is safe today (one metric
per entity type) but would silently collide two independent cursors
(`tvl_usd` and `volume_usd` for the same pool) if reused as-is. Rather than
changing a shared, already-shipped function's cursor semantics, this module
reuses only the true leaf primitives
(`checkBlockHashStillCanonical`/`readBlockHashOnChain`,
`getObservationsNeedingRecheck`/`markObservationReorged`) under its own
metric-inclusive component-key namespace.

**Known gap, stated rather than hidden**: a reorg landing in the *middle* of
an already-aggregated block range (not touching that range's own last
block) does not automatically trigger recomputation of that aggregate
observation this phase - only the pinned block/hash itself is rechecked.
The underlying raw `swap_events` for that range ARE independently rechecked
and marked if reorged, so the discrepancy is detectable by comparing raw
events against the aggregate figure, just not auto-repaired yet.

### What this is not

Not volume/fees/revenue for any protocol beyond one Uniswap V2 pool, not
Uniswap V3 (the existing V3 verified pool has no volume adapter this phase -
V2 was finished completely first, per this task's own priority order,
rather than shipping two partial adapters), not a public coverage page (the
coverage registry - `lib/onchain/coverage.ts` - is backend-only, a
foundation for one, per this task's own explicit scope), and not a
historical backfill (indexing starts from a recent block, the same
"foundation, not a shipped indexer" boundary Phase 4/5.1's own event
primitives already established).

## Indexer reliability & historical catch-up (Phase 5.5)

Phase 5.4's own final report flagged a real, live-encountered operational
gap: once an indexing cursor falls behind a free-tier RPC provider's
servable window, nothing brought it back. Phase 5.5 closes that gap -
without adding a second indexing system, a database migration, or touching
Phase 5.4's own correctness guarantees (idempotency, reorg safety,
provenance all carry over unchanged, applied at a finer grain).

### The core change: `scanFromCursor` now processes chunk-by-chunk

Before Phase 5.5, `scanFromCursor` (`lib/indexing/events.ts`) fetched
*every* chunk in a scan's range, combined all their logs into one array,
and only then called `onLogs` once and advanced the cursor once, for the
whole range. That's safe (a failure meant nothing was processed and the
cursor never moved) but had no partial credit: a large gap that kept
failing partway through had to be re-fetched from its own original start on
every retry, forever.

`scanFromCursor` now calls `onLogs(logs, chunk)` once **per chunk**, and
persists the checkpoint immediately after each chunk succeeds - not
batched until the end. A crash, an RPC outage, or a process restart
partway through a long catch-up preserves every chunk already completed;
the next invocation resumes at the next unprocessed chunk, never redoing
finished work and never skipping unprocessed blocks. This is genuinely the
same reason `lib/onchain/volume/engine.ts`'s aggregate observations are now
written **per chunk** rather than once per run - each one's own
`calculationInputs.fromBlock`/`toBlock` reflects exactly the range it
covers, never the whole run's, which stays accurate even when a run spans
many chunks.

### Adaptive range shrinking

A brand-new `"range-limit"` RPC-failure category
(`lib/chains/rpc-errors.ts`) distinguishes "the provider rejected this
specific request because the block range was too wide" from a genuinely
permanent failure (bad method, bad config) - detected via best-effort text
matching against several real providers' known phrasings (Alchemy, Infura,
QuickNode, publicnode), not one provider's exact wording hardcoded as a
universal rule. When `scanFromCursor` sees this classification, it halves
the chunk size and retries the *same* starting block - never skips it -
down to a configurable minimum (default 10 blocks). If even the minimum
still range-limits, the run stops cleanly: `outcome: "partial"` if earlier
chunks in the same call already succeeded, or a thrown error if nothing did
at all (see "Partial run semantics" below) - never a silently skipped
range, never a fabricated success.

### Centralized safe-head calculation

`currentBlock - confirmationsFor(chainSlug)`, clamped at zero, used to live
in two places (`scanFromCursor`'s own inline formula, and
`lib/onchain/volume/engine.ts`'s `effectiveStartBlock`) - now lives once, in
`lib/chains/confirmations.ts`'s `safeHeadFor`, and both call it.

### Bounded retry budget

`maxChunkAttempts` (default 100) bounds the total number of distinct
chunk-fetch attempts one `scanFromCursor` call will make - covering both a
long, healthy multi-chunk catch-up and a stubborn range-limit shrink
sequence. This is a *separate*, coarser budget from `withResilientClient`'s
own per-request retry/backoff (unchanged, still handles transient/timeout/
rate-limit failures within one HTTP call) - not a second copy of the same
retry logic, a different layer bounding a different thing. When exhausted,
the run stops with `outcome: "partial"` and `stoppedReason:
"attempt-budget-exhausted"`, preserving everything already completed;
the next cron invocation continues from there.

### Partial run semantics

Every pool-level result (`PoolVolumeRunResult`, `lib/onchain/volume/engine.ts`)
now reports one of three outcomes:

- **success** - every chunk needed to reach the safe head completed.
- **partial** - real, checkpointed progress happened, but the run stopped
  short (a range-limit at the minimum chunk size, or the attempt budget was
  exhausted). Never silently reported as complete - `chunksCompleted`,
  `lag`, `safeHead`, and `cursorAfterRun` make the exact, real extent of
  progress explicit.
- **failed** - `ok: false`; either nothing succeeded at all, or `onLogs`
  itself threw (a decoding/persistence bug, not a recoverable RPC
  condition) - the cursor still reflects whatever DID complete before the
  throw, since each chunk's checkpoint was already durably persisted before
  the next chunk was even attempted.

`workers/onchain/volume.ts`'s own run-level `summarizeVolumeResults`
mirrors this at the multi-pool level: one broken pool reports the whole
*run* as `"partial"` (not `"failed"`) as long as at least one pool made
real progress - Section 30/31's multi-pool/multi-chain isolation, verified
directly in `lib/onchain/volume/engine.integration.test.ts`.

### Reorg safety and idempotency during catch-up

Unchanged from Phase 5.4, applied at the new finer (per-chunk) grain: every
raw `swap_events` write and every aggregate `historical_observations` write
is still `onConflictDoNothing` against the same deterministic identities, so
a chunk that gets re-fetched after a crash (its own writes already
committed, only its checkpoint not yet advanced) never double-counts on
retry. `lib/onchain/volume/reorg.ts`'s dedicated recheck path (`checkBlockHashStillCanonical`, unmodified) needed no changes at all - it
already operates on whatever rows exist in `swap_events`/
`historical_observations`, regardless of how many chunks produced them.

### Concurrency: one advisory lock per indexing pass

`workers/onchain/volume.ts` now holds a session-scoped Postgres advisory
lock (`VOLUME_INDEX_ADVISORY_LOCK_KEY`, distinct from every other lock key
already in use in this app) for the whole indexing pass, not just a single
chunk - a catch-up run can now legitimately take much longer than before,
raising the odds of a cron invocation overlapping the previous one. A
second, independent layer of protection already existed and still applies
even if this lock were somehow bypassed: `updateIndexingState`'s atomic
`GREATEST(existing, new)` upsert (`lib/indexing/state.ts`, unchanged),
which guarantees a stale worker's lower cursor value can never overwrite an
already-advanced one - verified directly in `lib/indexing/state.test.ts`'s
new regression test for exactly this race (Invariant 3).

### Manual recovery (operator-only, never public)

Even with adaptive shrinking, a cursor can still get stuck if the *oldest*
unprocessed block itself sits outside the provider's currently-servable
depth-from-head window - shrinking the range width doesn't help when the
range's own starting point is the problem (this happened live during this
phase's own development - see "What this doesn't fix" below).
`lib/indexing/manual-recovery.ts`'s `manuallyAdvanceCursor`, invoked via
`npm run recover:volume-cursor -- <poolKey> <toBlock> "<reason>"`, is the
one sanctioned way to unstick it: it requires a non-empty reason, refuses
to move the cursor backward, and records exactly which blocks were skipped
directly into `indexing_state.error` - never a silent jump. Never wired to
any cron schedule or API route - CLI-only, requiring the same
`DATABASE_URL` access every other worker script already needs, not exposed
to any public surface.

### What this doesn't fix

Adaptive shrinking recovers from "the range is too WIDE"; it does not (and
per Section 13/14's own "never jump directly to the newest block" rule,
must not) recover from "the range's own STARTING block is too far behind
the current head for this provider to serve at any width." This is a real,
externally-imposed constraint of relying on one free-tier RPC provider with
no paid archive access, not a bug in the catch-up logic - confirmed live
during this phase's own development, where a cursor left idle for roughly
an hour of wall-clock time fell far enough behind that even a 10-block
request at its own starting point was rejected. `manuallyAdvanceCursor`
above is the intentional, human-in-the-loop answer for exactly this case;
there is no fully-automated recovery from it with a single free RPC
provider and no configured fallback.

## Native Uniswap V3 volume/fees (Phase 5.6)

Phase 5.4 built native volume/fees for Uniswap V2. Phase 5.6 extends that
to Uniswap V3 - not by copying V2's logic and renaming it, but by
correctly handling V3's genuinely different event shape and accounting,
then reusing everything that turns out to be legitimately protocol-neutral
once that difference is normalized away.

### TVL was already solved - nothing new needed

Before writing any V3-specific code, this phase's own audit found that
native V3 TVL has existed since Phase 4/5: `VERIFIED_POOLS`
(`lib/onchain/config.ts`) already lists three real V3 pools (Ethereum,
Arbitrum, Optimism), verified via the SAME direct ERC-20
`balanceOf(poolAddress)` mechanism used for V2 pairs. That mechanism is
not an approximation for V3 - a V3 pool contract holds every LP position's
locked tokens directly in its own balance, across every tick range, in or
out of the currently active price - so summing those balances × native
price already IS the correct, complete total value locked, not a
narrower "active liquidity only" figure. No liquidity-math, tick
accounting, or position tracking was built or needed for TVL.

### Volume and fees - the genuinely new work

V3's `Swap` event
(`Swap(sender, recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)`)
is structurally different from V2's - a single SIGNED amount0/amount1
pair instead of four separate unsigned In/Out fields, plus three fields
V2 doesn't have at all. `decodeV3SwapLog`
(`lib/onchain/volume/uniswap-v3.ts`) normalizes the signed pair into the
identical `amount0In/amount1In/amount0Out/amount1Out` shape V2's own
decoder produces (positive amount → the "In" field; negative → the "Out"
field, negated back to a positive magnitude) - a lossless, exact
re-expression of the same underlying fact V2's event already carries
directly, confirmed against a real, live-captured Swap event and
cross-validated by hand (a 290.968404 USDC-in-for-0.1176 WETH-out swap
implying ~$2473.6/WETH, consistent with real market conditions at
capture time).

That normalization is what lets `lib/onchain/volume/math.ts`'s
`computeSwapVolumeUsd`/`computeSwapFeeUsd` (extracted from uniswap-v2.ts
this phase, once a second protocol needed the identical calculation) apply
completely unchanged to both protocols - not a shortcut, a genuine
structural equivalence once each protocol's own event shape is decoded
correctly. Volume convention is identical to V2's: the USD value of the
swap's input side(s), never both sides summed.

### Fee tier - read from the pool, never assumed

V3 pools are NOT all 0.30% like V2. Each pool's fee tier is immutable
(baked in at deployment, native unit: hundredths-of-a-bip, denominator
1,000,000) and verified live via that specific pool's own `fee()` call -
never a global constant. `VolumeSourcePool.feeBps` stores this converted
into the shared bps-out-of-10,000 unit (`raw / 100` - exact for every
standard V3 tier), with the untouched raw value kept alongside
(`v3FeeTierRaw`) purely for traceability. The one configured pool
(`uniswap-v3-eth-usdc-weth-005`) is verified at 0.05% (raw 500 → 5 bps) -
confirmed correct live: a real indexed run computed `feesUsd =
80.24907710` against `volumeUsd = 160498.15420372`, exactly `0.05%` of it.

### Revenue - genuinely different mechanism from V2, same honest outcome

V3's protocol-fee switch is `slot0().feeProtocol`, a packed uint8 (not a
factory-level address toggle like V2's `feeTo()`) - read directly from the
pool contract, not a factory. `feeProtocol == 0` means verifiably zero
protocol revenue (the same "direct on-chain fact" V2's zero address
represents); any nonzero value means the mechanism is active, but the
REALIZED amount requires tracking every `Swap`'s fee-growth contribution
plus every `collectProtocol()` call - a different and larger scope than
this phase implements, so (matching V2's own precedent exactly) revenue is
reported unavailable, never guessed. Live-verified fact for this phase's
one configured V3 pool: `feeProtocol == 68` (both token0 and token1 have
an active 1/4 protocol cut) - revenue is therefore unavailable for it
specifically, the same situation as the V2 pool.

**PR #14 follow-up fix**: the initial implementation determined the
active/inactive classification for an indexed range by reading
`slot0().feeProtocol` at only the range's two boundaries and trusting "both
boundaries agree" as proof the state was constant throughout. That is false
whenever `feeProtocol` changes twice within the range and lands back on its
starting value (e.g. inactive → active → inactive) - both boundary reads
agree "inactive," so the range was wrongly reported verified-zero even
though a real active window existed in between. Fixed by reconstructing
every `feeProtocol` transition that actually happened inside the range from
the pool's own real `SetFeeProtocol` events (the canonical Uniswap V3 core
event a factory-owner's `setFeeProtocol()` call emits), splitting the range
into segments at those transitions, and classifying the whole range as
verified-zero only if **every** reconstructed segment was inactive - a
single active segment anywhere in the range, even one bounded by two
inactive readings, now correctly marks the whole range's revenue
unavailable instead of fabricating zero. Reuses the existing
`scanBlockRange` primitive (no second historical scanner); cross-checks the
event-reconstructed state against an independent `slot0()` read so an
incomplete event scan or a reorg between reads can never silently produce a
wrong classification. See `lib/onchain/volume/protocol-fee.ts`'s own
"Historical-transition bug fix" module comment and
`protocol-fee.test.ts`'s two `REGRESSION` tests for the full detail.

### What this phase deliberately did NOT build

No tick indexing, no Mint/Burn/Collect event indexing, no position
accounting, no liquidity-range math. None of Sections 8/10/11/12's
concentrated-liquidity accounting was needed because this app's own TVL
methodology (direct balance reads) never required it in the first place -
building it anyway would have been unused complexity, not correctness.
If a FUTURE phase ever needs true active-in-range liquidity (as opposed to
total balance-based TVL) or realized protocol revenue, that work starts
from zero here, not from a partially-built foundation.

### Reorg safety, idempotency, chunked indexing - fully reused, zero changes

V3 rows share the exact same `swap_events` table as V2 (three new
NULLABLE columns - `sqrt_price_x96`, `liquidity`, `tick` - populated only
for V3 rows), the same `(poolId, transactionHash, logIndex, blockHash)`
reorg-safe identity, the same `lib/onchain/volume/reorg.ts` recheck path,
and the same `scanFromCursor` chunked-catch-up engine from Phase 5.5 -
none of these needed a single V3-specific change. Verified live: the
reorg-recheck worker checked both pools' events and observations together
in one run with zero code awareness of which was which.

## Native protocol coverage expansion (Phase 5.7)

Phase 5.4/5.5 built the native volume/fee/revenue engine and proved it once,
against exactly one pool (Uniswap V2 USDC/WETH on Ethereum). Phase 5.6 (a
separately-developed branch at the time this phase was written, since merged
alongside it - see the section above) adds native Uniswap V3 support; this
phase's own work did not depend on it and was built and verified
independently. This phase asks a different question: **given the
already-merged primitives, what's the next real, correctly-computed piece of
coverage to add** - not the largest number of protocols, one genuinely
verified expansion.

### Audit and candidate matrix

Every entry already in `VERIFIED_POOLS`/`VERIFIED_PROTOCOL_TVLS`
(`lib/onchain/config.ts`) that wasn't already covered by native volume/fees
was evaluated as a candidate:

| Candidate | On-chain shape | Verdict |
| --- | --- | --- |
| **PancakeSwap V2** (`pancakeswap-amm-bsc-usdt-wbnb`, BNB Chain) | Byte-for-byte Uniswap V2 fork | **Selected** - see below |
| **Aerodrome V1** (`aerodrome-v1-base-usdc-weth`, Base) | Solidly/Velodrome-fork AMM, V2-compatible `getReserves()` | **Audited and rejected this round** - see below |
| Lido (`lido-eth-steth`) | Single-sided ETH deposit (`Submitted` events), no token0/token1 pair | Not attempted - a fundamentally different accounting shape than the swap-pair model `swap_events`/`VOLUME_SOURCE_POOLS` is built around; would need its own table and adapter, not a config addition |
| Aave V3 (`aave-v3-eth-ausdc`) | Supply/Withdraw/Borrow/Repay, interest accrual | Not attempted - "volume" isn't a coherent concept for a lending market, and this task's own revenue caution (interest accrual, reserve factor) makes lending revenue especially risky; matches the existing lending-boundary discussion in [Known limitations](#known-limitations) |
| sDAI/sUSDe (`sdai-ethereum`, `susde-ethereum`) | ERC-4626 share-price accounting | Not attempted - yet another distinct model (share price, not swap events); already has TVL coverage via the existing vault adapter, volume/fees not a meaningful concept for a single-asset vault |

PancakeSwap and Aerodrome were the two candidates actually audited live
on-chain this phase (RPC calls against real deployed contracts, not
assumption); Lido/Aave/vault-style protocols were reasoned about structurally
but not live-audited, since their accounting shape alone already disqualifies
them from a config-only, `swap_events`-reuse expansion - forcing them in
would mean a new adapter and a new table, out of scope for "prove one
protocol using existing primitives first."

### PancakeSwap V2 (BNB Chain) - selected

Confirmed live against the real, already-verified pool
(`0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae`):

- `pool.factory()` returns `0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73` - the
  real, canonical PancakeSwap V2 Factory.
- `pool.token0()`/`token1()` return the exact USDT/WBNB addresses already
  configured, in that order.
- The Swap event's `topic0` is byte-for-byte identical to Uniswap V2's
  (`0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d82`) - a
  genuine Uniswap V2 fork, not merely V2-shaped.

Because of that, this expansion needed **zero new decode or math code**:
`lib/onchain/volume/config.ts` gained one new `VOLUME_SOURCE_POOLS` entry
with `sourceKind: "uniswap-v2"`, reusing `decodeSwapLog`/
`computeSwapVolumeUsd`/`computeSwapFeeUsd` (`uniswap-v2.ts`) exactly as
written for the Ethereum pool - see `lib/onchain/volume/pancakeswap.test.ts`,
which decodes a real, live-captured PancakeSwap Swap event (block
118,258,974) through the unmodified V2 decoder as direct proof of reuse.

**Data contract**:
- **TVL**: already native since an earlier phase (`VERIFIED_POOLS`'
  balance-based methodology - direct ERC20 `balanceOf(pool)` reads).
- **Volume/fees**: native, from real Swap events, at PancakeSwap's own fee
  tier - **25 bps (0.25%)**, not Uniswap V2's 30 bps. This is PancakeSwap
  V2's fixed, contract-hardcoded swap fee (a `9975/10000` factor baked into
  `swap()`'s constant-product check), not a governance-configurable
  parameter - trusting it reduces to confirming the pair was genuinely
  deployed by the canonical factory, which the live `factory()` check above
  does directly. Live smoke test: 53 real swaps indexed across 3 chunks, 53
  priced, 0 unpriced.
- **Revenue**: **unavailable**, not fabricated. `factory.feeTo()` returns
  `0x0ed943Ce24BaEBf257488771759F9BF482C39706` (non-zero, confirmed live) -
  the protocol-fee switch is active, the same "active but unrealized without
  Mint/Burn + `kLast` tracking" situation as the Ethereum V2 pool. Reused
  `protocol-fee.ts`'s existing V2 revenue logic unmodified via
  `engine.ts`'s `sourceKind` dispatch - no PancakeSwap-specific revenue code
  was written.
- **Confidence**: `HIGH` for volume/fees when every swap in a run's chunk
  was priced (confirmed live - see below); the same `classifyVolumeConfidence`
  thresholds already governing the Ethereum pool, not a new rule.

### The BNB Chain pricing gap (found, then fixed)

Auditing PancakeSwap's viability surfaced a real blocker: Phase 5.3's
`REFERENCE_ASSETS` (`lib/onchain/pricing/config.ts`) was Ethereum-only -
zero BSC entries. Without a native USD price for USDT/WBNB,
`getNativeTokenPrice` would never resolve for BSC, and every PancakeSwap
swap would be permanently unpriced - technically "NATIVE" by config, but
practically useless (always `LOW` confidence, `$0` volume).

The pricing *engine* (`priceReferenceAssetsOnChain`, `deriveV2Price`,
`resolveReferenceOrder`) was already fully chain-parameterized - the
Ethereum-only limitation was purely a config gap, not an architectural one.
`bnb-chain` was also already a fully supported chain elsewhere
(`VIEM_CHAIN_BY_SLUG`, `confirmations.ts`, `rpc-client.ts` default URLs, and
an existing `VERIFIED_POOLS` entry) - so this is extending an
already-supported chain's pricing coverage, not adding a new chain.

Fix: two new `REFERENCE_ASSETS` entries, mirroring the exact
anchor+derived shape `usdc-ethereum`/`weth-ethereum` already established -
`usdt-bnb-chain` (anchor, hand-declared $1.00, same role as `usdc-ethereum`)
and `wbnb-bnb-chain` (derived, priced from the SAME PancakeSwap
USDT/WBNB pool used for TVL and volume - one verified pool serving three
purposes, the same reuse precedent the Ethereum USDC/WETH pool already set).
No pricing engine code changed - reused Phase 5.3's mechanism exactly as
instructed, not a new external provider.

Live smoke test (`npm run price:onchain`): both new assets priced
successfully. `usdt-bnb-chain` at the anchor's fixed `$1.00`;
`wbnb-bnb-chain` derived at `$698.97`, `MEDIUM` confidence (single
uncorroborated source, ~$81.4M pool liquidity - comfortably above the
minimum-liquidity floor), the same confidence class a single-source
Ethereum derived asset would get.

### Aerodrome V1 (Base) - audited and rejected this round

Confirmed live: a genuine Solidly/Velodrome-fork AMM, real factory
(`0x420DD381b31aEf6683db6B902084cB0FfECe40Da`), real
`getReserves()`-compatible pool, `stable() == false` (this configured pool
is volatile), current fee `factory.getFee(pool, false) == 30` (0.30%).

**Why it's disqualified this round**: Aerodrome's factory exposes
governance-controlled `setFee(bool, uint256)` and `setCustomFee(address,
uint256)` - the fee is **not immutable per-pool** the way PancakeSwap's or
Uniswap V2/V3's fee is. The established "verify once at config time, trust
forever" pattern this app uses for `feeBps` (safe for PancakeSwap/Uniswap V2
because their fee is contract-hardcoded) would be unsafe here: the fee could
change after verification without any code noticing, silently miscomputing
every subsequent fee calculation for historical ranges that predate the
change - a direct violation of "never assume current configuration applied
historically." Safely including Aerodrome needs either live per-run fee
verification or fee-history event tracking, both real extensions beyond this
phase's scope - left for a future phase, not implemented as a
known-unsafe shortcut.

### What this phase deliberately did not build

- No new adapter code, no new event-decode logic, no new database table or
  migration - PancakeSwap reuses the existing V2 adapter and `swap_events`
  table entirely unmodified.
- No Aerodrome (or any governance-mutable-fee protocol) support - see above.
- No Lido/Aave/vault-shaped volume or revenue - structurally out of scope
  for a swap-pair-based expansion, not merely deferred for time.
- No new chain support - `bnb-chain` was already supported; only its
  pricing *coverage* was extended.
- No DeFiLlama shadow-comparison automation - PancakeSwap's live-indexed
  volume was cross-checked by hand against the swap fixtures' own implied
  price (~$700/WBNB, consistent across three independent live captures)
  rather than an automated DefiLlama diff, which this phase didn't build
  tooling for.

## Known limitations

- Six verified pools across five chains, plus two verified ERC-4626 vaults
  on Ethereum — a proof of concept, not meaningful DEX or vault coverage.
  See `VERIFIED_POOLS`/`VERIFIED_VAULTS` in `lib/onchain/config.ts` for the
  current lists.
- No protocol-level native TVL — see
  [Native TVL calculation](#native-tvl-calculation) above for why that
  would currently be dishonest, not just incomplete.
- Price is still entirely external (CoinGecko) for **vaults**, and for
  **every pool token that isn't one of the seven hand-curated reference
  assets** (USDC/WETH/USDT/DAI/WBTC on Ethereum; USDT/WBNB on BNB Chain as
  of Phase 5.7) — see
  [Native price engine (Phase 5.3)](#native-price-engine-phase-53),
  [Native protocol coverage expansion (Phase 5.7)](#native-protocol-coverage-expansion-phase-57),
  and [Price provider abstraction](#price-provider-abstraction). For the
  reference assets themselves, on a pool where `verifyAllPools` runs, the
  USD conversion is DeFiHub-computed from a real, verified on-chain reserve
  ratio whenever confidence is `HIGH`/`MEDIUM`; below that bar, or for any
  other token, it's still CoinGecko. Be precise about what "native pricing"
  covers here: seven hand-curated assets across two chains, one AMM adapter
  — not a general on-chain price feed for arbitrary tokens.
- `historical_observations` only has real depth from the point Phase 4
  shipped forward — there's no backfill of pre-Phase-4 verified-TVL history
  (the pre-existing `onchain_verifications` table only ever stored the
  latest value, so there was nothing to backfill from). Vaults (Phase 5.2)
  have the same limitation from their own start date - there is no
  event-log-based historical backfill for either entity type; only the
  live indexing path (a fresh observation each scheduled run) is
  implemented. See `lib/indexing/events.ts`'s own "foundation only, not a
  shipped indexer" scoping for why a real backfill isn't attempted yet.
- No UI surfaces `historical_observations` yet (no pool/vault-TVL history
  chart) — deliberately deferred to avoid a UI change beyond scope; the
  query layer (`getPoolTvlHistory`/`getVaultTvlHistory`) is ready for one.
  The existing `OnchainVerificationCard` (protocol detail page) does
  already surface the *latest* value for both pools and vaults, with no
  changes needed - it reads `onchain_verifications` generically.
- Lending/borrowing markets (exchange-rate and debt accounting across
  multiple reserves, not a single contract balance or a single accounting
  call) remain explicitly out of scope — see `lib/onchain/config.ts`'s own
  category boundary discussion. ERC-4626 vaults are not an exception to
  this: they're supported because `totalAssets()` is one direct,
  unambiguous call, the same shape as the existing "direct" protocol-TVL
  reads, not because vault-shaped contracts as a class are now in scope.
- `checkBlockHashStillCanonical` is no longer just a tested, standalone
  utility - `workers/onchain/recheck-reorgs.ts` (Phase 5.1, generalized to
  vaults in Phase 5.2) wires it into a real, scheduled recheck of every
  pool's and vault's recent block-hash-pinned observations, marking a
  detected reorg via `historicalObservations.reorgInvalidatedAt` (excluded
  from `getPoolTvlHistory`/`getVaultTvlHistory` without ever deleting the
  row). The two legacy `VERIFIED_PROTOCOL_TVLS` entries (Lido, Aave) still
  have no block-hash provenance at all - `onchain_verifications` has no
  `blockHash` column - so they remain outside this recheck's coverage; see
  `recheck-reorgs.ts`'s own module comment.
- **Volume/fees/revenue cover exactly two pools** - the Uniswap V2 USDC/WETH
  pair on Ethereum (Phase 5.4) and PancakeSwap V2 USDT/WBNB on BNB Chain
  (Phase 5.7). See
  [Native volume/fee/revenue engine (Phase 5.4)](#native-volumefeerevenue-engine-phase-54)
  and
  [Native protocol coverage expansion (Phase 5.7)](#native-protocol-coverage-expansion-phase-57)
  for the full picture, including why revenue is reported as unavailable for
  *both* pools specifically (each one's protocol-fee switch is live and
  active, and this phase does not implement the `Mint`/`Burn` + `kLast`
  tracking a nonzero-`feeTo()` deployment requires).
- **No Uniswap V3 volume** - the existing verified V3 pool
  (`uniswap-v3-eth-usdc-weth-005` in `VERIFIED_POOLS`) has TVL coverage from
  Phase 4/5 but no volume/fee adapter; V3's concentrated-liquidity swap math
  is a genuinely different calculation from V2's constant-product model, out
  of scope for this phase rather than approximated.
- **A mid-range reorg does not auto-recompute an already-written aggregate
  observation** - see this phase's own "Idempotency and reorg safety"
  section above for the exact gap and why the underlying raw events remain
  independently checkable in the meantime.
- **No lending-protocol fee/interest accounting** - the "never a generic
  guessing adapter" boundary this task itself sets; a lending market's
  supply/borrow-rate-driven interest is a different accounting model than a
  swap-fee-based one and isn't attempted here.
- **Adaptive range-shrinking (Phase 5.5) cannot recover a cursor whose
  starting point itself is too far behind the current head for the
  configured RPC provider to serve at any range width** - see
  [Indexer reliability & historical catch-up (Phase 5.5)](#indexer-reliability--historical-catch-up-phase-55)'s
  own "What this doesn't fix" section. `manuallyAdvanceCursor`
  (`lib/indexing/manual-recovery.ts`) is the deliberate, human-in-the-loop
  answer, not an automated one - this app has never configured a fallback
  RPC provider for Ethereum, so there is genuinely no alternate provider
  for `withResilientClient` to fail over to when the primary's free-tier
  window is the actual constraint.
- **No backfill mode with an explicit, bounded end block** - Phase 5.5's
  own Section 34 explicitly permits skipping this ("if unnecessary, do not
  add it"); the existing catch-up mechanism already handles "resume from
  wherever the cursor is, up to the current safe head," which is the real
  problem this phase exists to solve. A genuinely separate historical
  window (disconnected from the live cursor) was judged unnecessary this
  round.
- **No V3 tick/position/liquidity accounting, Mint/Burn/Collect indexing,
  or active-in-range-only TVL** (Phase 5.6) - deliberately not built,
  because this app's existing balance-based TVL methodology never needed
  it; see the Phase 5.6 section above's "What this phase deliberately did
  NOT build." A future phase wanting TRUE active-liquidity TVL (as opposed
  to total-balance TVL) or realized V3 protocol revenue starts this work
  from zero.
- **V3 protocol revenue is unavailable for the one configured V3 pool** -
  `slot0().feeProtocol == 68` (live-verified, both tokens have an active
  1/4 protocol cut) - the same "mechanism active, realized amount not
  tracked" situation as the V2 pool, for the same class of reason
  (Mint/Burn/kLast for V2, Swap fee-growth + `collectProtocol()` for V3).
  Realized revenue for an active period is still never computed - but the
  range-wide "active vs. verifiably zero" classification itself is now
  reconstructed from real `SetFeeProtocol` transition events across the
  whole indexed range, not just its two boundaries (see the "PR #14
  follow-up fix" note in the Revenue section above), so a transition that
  happens to return to the same state at both boundaries can no longer be
  silently mis-reported as verified-zero.
- **Multi-pool and multi-chain volume indexing have now been exercised live
  together in a single combined run** - `VOLUME_SOURCE_POOLS`
  (`lib/onchain/volume/config.ts`) has three real entries: two on Ethereum
  (Uniswap V2, Uniswap V3 - Phase 5.6) and one on BNB Chain (PancakeSwap V2
  - Phase 5.7). Each pair was previously verified live in isolation during
  its own phase's development; after merging both phases onto this branch,
  a real `npm run index:volume` run indexed all three together in one pass
  with zero cross-pool/cross-chain interference: `uniswap-v2-eth-usdc-weth`
  (17 swaps, 17 priced), `uniswap-v3-eth-usdc-weth-005` (46 swaps, 46
  priced, revenue correctly reported unavailable via the PR #14 fix's
  segment-reconstruction logic rather than the old boundary-only check),
  and `pancakeswap-amm-bsc-usdt-wbnb` (36 swaps, 36 priced) - all three
  `outcome: "success"`. Still only two chains, both EVM; Aerodrome (Base)
  remains audited-but-unsupported (see
  [Native protocol coverage expansion (Phase 5.7)](#native-protocol-coverage-expansion-phase-57)).
