import { FACTORY_DEPLOYMENTS } from "@/lib/onchain/discovery/config";
import { getActiveDiscoveredPools } from "@/lib/onchain/discovery/queries";

// Phase 5.13, Part 2/9 - the read side of scaling native pricing beyond the
// 7 hardcoded REFERENCE_ASSETS (config.ts): rather than a human hand-adding
// entries there one at a time, this module finds candidate pricing pools
// directly from the SAME discovered-pool data Phase 5.9-5.12 already
// produces (getActiveDiscoveredPools) - "prefer scalable configuration/
// data-driven discovery over hardcoding individual pools," per this phase's
// own instruction. Pure DB read, no RPC of its own.
//
// V2-style deployments only. deriveV2Price (uniswap-v2.ts) - the ONLY price-
// derivation math this phase reuses - depends on getReserves()'s constant-
// product invariant; a V3 pool (concentrated liquidity, no getReserves())
// needs a genuinely different calculation this phase does not implement
// (see this phase's own "do NOT turn this into another generic
// infrastructure rewrite" instruction - V3 pricing is real, separate scope,
// not a small extension of this one).
const V2_DEPLOYMENT_KEYS = new Set(FACTORY_DEPLOYMENTS.filter((d) => d.dexKind === "uniswap-v2").map((d) => d.key));

// A token's identity for this module's own trusted-set bookkeeping - an
// address alone isn't globally unique (two different chains can coincide on
// the same 20-byte address), so every lookup here is chain-scoped. Also
// reused, verbatim, as the synthetic ReferenceAsset.key for a dynamically-
// discovered token in dynamic-engine.ts - see that file's own comment for
// why a single, uniform key scheme (rather than a separate human-chosen key
// per hop) is what makes cycle-safety-by-construction actually hold.
export function pricingAddressKey(chainSlug: string, address: string): string {
  return `${chainSlug}:${address.toLowerCase()}`;
}

export interface PricingCandidateEdge {
  poolAddress: string;
  chainSlug: string;
  dexKind: "uniswap-v2";
  // The not-yet-trusted token this pool could price this hop.
  candidateAddress: string;
  candidateDecimals: number;
  candidateSymbol: string | null;
  // The already-trusted token this pool pairs it against - identified by
  // its OWN pricingAddressKey, which the caller's trusted-set map is keyed
  // by (see this function's own `trustedByAddressKey` param).
  quoteAddressKey: string;
  quoteAddress: string;
}

// Every V2-style active discovered pool where EXACTLY one side's token is
// already in `trustedByAddressKey` and the other is not - one edge per such
// (pool, untrusted-token) pairing. A pool where BOTH sides are already
// trusted contributes nothing new; a pool where NEITHER side is trusted is
// correctly deferred (it may become a candidate on a LATER hop, once
// something else prices one of its own tokens first, or never, if nothing
// ever does). This is what makes the caller's hop-by-hop resolution safe
// against cycles BY CONSTRUCTION, not by a separate detection pass - see
// dynamic-engine.ts's own module comment for the full argument.
export async function findPricingCandidateEdges(trustedByAddressKey: ReadonlySet<string>): Promise<PricingCandidateEdge[]> {
  const activePools = await getActiveDiscoveredPools();
  const edges: PricingCandidateEdge[] = [];

  for (const pool of activePools) {
    if (!V2_DEPLOYMENT_KEYS.has(pool.deploymentKey)) continue;

    const key0 = pricingAddressKey(pool.chainSlug, pool.token0Address);
    const key1 = pricingAddressKey(pool.chainSlug, pool.token1Address);
    const trusted0 = trustedByAddressKey.has(key0);
    const trusted1 = trustedByAddressKey.has(key1);

    if (trusted0 === trusted1) continue; // both trusted (nothing new) or neither (defer to a later hop)

    const candidateIsToken0 = trusted1;
    edges.push({
      poolAddress: pool.poolAddress,
      chainSlug: pool.chainSlug,
      dexKind: "uniswap-v2",
      candidateAddress: candidateIsToken0 ? pool.token0Address : pool.token1Address,
      candidateDecimals: candidateIsToken0 ? pool.token0Decimals : pool.token1Decimals,
      candidateSymbol: candidateIsToken0 ? pool.token0Symbol : pool.token1Symbol,
      quoteAddressKey: candidateIsToken0 ? key1 : key0,
      quoteAddress: candidateIsToken0 ? pool.token1Address : pool.token0Address,
    });
  }

  return edges;
}
