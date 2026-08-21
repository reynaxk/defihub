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
});
