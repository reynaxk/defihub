import { describe, expect, it } from "vitest";
import { evaluateCondition } from "./evaluate";

describe("evaluateCondition", () => {
  it("above triggers strictly above the threshold", () => {
    expect(evaluateCondition("above", 101, 100, null)).toBe(true);
    expect(evaluateCondition("above", 100, 100, null)).toBe(false);
    expect(evaluateCondition("above", 99, 100, null)).toBe(false);
  });

  it("below triggers strictly below the threshold", () => {
    expect(evaluateCondition("below", 99, 100, null)).toBe(true);
    expect(evaluateCondition("below", 100, 100, null)).toBe(false);
  });

  it("percent_change_up triggers when the increase meets the threshold", () => {
    // 100 -> 110 is +10%
    expect(evaluateCondition("percent_change_up", 110, 10, 100)).toBe(true);
    expect(evaluateCondition("percent_change_up", 109, 10, 100)).toBe(false);
  });

  it("percent_change_down triggers when the decrease meets the threshold", () => {
    // 100 -> 90 is -10%
    expect(evaluateCondition("percent_change_down", 90, 10, 100)).toBe(true);
    expect(evaluateCondition("percent_change_down", 91, 10, 100)).toBe(false);
  });

  it("percent_change conditions never trigger without a previous value", () => {
    expect(evaluateCondition("percent_change_up", 110, 10, null)).toBe(false);
    expect(evaluateCondition("percent_change_down", 90, 10, null)).toBe(false);
  });

  it("percent_change conditions never divide by zero", () => {
    expect(evaluateCondition("percent_change_up", 50, 10, 0)).toBe(false);
    expect(evaluateCondition("percent_change_down", 50, 10, 0)).toBe(false);
  });

  it("percent_change_up does not trigger on a decrease", () => {
    expect(evaluateCondition("percent_change_up", 90, 10, 100)).toBe(false);
  });

  it("percent_change_down does not trigger on an increase", () => {
    expect(evaluateCondition("percent_change_down", 110, 10, 100)).toBe(false);
  });
});
