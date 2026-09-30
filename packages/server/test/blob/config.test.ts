import { describe, it, expect, vi } from "vitest";
import { blobConfigFromEnv, DEFAULT_BLOB_CONFIG } from "../../src/blob/config";
import { createBlobTokenSigner } from "../../src/blob/token";

/**
 * The production entry point builds its blob config from here, so a silent
 * change to these defaults (or to the "no secret configured" path) would ship.
 */
describe("blobConfigFromEnv", () => {
  it("generates a usable secret when none is configured, and warns about it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = blobConfigFromEnv({});

    expect(config.secret).toHaveLength(64);
    // A generated secret must be a real key, not an empty string.
    expect(() => createBlobTokenSigner(config.secret)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("keeps a configured secret and honours every override", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = blobConfigFromEnv({
      BLOB_SECRET: "s3cret",
      BLOB_BASE_URL: "https://blobs.example.test",
      BLOB_DATA_DIR: "D:/data/blobs",
      BLOB_TOKEN_TTL_MS: "1000",
      BLOB_RETENTION_MS: "2000",
      BLOB_MAX_BYTES: "3000",
    });

    expect(warn).not.toHaveBeenCalled();
    expect(config.secret).toBe("s3cret");
    expect(config.baseUrl()).toBe("https://blobs.example.test");
    expect(config.dataDir).toBe("D:/data/blobs");
    expect(config.tokenTtlMs).toBe(1000);
    expect(config.retentionMs).toBe(2000);
    expect(config.maxBlobBytes).toBe(3000);
    // The inline threshold is registered, not enforced: nothing overrides it.
    expect(config.inlineThresholdBytes).toBe(DEFAULT_BLOB_CONFIG.inlineThresholdBytes);
    expect(config.allowedMediaTypes).toBe(DEFAULT_BLOB_CONFIG.allowedMediaTypes);
    warn.mockRestore();
  });

  it("falls back to the defaults for unusable numbers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = blobConfigFromEnv({
      BLOB_SECRET: "s",
      BLOB_TOKEN_TTL_MS: "-5",
      BLOB_MAX_BYTES: "nope",
    });

    expect(config.tokenTtlMs).toBe(DEFAULT_BLOB_CONFIG.tokenTtlMs);
    expect(config.maxBlobBytes).toBe(DEFAULT_BLOB_CONFIG.maxBlobBytes);
    warn.mockRestore();
  });

  it("rejects a non-integer size instead of silently accepting it", () => {
    // The old local parser accepted 2.5; a byte count has to be a whole number.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = blobConfigFromEnv({ BLOB_SECRET: "s", BLOB_MAX_BYTES: "2.5" });

    expect(config.maxBlobBytes).toBe(DEFAULT_BLOB_CONFIG.maxBlobBytes);
    warn.mockRestore();
  });

  it("falls back and warns for a value above its ceiling", () => {
    // An unbounded retention means "never collect"; an unbounded size means
    // "stream until the disk is full". Both ceilings are visible in the warning.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const config = blobConfigFromEnv({
      BLOB_SECRET: "s",
      BLOB_TOKEN_TTL_MS: "999999999999",
      BLOB_RETENTION_MS: "999999999999999",
      BLOB_MAX_BYTES: "999999999999999999",
    });

    expect(config.tokenTtlMs).toBe(DEFAULT_BLOB_CONFIG.tokenTtlMs);
    expect(config.retentionMs).toBe(DEFAULT_BLOB_CONFIG.retentionMs);
    expect(config.maxBlobBytes).toBe(DEFAULT_BLOB_CONFIG.maxBlobBytes);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0]![0])).toContain("BLOB_TOKEN_TTL_MS");
    warn.mockRestore();
  });
});
