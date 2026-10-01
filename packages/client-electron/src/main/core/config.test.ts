import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { DEFAULT_SERVER_URL, effectiveConfig, readConfig, sameConfig, writeConfig } from "./config";

describe("config", () => {
  it("prefers the stored value over the environment", () => {
    const config = effectiveConfig(
      { serverUrl: "ws://stored:1/ws" },
      { ADT_SERVER_URL: "ws://env:2/ws" },
      "C:/w",
    );
    expect(config).toEqual({ serverUrl: "ws://stored:1/ws", workspaceRoot: "C:/w", configured: true });
  });

  it("falls back to the environment when the file has no address", () => {
    expect(effectiveConfig(null, { ADT_SERVER_URL: "ws://env:2/ws" }, "C:/w").serverUrl).toBe("ws://env:2/ws");
  });

  it("is not configured when neither is set, and does not silently pick a real server", () => {
    const config = effectiveConfig(null, {}, "C:/w");
    expect(config.configured).toBe(false);
    expect(config.serverUrl).toBe(DEFAULT_SERVER_URL);
  });

  it("round-trips through the file, and tolerates a missing or broken one", () => {
    const dir = mkdtempSync(join(tmpdir(), "adt-cfg-"));
    try {
      const path = join(dir, "config.json");
      expect(readConfig(path)).toBeNull();
      writeConfig(path, { serverUrl: "ws://x/ws", workspaceRoot: "/w" });
      expect(readConfig(path)).toEqual({ serverUrl: "ws://x/ws", workspaceRoot: "/w" });
      writeFileSync(path, "{ not json");
      expect(readConfig(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the parent directory, and compares effective configs", () => {
    const dir = mkdtempSync(join(tmpdir(), "adt-cfg-"));
    try {
      const nested = join(dir, "a", "b", "config.json");
      writeConfig(nested, { serverUrl: "ws://x/ws" });
      expect(readConfig(nested)).toEqual({ serverUrl: "ws://x/ws" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const a = effectiveConfig({ serverUrl: "ws://x/ws", workspaceRoot: "/w" }, {}, "C:/w");
    const b = effectiveConfig({ serverUrl: "ws://x/ws", workspaceRoot: "/w" }, {}, "C:/w");
    const c = effectiveConfig({ serverUrl: "ws://y/ws", workspaceRoot: "/w" }, {}, "C:/w");
    expect(sameConfig(a, b)).toBe(true);
    expect(sameConfig(a, c)).toBe(false);
  });
});
