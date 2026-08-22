# Data sources & methodology

For nearly every metric in the app, DeFiHub doesn't compute TVL, fees,
revenue, volume, or APY itself — it displays each provider's own numbers,
normalized into a common shape. If a figure looks wrong, the question is
usually "does DefiLlama/CoinGecko show the same number," not "did DeFiHub's
math go wrong." The one deliberate exception is a small set of on-chain
AMM pool TVL figures DeFiHub computes directly from a live RPC read — see
[native-data.md](./native-data.md); those are clearly labeled as
independently verified wherever they appear, never presented as if they
were the provider's own number.

## DefiLlama (`lib/providers/defillama.ts`)

Free, no API key. Base URLs: `api.llama.fi` and `yields.llama.fi`.

| Endpoint | Used for | Synced by |
|---|---|---|
| `GET /protocols` | Protocol metadata, TVL, per-chain TVL breakdown | `sync:protocols` |
| `GET /overview/fees` (+ `dataType=dailyRevenue`) | 24h fees and revenue per protocol | `sync:protocols` |
| `GET /overview/dexs` (`dataType=dailyVolume`) | 24h trading volume per protocol | `sync:protocols` |
| `GET /v2/chains` | Chain list + current TVL | `sync:chains` |
| `GET /v2/historicalChainTvl/{chain}` | Full chain TVL history | `sync:chains` (one call per supported chain) |
| `GET yields.llama.fi/pools` | Yield pool APY/TVL, all chains/protocols in one call | `sync:yields` |

**Known limitations, inherited from the API, not introduced by DeFiHub:**

- **Fees/revenue/volume are aggregate-only.** DefiLlama doesn't break these
  down per chain the way it does TVL, so `protocol_metrics` rows with
  `chain_id = null` (the aggregate row) are the only ones with non-null
  fees/revenue/volume — a per-chain `protocol_metrics` row only ever has
  TVL populated.
- **Yield pools have no history.** The `/pools` endpoint returns current
  state only; `yield_pools` is overwritten on every sync, not appended to.
  `percent_change_*` alert conditions on a `pool_apy` alert never fire as a
  result — there's no previous value to compare against.
- **Not every protocol has a slug match across fees/dexs/pools endpoints.**
  A protocol can have TVL but no fees data (not all protocols report fees to
  DefiLlama), which is why `protocol_metrics.fees24h`/`revenue24h` are
  nullable, not defaulted to 0.
- **DefiLlama isn't internally consistent about chain names.** `/v2/chains`
  and `/v2/historicalChainTvl/{chain}` name Optimism "OP Mainnet"; every
  protocol's own `chains` array (from `/protocols`) calls the same chain
  "Optimism". `lib/config/chains.ts`'s `defillamaSlug` has to be the name
  used in the *protocol* `chains` array specifically, since that's what
  chain-to-protocol linking matches against - the historical-TVL endpoint
  turned out to accept both names for the same chain, but that's not
  guaranteed for every chain, so verify a new chain's exact name against a
  live `/protocols` response (not just `/v2/chains`) before adding it.

## CoinGecko (`lib/providers/coingecko.ts`)

Free public tier without a key (rate-limited); a free Demo API key
(`COINGECKO_API_KEY`) raises the limit significantly. Base URL:
`api.coingecko.com/api/v3`.

| Endpoint | Used for | Synced by |
|---|---|---|
| `GET /simple/price` (`include_market_cap`, `include_24hr_vol`, `include_24hr_change`) | Price/market cap/24h volume/24h change for tokens already in the DB | `sync:prices` (every 15 min) |
| `GET /coins/markets` (`order=market_cap_desc`, `per_page=250`) | Top ~250 tokens by market cap, with the same price/cap/volume/change fields | `sync:tokens` (every 6h) |
| `GET /coins/list` (`include_platform=true`) | Contract addresses per chain for every coin CoinGecko tracks | `sync:tokens`, cross-referenced against the `/coins/markets` result |

**Known limitations:**

- **A token only appears if it's deployed on one of the 8 supported chains.**
  `sync:tokens` cross-references `/coins/markets` results against
  `COINGECKO_PLATFORM_TO_CHAIN_SLUG` (`lib/config/chains.ts`) — a token in
  the top 250 by market cap with no contract on any of Ethereum, Solana,
  Arbitrum, Base, BNB Chain, Avalanche, Polygon, or Optimism (e.g., a
  Bitcoin-only or Tron-only asset) is skipped entirely, by design.
- **24h change is CoinGecko's own trailing-24h computation**, not derived
  from two of DeFiHub's own snapshots. This matters because it means the
  figure is correct from the very first sync, rather than requiring two
  sync runs a day apart before it means anything.
- **`tokens.decimals` is nullable, never defaulted to 18** — neither
  CoinGecko endpoint used here returns a token's actual decimal count.
  Nothing in this sync path converts raw on-chain amounts using it.
  Where this app *does* need a real, trustworthy decimals value for an
  on-chain calculation (the wallet balance reader, `pool_tokens.decimals`),
  it's read live from the token contract itself
  (`lib/chains/token-decimals.ts`) or hand-confirmed in
  `lib/onchain/config.ts` — see [native-data.md](./native-data.md) — never
  assumed from this sync.

## Adding a data source

Implement one of the interfaces in `lib/providers/types.ts`
(`DefiDataProvider`, `PriceProvider`, `TokenDiscoveryProvider`) and swap the
instance constructed in `lib/providers/index.ts`. Every provider method
should validate the raw response with a Zod schema and throw
`ProviderUnavailableError` on a shape mismatch or non-2xx response — never
let a malformed provider response reach a query function or the database
unchecked.
