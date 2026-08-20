import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "./like-pattern";

describe("escapeLikePattern", () => {
  it("leaves ordinary text untouched", () => {
    expect(escapeLikePattern("uniswap")).toBe("uniswap");
  });

  it("escapes a literal percent sign", () => {
    expect(escapeLikePattern("50%")).toBe("50\\%");
  });

  it("escapes a literal underscore", () => {
    expect(escapeLikePattern("wrapped_eth")).toBe("wrapped\\_eth");
  });

  it("escapes a literal backslash", () => {
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("escapes the backslash before the wildcard escapes, so a value ending in a" +
    " backslash followed by a real percent doesn't collide with the escape sequence", () => {
    expect(escapeLikePattern("a\\%")).toBe("a\\\\\\%");
  });

  it("escapes multiple metacharacters together", () => {
    expect(escapeLikePattern("50%_off")).toBe("50\\%\\_off");
  });
});
