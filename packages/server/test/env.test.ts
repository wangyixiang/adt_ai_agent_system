import { describe, it, expect, vi } from "vitest";
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

  it("warns when a value the operator wrote is thrown away", () => {
    // Falling back rather than clamping is only acceptable if the operator can
    // see that their value was discarded.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseBoundedInt("20", { fallback: 2, max: 10, name: "LLM_MAX_RETRIES" })).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain("LLM_MAX_RETRIES");
      expect(String(warn.mock.calls[0]![0])).toContain("20");
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when the value is absent, usable, or unnamed", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(parseBoundedInt(undefined, { fallback: 2, max: 10, name: "LLM_MAX_RETRIES" })).toBe(2);
      expect(parseBoundedInt("", { fallback: 2, max: 10, name: "LLM_MAX_RETRIES" })).toBe(2);
      expect(parseBoundedInt("5", { fallback: 2, max: 10, name: "LLM_MAX_RETRIES" })).toBe(5);
      // No name, no voice: a caller that did not ask for a warning gets none.
      expect(parseBoundedInt("20", { fallback: 2, max: 10 })).toBe(2);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
