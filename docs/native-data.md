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
[Exact-decimal precision](#exact-decimal-precision) below. A future
on-chain price source (e.g., reading a DEX's own spot price or a Chainlink
feed) only needs to implement the same `PriceProvider` interface and swap
the instance constructed in `lib/providers/index.ts`; the TVL calculation
itself doesn't change. Phase 4 doesn't attempt this — price discovery
robust enough to trust over a free aggregator API is a substantially
harder problem than reading a contract's own token balance, and out of
scope for a foundation phase (see the spec's own "do not build a
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
