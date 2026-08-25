// Phase 5.3's dependency-resolution primitive for reference-asset pricing.
// Deliberately a small, explicit topological sort over a hand-curated graph
// (lib/onchain/pricing/config.ts's REFERENCE_ASSETS), not an auto-discovered
// or dynamically-growing one - the same "fixed, human-reviewed list" spirit
// as VERIFIED_POOLS/VERIFIED_VAULTS (lib/onchain/config.ts). A price
// dependency graph that could grow or reorder itself at runtime is exactly
// the shape that risks a silent cycle (asset A priced from a pool paired
// against B, B priced from a pool paired against A) - resolving order once,
// explicitly, and refusing to proceed on a cycle, is what keeps this
// provably acyclic rather than merely "acyclic in practice so far."
export interface ReferenceAssetNode {
  key: string;
  // Keys of other reference assets this one's own price derivation needs
  // already resolved - empty for an anchor (a reference asset with a
  // hand-declared, not on-chain-derived, USD price - see config.ts's own
  // comment on why some starting point is unavoidable).
  dependsOn: readonly string[];
}

// Kahn's algorithm: repeatedly peel off nodes with no unresolved
// dependencies, in stable input order among ties (so two independent
// direct-to-anchor assets resolve in the order they were declared, not an
// arbitrary one) - deterministic and easy to reason about, appropriate for
// a graph this small (a handful of hand-curated entries, not hundreds).
// Throws, rather than returning a partial order, the moment it's clear a
// cycle exists (some remaining nodes' dependencies are only satisfiable by
// each other) - a caller must never silently price a subset of a cyclic
// graph and treat that as complete.
export function resolveReferenceOrder<T extends ReferenceAssetNode>(assets: readonly T[]): T[] {
  const byKey = new Map(assets.map((a) => [a.key, a]));
  for (const asset of assets) {
    for (const dep of asset.dependsOn) {
      if (!byKey.has(dep)) {
        throw new Error(`reference asset "${asset.key}" depends on unknown reference asset "${dep}"`);
      }
    }
  }

  const resolved: T[] = [];
  const resolvedKeys = new Set<string>();
  const remaining = [...assets];

  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((a) => a.dependsOn.every((dep) => resolvedKeys.has(dep)));
    if (readyIndex === -1) {
      const stuckKeys = remaining.map((a) => a.key).join(", ");
      throw new Error(
        `circular (or otherwise unsatisfiable) reference asset dependency detected among: ${stuckKeys} - ` +
          "every remaining entry depends on at least one other entry in this same set, so none can ever resolve first",
      );
    }
    const [next] = remaining.splice(readyIndex, 1);
    resolved.push(next);
    resolvedKeys.add(next.key);
  }

  return resolved;
}
