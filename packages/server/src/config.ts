import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The repo root, resolved from **this file** rather than from `process.cwd()`:
 * every documented command runs under `pnpm -C packages/server`, which moves the
 * cwd to `packages/server`, so a cwd-relative `.env` would silently miss the
 * repo-root one the deployment spec means (§4.1).
 */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Loads a `.env` file into `process.env`, best-effort.
 *
 * Node's built-in `process.loadEnvFile` **does not override variables that are
 * already set**, so a real environment (e.g. a container's `environment:` or
 * `env_file:`) wins over a `.env` that happens to sit next to the code. That
 * precedence is deliberate: a checked-in `.env` must never shadow deployment
 * config. A missing file is a no-op; a malformed one warns and continues.
 */
export function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (error) {
    console.warn(`[config] could not load ${path}: ${(error as Error).message}`);
  }
}

/** Loads `<root>/.env`; `root` defaults to the repo root. */
export function loadServerEnv(root: string = REPO_ROOT): void {
  loadEnvFile(join(root, ".env"));
}

const DEFAULT_DATABASE_URL = "postgres://adt:adt@localhost:55432/adt";
const DEFAULT_PORT = "8080";
const DEFAULT_BLOB_DIR = ".adt/blobs";

/** `host:port` of a connection string, or "(unparseable)" — never credentials. */
function safeDatabaseHost(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port === "" ? "5432" : parsed.port}`;
  } catch {
    return "(unparseable)";
  }
}

/**
 * A redacted startup summary. It answers "which database, is the LLM wired, is
 * KB export on, where do blobs go" — and **never** prints a secret.
 */
export function formatStartupSummary(env: NodeJS.ProcessEnv = process.env): string {
  const llm = (env.LLM_API_KEY ?? "").trim() !== "";
  const kb = (env.KB_ENDPOINT_URL ?? "").trim() !== "" && (env.KB_TOKEN ?? "").trim() !== "";
  return [
    `database: ${safeDatabaseHost(env.DATABASE_URL ?? DEFAULT_DATABASE_URL)}`,
    `port: ${env.PORT ?? DEFAULT_PORT}`,
    `llm: ${llm ? "configured" : "not configured (no-op planner)"}`,
    `kb export: ${kb ? "configured" : "not configured"}`,
    `blob dir: ${env.BLOB_DATA_DIR ?? DEFAULT_BLOB_DIR}`,
  ].join("\n");
}
