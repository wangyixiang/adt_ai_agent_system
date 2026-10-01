import { app, BrowserWindow, dialog, ipcMain, type Tray } from "electron";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openLedger } from "@adt/client-daemon";

import type { MainEvent, RendererRequest } from "../shared/contract";
import { IPC } from "../shared/contract";
import { createBridge } from "./core/bridge";
import { createSession, type Session } from "./core/session";
import { createLifecycle } from "./lifecycle";
import { createTray } from "./tray";

const isSmoke = process.argv.includes("--smoke");

/** Set once the app is really leaving (tray quit), so the window may close. */
let isQuitting = false;
/** Keep the tray referenced; a GC'd tray icon disappears. */
let tray: Tray | null = null;

/**
 * Proof that `node:sqlite` (through the daemon's ledger) runs inside Electron's
 * own Node. Prints the versions, then exits.
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

async function createWindow(): Promise<BrowserWindow> {
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
  return window;
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
      // The Server address is configuration, not something the UI types.
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
      cancel: (workflowId) => session.cancel(workflowId),
      report: (recordId, detailLevel) => session.report(recordId, detailLevel),
      export: (recordId, object) => session.export(recordId, object),
      records: (cursor, pageSize) => session.records(cursor, pageSize),
      record: (id) => session.record(id),
      emit: broadcast,
    });
    ipcMain.handle(IPC.invoke, (_event, request: RendererRequest) => bridge.handle(request));

    const window = await createWindow();
    const lifecycle = createLifecycle({
      hideWindow: () => window.hide(),
      hasRunningWorkflow: () => session.isRunning(),
      confirmQuit: async () => {
        const { response } = await dialog.showMessageBox(window, {
          type: "warning",
          buttons: ["退出", "取消"],
          defaultId: 1,
          cancelId: 1,
          message: "有正在进行的诊断。退出会在本机中断它（服务器侧稍后回收）。确定退出吗？",
        });
        return response === 0;
      },
      closeDaemon: () => session.close(),
      quit: () => {
        isQuitting = true;
        app.quit();
      },
    });

    // Closing the window keeps the daemon (and any run) alive: hide instead.
    window.on("close", (event) => {
      if (isQuitting) return;
      event.preventDefault();
      lifecycle.onWindowClose();
    });

    tray = createTray({
      onShow: () => window.show(),
      onQuit: () => void lifecycle.onTrayQuit(),
    });

    app.on("before-quit", () => {
      isQuitting = true;
    });
    app.on("activate", () => window.show());
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    app.exit(1);
  });

// The tray owns the app's lifetime now: no windows does not mean "quit".
app.on("window-all-closed", () => undefined);
