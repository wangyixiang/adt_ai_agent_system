import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Shown as a default in the settings page — not a connection the app picks itself. */
export const DEFAULT_SERVER_URL = "ws://127.0.0.1:8080/ws";

/** What `userData/config.json` may contain; everything is optional. */
export interface StoredConfig {
  serverUrl?: string;
  workspaceRoot?: string;
}

/** The settings the app actually runs with. */
export interface AppConfig {
  serverUrl: string;
  workspaceRoot: string;
  /** False means "the user has not chosen a server yet" — show the settings page. */
  configured: boolean;
}

/** Reads the config file; a missing or malformed one is `null` (first run). */
export function readConfig(path: string): StoredConfig | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const config: StoredConfig = {};
    if (typeof record["serverUrl"] === "string") config.serverUrl = record["serverUrl"];
    if (typeof record["workspaceRoot"] === "string") config.workspaceRoot = record["workspaceRoot"];
    return config;
  } catch {
    return null;
  }
}

/** Writes via a temp file + rename, so a crash cannot leave a half-written config. */
export function writeConfig(path: string, config: StoredConfig): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2));
  renameSync(temporary, path);
}

/**
 * Resolves the effective settings. The **stored** value wins over the
 * environment (env is a development fallback); only when neither has an address
 * is the app "not configured" — the default is displayed, never connected to.
 */
export function effectiveConfig(
  stored: StoredConfig | null,
  env: Record<string, string | undefined>,
  cwd: string,
): AppConfig {
  const serverUrl = (stored?.serverUrl?.trim() ?? "") || (env["ADT_SERVER_URL"] ?? "") || "";
  const workspaceRoot = (stored?.workspaceRoot?.trim() ?? "") || (env["ADT_WORKSPACE"] ?? "") || cwd;
  return {
    serverUrl: serverUrl === "" ? DEFAULT_SERVER_URL : serverUrl,
    workspaceRoot,
    configured: serverUrl !== "",
  };
}
