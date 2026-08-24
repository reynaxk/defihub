# Docs

Deeper reference material than the main [README](../README.md), which stays
focused on getting the app running locally. Update these when the
architecture actually changes — a doc describing a system that no longer
exists is worse than no doc.

- **[architecture.md](./architecture.md)** — the data pipeline, provider
  abstraction, why there's no in-house blockchain indexer, graceful
  degradation, auth, rate limiting, observability.
- **[native-data.md](./native-data.md)** — the Phase 4 foundation for
  DeFiHub-computed (not aggregator-sourced) metrics: RPC/indexer
  primitives, canonical pool entities, native AMM TVL calculation,
  historical observations, and the historical-TVL chart bug found and
  fixed during that work.
- **[database.md](./database.md)** — schema overview, the `DISTINCT ON`
  pattern for "latest snapshot," index design notes, migration workflow.
- **[data-sources.md](./data-sources.md)** — exact DefiLlama/CoinGecko
  endpoints in use, sync cadence, and the known limitations each provider
  imposes (not bugs — inherited constraints, documented so they're not
  mistaken for bugs later).
- **[security.md](./security.md)** — what's implemented, what's explicitly
  not (and why), and the standing rule that wallet/private-key handling and
  real-money trade execution don't exist in this codebase at all.
- **[monetization.md](./monetization.md)** — planning only, nothing
  implemented: where a paid tier would attach to the existing schema/API if
  one is ever added.

The public API itself is documented live at `/api-docs`, not duplicated
here — a hand-maintained copy would drift from the real endpoints.
