// Phase 5.3: shared types for the independent on-chain price engine. Kept
// dependency-free at the type level (only imports from schema.ts, which is
// itself a leaf module) so every other file under lib/onchain/pricing/ can
// import from here without risking a cycle - the same discipline
// lib/onchain/verification-key.ts already established for the pool/vault
// verification pipeline.
import type { PriceSourceObservation } from "@/lib/database/schema";

export type { PriceSourceObservation };

// The one on-chain price-source adapter this phase implements and verifies
// end-to-end (see lib/onchain/pricing/uniswap-v2.ts). A deliberately narrow
// union, not a generic "protocol: string" - adding a second adapter (e.g.
// Uniswap V3) means adding a member here and a matching arm everywhere this
// type is switched on, so the compiler catches an incomplete rollout instead
// of a new source silently falling through a default case.
export type PriceSourceKind = "uniswap-v2";

// Distinguishes a price DeFiHub actually computed from its own on-chain
// reads from one that's still fundamentally sourced from a third-party
// aggregator - see docs/native-data.md and this phase's own final report for
// which is which. Never mislabel one as the other: a CoinGecko-derived price
// is EXTERNAL_FALLBACK even when it happens to agree with an on-chain price,
// and an on-chain price is ONCHAIN_NATIVE even when its confidence is LOW.
// HYBRID is reserved for a metric that genuinely combines both within one
// observation (not currently produced by this phase - the TVL integration
// below tags each pool's overall priceSource as "onchain-native" only when
// EVERY token it needed came from an on-chain reference price; otherwise it
// keeps the existing "coingecko" tag rather than fabricating a HYBRID
// classification this phase doesn't yet compute per-token weightings for).
export type PriceLabel = "ONCHAIN_NATIVE" | "EXTERNAL_FALLBACK" | "HYBRID";

// Deterministic, not a model - see classifyConfidence in aggregate.ts for
// the exact rules. INVALID means "do not use this price for anything,
// including display" - distinct from a source simply being excluded from
// aggregation (which can still leave a valid, if lower-confidence, result
// from the remaining sources).
export type PriceConfidence = "HIGH" | "MEDIUM" | "LOW" | "INVALID";

// One source pool's fully-decoded, not-yet-judged reading - the raw material
// classifyConfidence/aggregatePrices (aggregate.ts) turn into an included-or-
// rejected PriceSourceObservation. Kept separate from PriceSourceObservation
// itself (which additionally carries `included`/`exclusionReason`, i.e. a
// verdict) so the pure aggregation functions have one unambiguous input
// shape to reason about, never a partially-decided one.
export interface CandidatePriceSource {
  sourceKind: PriceSourceKind;
  sourcePoolAddress: string;
  sourceChainSlug: string;
  pairedTokenSymbol: string;
  pairedTokenAddress: string;
  pairedTokenPriceUsd: string;
  priceUsd: string;
  liquidityUsd: string;
  reserveRaw: string;
  pairedReserveRaw: string;
}

export interface AggregatedPriceResult {
  priceUsd: string;
  confidence: PriceConfidence;
  label: PriceLabel;
  sources: PriceSourceObservation[]; // every source considered, included or not - see that type's own comment
}
