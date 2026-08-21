// Pure-function test - no DOM/render environment needed (this codebase has
// no jsdom/testing-library setup; classifyChange is exported separately
// from the ChangeBadge component specifically so its branching logic is
// testable without one). Importing from change-badge.tsx here never
// invokes the component itself, so no JSX evaluation occurs.
import { describe, expect, it } from "vitest";
import { classifyChange } from "./change-badge";

describe("classifyChange", () => {
  it("treats exactly 0 as neutral, not positive", () => {
    expect(classifyChange(0)).toBe("neutral");
  });

  it("rejects +Infinity as not a renderable change", () => {
    expect(classifyChange(Infinity)).toBeNull();
  });

  it("rejects -Infinity as not a renderable change", () => {
    expect(classifyChange(-Infinity)).toBeNull();
  });

  it("rejects NaN as not a renderable change", () => {
    expect(classifyChange(NaN)).toBeNull();
  });

  it("rejects null as not a renderable change", () => {
    expect(classifyChange(null)).toBeNull();
  });

  it("rejects undefined as not a renderable change", () => {
    expect(classifyChange(undefined)).toBeNull();
  });

  it("classifies a positive finite value as positive", () => {
    expect(classifyChange(4.2)).toBe("positive");
  });

  it("classifies a negative finite value as negative", () => {
    expect(classifyChange(-4.2)).toBe("negative");
  });
});
