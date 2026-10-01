import { app, BrowserWindow, ipcMain } from "electron";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openLedger } from "@adt/client-daemon";

import type { RendererRequest, UiSnapshot } from "../shared/contract";
import { IPC } from "../shared/contract";
import { createBridge, type Bridge } from "./core/bridge";

const isSmoke = process.argv.includes("--smoke");

const EMPTY_SNAPSHOT: UiSnapshot = {
  connection: "disconnected",
  userId: null,
  capabilities: [],
  workflows: [],
};

/**
 * The main-process bridge. It is wired to the real in-process daemon session in
 * a later task; here it only proves the channel: it answers with an empty
 * snapshot and refuses commands, so the renderer never sees a half-built session.
 */
function createMainBridge(): Bridge {
  return createBridge({
    snapshot: () => EMPTY_SNAPSHOT,
    login: async () => {
      throw new Error("login is not wired yet");
    },
    submit: async () => {
      throw new Error("submit is not wired yet");
    },
    answer: () => {
      throw new Error("answer is not wired yet");
    },
    emit: (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC.event, event);
      }
    },
  });
}

/**
 * Proof that `node:sqlite` (through the daemon's ledger) runs inside Electron's
 * own Node — the dependency ADR-006's Client form rests on. Prints the versions
 * so the floor is recorded, then exits.
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
    webPreferences: {
      preload: fileURLToPath(new URL("../preload/index.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devServerUrl !== undefined) {
    await window.loadURL(devServerUrl);
  } else {
    await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));
  }
}

const bridge = createMainBridge();
ipcMain.handle(IPC.invoke, (_event, request: RendererRequest) => bridge.handle(request));

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
