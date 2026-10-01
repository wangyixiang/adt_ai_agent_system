import { app, BrowserWindow } from "electron";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openLedger } from "@adt/client-daemon";

const isSmoke = process.argv.includes("--smoke");

/**
 * Proof that `node:sqlite` (through the daemon's ledger) runs inside Electron's
 * own Node — the one dependency ADR-004's `node:sqlite` choice rests on when the
 * Client becomes a single Electron process (ADR-006). Prints the versions so the
 * floor is recorded, then exits.
 */
function runSmoke(): number {
  const location = join(tmpdir(), `adt-ledger-smoke-${Date.now()}.db`);
  const ledger = openLedger(location);
  ledger.markInFlight("smoke");
  ledger.markDone("smoke", "smoke", { ok: true });
  const state = ledger.get("smoke");
  ledger.close();
  const ok = state?.state === "done";
  process.stdout.write(
    `electron=${process.versions.electron} node=${process.versions.node} ledger=${ok ? "ok" : "FAIL"}\n`,
  );
  return ok ? 0 : 1;
}

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1024,
    height: 720,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl !== undefined) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  }
}

app
  .whenReady()
  .then(async () => {
    if (isSmoke) {
      app.exit(runSmoke());
      return;
    }
    await createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
