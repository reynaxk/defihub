import { describe, expect, it } from "vitest";
import { targetKey } from "./use-watch-toggle";

// Regression coverage for the resync fix: useWatchToggle resyncs local
// `watching` state whenever the target's key changes, not just when
// initialWatching's value changes - two different entities can
// coincidentally share the same initialWatching value, which a value-only
// comparison can't distinguish from "still the same entity". Full
// hook-level testing would need React Testing Library (not part of this
// project's test setup), so this covers the pure identity function the
// fix's correctness actually depends on: distinct entities must always
// produce distinct keys, including across different target kinds.
describe("targetKey", () => {
  it("produces distinct keys for different entities of the same kind", () => {
    expect(targetKey({ protocolId: "a" })).not.toBe(targetKey({ protocolId: "b" }));
    expect(targetKey({ chainId: "a" })).not.toBe(targetKey({ chainId: "b" }));
    expect(targetKey({ tokenId: "a" })).not.toBe(targetKey({ tokenId: "b" }));
    expect(targetKey({ yieldPoolId: "a" })).not.toBe(targetKey({ yieldPoolId: "b" }));
  });

  it("produces distinct keys across different target kinds even with the same id value", () => {
    const keys = new Set([
      targetKey({ protocolId: "x" }),
      targetKey({ chainId: "x" }),
      targetKey({ tokenId: "x" }),
      targetKey({ yieldPoolId: "x" }),
    ]);
    expect(keys.size).toBe(4);
  });

  it("is stable (same key) for the same entity", () => {
    expect(targetKey({ protocolId: "same" })).toBe(targetKey({ protocolId: "same" }));
  });
});
