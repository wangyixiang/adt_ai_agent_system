import { existsSync } from "node:fs";
import { join } from "node:path";

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

/** Loads `<cwd>/.env` (the repo root when the server is run from there). */
export function loadServerEnv(cwd: string = process.cwd()): void {
  loadEnvFile(join(cwd, ".env"));
}
