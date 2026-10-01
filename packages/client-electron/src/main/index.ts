import { app, BrowserWindow, ipcMain } from "electron";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openLedger } from "@adt/client-daemon";

import type { MainEvent, RendererRequest } from "../shared/contract";
import { IPC } from "../shared/contract";
import { createBridge } from "./core/bridge";
import { createSession, type Session } from "./core/session";

const isSmoke = process.argv.includes("--smoke");

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

function broadcast(event: MainEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(IPC.event, event);
  }
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

app
  .whenReady()
  .then(async () => {
    if (isSmoke) {
      app.exit(runSmoke());
      return;
    }

    const userData = app.getPath("userData");
    const session: Session = createSession({
      // The Server address is configuration, not something the UI types
      // (ADR-006 §Decision 1).
      serverUrl: process.env["ADT_SERVER_URL"] ?? "ws://127.0.0.1:8080/ws",
      workspaceRoot: process.env["ADT_WORKSPACE"] ?? process.cwd(),
      clientInfo: { name: "adt-client-electron", platform: process.platform },
      ledgerPath: join(userData, "ledger.db"),
      sessionPath: join(userData, "session.json"),
      emit: broadcast,
    });

    const bridge = createBridge({
      snapshot: () => session.snapshot(),
      login: (username, secret) => session.login(username, secret),
      submit: (text) => session.submit(text),
      answer: (askId, answer) => session.answer(askId, answer),
      emit: broadcast,
    });
    ipcMain.handle(IPC.invoke, (_event, request: RendererRequest) => bridge.handle(request));

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
