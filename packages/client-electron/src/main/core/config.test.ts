import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect } from "vitest";

import { DEFAULT_SERVER_URL, effectiveConfig, readConfig, writeConfig } from "./config";

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
});
