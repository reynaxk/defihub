import { describe, expect, it } from "vitest";
import { pricingAddressKey } from "./dynamic-candidates";

describe("pricingAddressKey", () => {
  it("combines chainSlug and address, lowercasing the address", () => {
    expect(pricingAddressKey("ethereum", "0xABCDEF")).toBe("ethereum:0xabcdef");
  });

  it("is chain-scoped - the same address on two different chains produces two different keys, never colliding", () => {
    const a = pricingAddressKey("ethereum", "0xsame");
    const b = pricingAddressKey("bnb-chain", "0xsame");
    expect(a).not.toBe(b);
  });

  it("is case-insensitive on the address - two different-cased inputs for the same real address produce the same key", () => {
    expect(pricingAddressKey("ethereum", "0xAbC123")).toBe(pricingAddressKey("ethereum", "0xabc123"));
  });
});
