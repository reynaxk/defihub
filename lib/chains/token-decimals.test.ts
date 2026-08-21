import { describe, expect, it } from "vitest";
import { resolveDecimals, type DecimalsCallResult } from "./token-decimals";

function fakeMulticall(results: DecimalsCallResult[]) {
  return async () => results;
}

describe("resolveDecimals", () => {
  it("returns empty resolved/failed for an empty address list without calling multicall", async () => {
    let called = false;
    const result = await resolveDecimals([], async () => {
      called = true;
      return [];
    });
    expect(result.resolved.size).toBe(0);
    expect(result.failed).toEqual([]);
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
    expect(result.resolved.get("0xweth")).toBe(18);
    expect(result.resolved.get("0xusdc")).toBe(6);
    expect(result.resolved.get("0xwbtc")).toBe(8);
    expect(result.resolved.get("0xexotic")).toBe(24);
    expect(result.failed).toEqual([]);
  });

  it("leaves a failed read absent from resolved but reports it in failed, rather than fabricating a value or silently dropping it", async () => {
    const addresses = ["0xgood", "0xbad"];
    const multicall = fakeMulticall([
      { status: "success", result: 18 },
      { status: "failure" },
    ]);
    const result = await resolveDecimals(addresses, multicall);
    expect(result.resolved.get("0xgood")).toBe(18);
    expect(result.resolved.has("0xbad")).toBe(false);
    expect(result.failed).toEqual(["0xbad"]);
  });

  it("counts an address as failed when the multicall result is malformed (non-number)", async () => {
    const addresses = ["0xweird"];
    const multicall = fakeMulticall([{ status: "success", result: "not-a-number" }]);
    const result = await resolveDecimals(addresses, multicall);
    expect(result.resolved.has("0xweird")).toBe(false);
    expect(result.failed).toEqual(["0xweird"]);
  });

  it("reports every address as failed when the whole batch fails", async () => {
    const addresses = ["0xa", "0xb"];
    const multicall = fakeMulticall([{ status: "failure" }, { status: "failure" }]);
    const result = await resolveDecimals(addresses, multicall);
    expect(result.resolved.size).toBe(0);
    expect(result.failed).toEqual(["0xa", "0xb"]);
  });

  // ERC-20 decimals() is a uint8 - none of these are a valid value, even
  // though a bare `typeof result === "number"` check would have accepted
  // every one of them.
  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["NaN", NaN],
    ["above the uint8 range", 256],
  ])("treats a %s decimals value as a failed address, not a resolved one", async (_label, value) => {
    const addresses = ["0xinvalid"];
    const multicall = fakeMulticall([{ status: "success", result: value }]);
    const result = await resolveDecimals(addresses, multicall);
    expect(result.resolved.has("0xinvalid")).toBe(false);
    expect(result.failed).toEqual(["0xinvalid"]);
  });

  it("still accepts the uint8 boundary values 0 and 255", async () => {
    const addresses = ["0xzero", "0xmax"];
    const multicall = fakeMulticall([
      { status: "success", result: 0 },
      { status: "success", result: 255 },
    ]);
    const result = await resolveDecimals(addresses, multicall);
    expect(result.resolved.get("0xzero")).toBe(0);
    expect(result.resolved.get("0xmax")).toBe(255);
    expect(result.failed).toEqual([]);
  });
});
