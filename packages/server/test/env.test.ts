import { describe, it, expect, vi } from "vitest";
import { parseBoundedInt, resolvePort } from "../src/env";

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

describe("resolvePort", () => {
  it("prefers an explicit option, including port 0", () => {
    // `port: 0` means "any free port" and is how the integration tests listen.
    expect(resolvePort(0, { PORT: "9999" })).toBe(0);
    expect(resolvePort(3000, {})).toBe(3000);
  });

  it("falls back for a missing or unusable PORT instead of crashing", () => {
    // `Number("abc")` is NaN, which Node rejects at listen time with a confusing
    // ERR_SOCKET_BAD_PORT; a bad PORT should degrade to the default and say so.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolvePort(undefined, {})).toBe(8080);
      expect(resolvePort(undefined, { PORT: "3000" })).toBe(3000);
      expect(resolvePort(undefined, { PORT: "abc" })).toBe(8080);
      expect(resolvePort(undefined, { PORT: "0" })).toBe(8080);
      expect(resolvePort(undefined, { PORT: "70000" })).toBe(8080);
      // Three rejections, each naming the variable (not just the first call).
      expect(warn).toHaveBeenCalledTimes(3);
      for (const call of warn.mock.calls) {
        expect(String(call[0])).toContain("PORT");
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("sanitises an explicit port too, instead of handing Node a NaN", () => {
    // `StartOptions.port` is a public API, so the explicit value can be garbage
    // as well — the guarantee must not depend on which path was taken.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(resolvePort(NaN, {})).toBe(8080);
      expect(resolvePort(2.5, {})).toBe(8080);
      expect(resolvePort(-1, {})).toBe(8080);
      expect(resolvePort(70_000, {})).toBe(8080);
      expect(warn).toHaveBeenCalledTimes(4);
    } finally {
      warn.mockRestore();
    }
  });
});
