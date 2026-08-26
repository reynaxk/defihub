// Reorg-safety confirmation depth per chain: how many blocks behind the
// reported chain head a scan/read must stay pinned to before treating that
// height as final. The chain head is not final - a reorg can orphan it, and
// once a consumer has advanced a persisted cursor or provenance record past
// a height, that height is never revisited. Depth is not uniform across
// chains (Polygon/BNB Chain see routine reorgs deeper than Ethereum's
// now-rare few-block ones); these are deliberately conservative defaults,
// not a claim of absolute finality for any of them.
const CONFIRMATIONS_BY_CHAIN: Record<string, bigint> = {
  ethereum: BigInt(12),
  arbitrum: BigInt(20),
  base: BigInt(20),
  optimism: BigInt(20),
  "bnb-chain": BigInt(20),
  avalanche: BigInt(20),
  polygon: BigInt(128),
};

const DEFAULT_CONFIRMATIONS = BigInt(12);

export function confirmationsFor(chainSlug: string): bigint {
  return CONFIRMATIONS_BY_CHAIN[chainSlug] ?? DEFAULT_CONFIRMATIONS;
}

// Phase 5.5: the ONE place `currentBlock - confirmations, clamped at zero`
// is computed. Before this, lib/indexing/events.ts's scanFromCursor and
// lib/onchain/volume/engine.ts's own effectiveStartBlock each carried an
// independent, textually-identical copy of this exact formula - precisely
// the "multiple competing safe-head calculations" this phase's own
// instructions call out. Both now call this instead. Never use the raw,
// unconfirmed current block for any indexing/production decision - a reorg
// can still orphan it.
export function safeHeadFor(chainSlug: string, currentBlock: bigint): bigint {
  const confirmations = confirmationsFor(chainSlug);
  return currentBlock > confirmations ? currentBlock - confirmations : BigInt(0);
}
