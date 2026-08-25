import { describe, expect, it } from "vitest";
import { resolveReferenceOrder, type ReferenceAssetNode } from "./reference-graph";
import { REFERENCE_ASSETS, toReferenceAssetNode } from "./config";

describe("resolveReferenceOrder", () => {
  it("resolves a valid, real dependency chain in dependency order - anchor before its direct dependents, and before a two-level dependent", () => {
    const order = resolveReferenceOrder(REFERENCE_ASSETS.map(toReferenceAssetNode));
    const indexOf = (key: string) => order.findIndex((n) => n.key === key);

    expect(indexOf("usdc-ethereum")).toBeGreaterThanOrEqual(0);
    expect(indexOf("usdc-ethereum")).toBeLessThan(indexOf("weth-ethereum"));
    expect(indexOf("usdc-ethereum")).toBeLessThan(indexOf("usdt-ethereum"));
    expect(indexOf("usdc-ethereum")).toBeLessThan(indexOf("dai-ethereum"));
    // wbtc depends on weth, which itself depends on usdc - a genuine
    // two-level chain, and wbtc must resolve strictly after weth.
    expect(indexOf("weth-ethereum")).toBeLessThan(indexOf("wbtc-ethereum"));
    expect(order).toHaveLength(REFERENCE_ASSETS.length);
  });

  it("resolves a simple two-node chain in the only valid order", () => {
    const nodes: ReferenceAssetNode[] = [
      { key: "b", dependsOn: ["a"] },
      { key: "a", dependsOn: [] },
    ];
    const order = resolveReferenceOrder(nodes);
    expect(order.map((n) => n.key)).toEqual(["a", "b"]);
  });

  it("preserves input order among ties (independent direct-to-anchor entries)", () => {
    const nodes: ReferenceAssetNode[] = [
      { key: "anchor", dependsOn: [] },
      { key: "x", dependsOn: ["anchor"] },
      { key: "y", dependsOn: ["anchor"] },
    ];
    const order = resolveReferenceOrder(nodes);
    expect(order.map((n) => n.key)).toEqual(["anchor", "x", "y"]);
  });

  it("throws a clear error on a direct circular dependency (A depends on B, B depends on A)", () => {
    const nodes: ReferenceAssetNode[] = [
      { key: "a", dependsOn: ["b"] },
      { key: "b", dependsOn: ["a"] },
    ];
    expect(() => resolveReferenceOrder(nodes)).toThrow(/circular/);
  });

  it("throws a clear error on a longer circular dependency (A -> B -> C -> A)", () => {
    const nodes: ReferenceAssetNode[] = [
      { key: "a", dependsOn: ["c"] },
      { key: "b", dependsOn: ["a"] },
      { key: "c", dependsOn: ["b"] },
    ];
    expect(() => resolveReferenceOrder(nodes)).toThrow(/circular/);
  });

  it("throws a clear error when an entry depends on a reference asset that doesn't exist in the set at all - a missing reference", () => {
    const nodes: ReferenceAssetNode[] = [{ key: "a", dependsOn: ["nonexistent"] }];
    expect(() => resolveReferenceOrder(nodes)).toThrow(/unknown reference asset "nonexistent"/);
  });

  it("resolves an empty graph to an empty order without throwing", () => {
    expect(resolveReferenceOrder([])).toEqual([]);
  });
});
