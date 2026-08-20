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
