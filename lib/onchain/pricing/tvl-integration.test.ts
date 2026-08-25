// Pure unit tests for priceSourceForTokens - the deterministic policy
// deciding how a pool's historical_observations.priceSource should be
// tagged given which of its tokens got a native price override this run.
// resolveNativePriceOverrides itself is not unit-tested here, matching this
// codebase's established convention that an orchestration function
// composing a DB read (getNativeTokenPrice, covered by
// queries.integration.test.ts) with config isn't directly unit-tested, only
// its pure decision logic is.
import { describe, expect, it } from "vitest";
import { priceSourceForTokens } from "./tvl-integration";

describe("priceSourceForTokens", () => {
  it("tags a pool as onchain-pricing-engine when every one of its tokens was natively priced this run - native price", () => {
    const nativelyPriced = new Set(["usd-coin", "weth"]);
    expect(priceSourceForTokens(["usd-coin", "weth"], nativelyPriced, "coingecko")).toBe("onchain-pricing-engine");
  });

  it("tags a pool as hybrid when only some of its tokens were natively priced this run", () => {
    const nativelyPriced = new Set(["usd-coin"]);
    expect(priceSourceForTokens(["usd-coin", "l2-standard-bridged-weth-base"], nativelyPriced, "coingecko")).toBe(
      "hybrid:onchain-pricing-engine+coingecko",
    );
  });

  it("leaves the external provider's own tag unchanged when none of a pool's tokens were natively priced - fallback price", () => {
    const nativelyPriced = new Set<string>();
    expect(priceSourceForTokens(["tether", "wbnb"], nativelyPriced, "coingecko")).toBe("coingecko");
  });

  it("falls back to the external provider name for a pool with no tokens at all (unreachable in practice, never throws)", () => {
    expect(priceSourceForTokens([], new Set(), "coingecko")).toBe("coingecko");
  });
});
