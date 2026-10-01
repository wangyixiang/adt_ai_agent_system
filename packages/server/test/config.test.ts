import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterEach } from "vitest";

import { loadEnvFile, loadServerEnv, formatStartupSummary, REPO_ROOT } from "../src/config";

const touched: string[] = [];
afterEach(() => {
  for (const key of touched.splice(0)) delete process.env[key];
});

describe("loadEnvFile", () => {
  it("lets the real environment win over the file", () => {
    process.env.ADT_PROBE_A = "from-real-env";
    touched.push("ADT_PROBE_A", "ADT_PROBE_B");
    const dir = mkdtempSync(join(tmpdir(), "adt-env-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, "ADT_PROBE_A=from-dotenv\nADT_PROBE_B=only-dotenv\n");
      loadEnvFile(file);
      expect(process.env.ADT_PROBE_A).toBe("from-real-env");
      expect(process.env.ADT_PROBE_B).toBe("only-dotenv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is a silent no-op when the file is missing", () => {
    expect(() => loadEnvFile(join(tmpdir(), "adt-nope", ".env"))).not.toThrow();
  });

  it("resolves the repo root from the module, not from cwd", () => {
    // `pnpm -C packages/server` moves cwd; the resolver must not follow it.
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { name: string };
    expect(pkg.name).toBe("adt-ai-agent-system");
  });

  it("loadServerEnv loads <root>/.env", () => {
    touched.push("ADT_PROBE_ROOT");
    const dir = mkdtempSync(join(tmpdir(), "adt-root-"));
    try {
      writeFileSync(join(dir, ".env"), "ADT_PROBE_ROOT=yes\n");
      loadServerEnv(dir);
      expect(process.env.ADT_PROBE_ROOT).toBe("yes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatStartupSummary", () => {
  it("reports the shape without leaking secrets", () => {
    const summary = formatStartupSummary({
      DATABASE_URL: "postgres://user:SECRETPW@dbhost:5432/adt",
      LLM_API_KEY: "sk-SECRETKEY",
      KB_ENDPOINT_URL: "https://kb",
      KB_TOKEN: "kb-SECRETTOKEN",
      BLOB_DATA_DIR: "/data/blobs",
    });
    expect(summary).toContain("dbhost:5432");
    expect(summary).toContain("llm: configured");
    expect(summary).toContain("kb export: configured");
    expect(summary).toContain("/data/blobs");
    expect(summary).not.toContain("SECRETPW");
    expect(summary).not.toContain("SECRETKEY");
    expect(summary).not.toContain("SECRETTOKEN");
  });

  it("says so when things are not configured", () => {
    const summary = formatStartupSummary({});
    expect(summary).toContain("not configured (no-op planner)");
    expect(summary).toContain("kb export: not configured");
  });
});
