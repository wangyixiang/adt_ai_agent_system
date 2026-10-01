import { defineConfig } from "@playwright/test";

/**
 * The desktop smoke: drives the **real Electron app** (built `out/`) against a
 * real Server + the in-process daemon, through login → submit → the four
 * decision cards. The spec starts its own Server (see `smoke/electron.spec.ts`).
 */
export default defineConfig({
  testDir: "./smoke",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: 90_000,
});
