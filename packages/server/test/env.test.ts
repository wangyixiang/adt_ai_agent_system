import { describe, it, expect } from "vitest";
import { parseBoundedInt } from "../src/env";

describe("parseBoundedInt", () => {
  it("uses the value when it is a usable integer", () => {
    expect(parseBoundedInt("3", { fallback: 2, max: 10 })).toBe(3);
    expect(parseBoundedInt("0", { fallback: 2, max: 10 })).toBe(0);
    expect(parseBoundedInt("10", { fallback: 2, max: 10 })).toBe(10);
  });

  it("falls back for anything unusable, including a value above the cap", () => {
    expect(parseBoundedInt(undefined, { fallback: 2, max: 10 })).toBe(2);
    expect(parseBoundedInt("", { fallback: 2, max: 10 })).toBe(2);
    expect(parseBoundedInt("  ", { fallback: 2, max: 10 })).toBe(2);
    expect(parseBoundedInt("2.5", { fallback: 2, max: 10 })).toBe(2);
    expect(parseBoundedInt("-1", { fallback: 2, max: 10 })).toBe(2);
    expect(parseBoundedInt("nope", { fallback: 2, max: 10 })).toBe(2);
    // Above the cap falls back rather than being clamped, so the value actually
    // applied is always one the operator could have written themselves.
    expect(parseBoundedInt("11", { fallback: 2, max: 10 })).toBe(2);
    expect(parseBoundedInt("1000000000", { fallback: 2, max: 10 })).toBe(2);
  });

  it("honours a non-zero minimum", () => {
    expect(parseBoundedInt("0", { fallback: 5, min: 1, max: 10 })).toBe(5);
    expect(parseBoundedInt("1", { fallback: 5, min: 1, max: 10 })).toBe(1);
  });

  it("leaves the value uncapped when no maximum is given", () => {
    // The timeout keeps its old behaviour: capping it would silently shrink a
    // legitimately slow KB to the default, which is a worse surprise than a
    // large timeout.
    expect(parseBoundedInt("1000000000", { fallback: 2 })).toBe(1_000_000_000);
  });
});
