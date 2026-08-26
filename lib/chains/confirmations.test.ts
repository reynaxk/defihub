// Pure unit tests for confirmationsFor/safeHeadFor - no RPC, no DB.
import { describe, expect, it } from "vitest";
import { confirmationsFor, safeHeadFor } from "./confirmations";

describe("confirmationsFor", () => {
  it("returns each configured chain's own confirmation depth", () => {
    expect(confirmationsFor("ethereum")).toBe(BigInt(12));
    expect(confirmationsFor("polygon")).toBe(BigInt(128));
  });

  it("falls back to the default depth for an unconfigured chain", () => {
    expect(confirmationsFor("some-future-chain")).toBe(BigInt(12));
  });
});

describe("safeHeadFor", () => {
  it("subtracts the chain's own confirmation depth from the current head", () => {
    expect(safeHeadFor("ethereum", BigInt(1000))).toBe(BigInt(988));
  });

  it("uses a deeper confirmation depth for a chain that requires one", () => {
    expect(safeHeadFor("polygon", BigInt(1000))).toBe(BigInt(872));
  });

  it("clamps at zero rather than going negative for a chain still near genesis", () => {
    expect(safeHeadFor("ethereum", BigInt(5))).toBe(BigInt(0));
  });

  it("clamps at zero exactly at the confirmation boundary", () => {
    expect(safeHeadFor("ethereum", BigInt(12))).toBe(BigInt(0));
  });

  it("is the single source of truth other modules must reuse rather than reimplementing", () => {
    // A regression guard, not a behavioral test: if this formula ever
    // changes, every caller (scanFromCursor, effectiveStartBlock) must
    // change with it by construction, since they import this function
    // rather than carrying their own copy.
    expect(safeHeadFor("ethereum", BigInt(13))).toBe(BigInt(1));
  });
});
