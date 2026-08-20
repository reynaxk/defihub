import { describe, expect, it } from "vitest";
import { resolveDecimals, type DecimalsCallResult } from "./token-decimals";

function fakeMulticall(results: DecimalsCallResult[]) {
  return async () => results;
}

describe("resolveDecimals", () => {
  it("returns an empty map for an empty address list without calling multicall", async () => {
    let called = false;
    const result = await resolveDecimals([], async () => {
      called = true;
      return [];
    });
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it("resolves varying real decimal counts (18/6/8/unusual)", async () => {
    const addresses = ["0xweth", "0xusdc", "0xwbtc", "0xexotic"];
    const multicall = fakeMulticall([
      { status: "success", result: 18 },
      { status: "success", result: 6 },
      { status: "success", result: 8 },
      { status: "success", result: 24 },
    ]);
    const result = await resolveDecimals(addresses, multicall);
    expect(result.get("0xweth")).toBe(18);
    expect(result.get("0xusdc")).toBe(6);
    expect(result.get("0xwbtc")).toBe(8);
    expect(result.get("0xexotic")).toBe(24);
  });

  it("leaves a failed read absent from the map rather than fabricating a value", async () => {
    const addresses = ["0xgood", "0xbad"];
    const multicall = fakeMulticall([
      { status: "success", result: 18 },
      { status: "failure" },
    ]);
    const result = await resolveDecimals(addresses, multicall);
    expect(result.get("0xgood")).toBe(18);
    expect(result.has("0xbad")).toBe(false);
  });

  it("leaves an address absent when the multicall result is malformed (non-number)", async () => {
    const addresses = ["0xweird"];
    const multicall = fakeMulticall([{ status: "success", result: "not-a-number" }]);
    const result = await resolveDecimals(addresses, multicall);
    expect(result.has("0xweird")).toBe(false);
  });

  it("leaves everything absent when the whole batch fails", async () => {
    const addresses = ["0xa", "0xb"];
    const multicall = fakeMulticall([{ status: "failure" }, { status: "failure" }]);
    const result = await resolveDecimals(addresses, multicall);
    expect(result.size).toBe(0);
  });
});
