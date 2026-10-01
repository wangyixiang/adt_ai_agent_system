import type { Answer } from "@adt/shared";

import type { MainEvent, RendererRequest, UiRecord, UiRecordList, UiReport, UiSnapshot } from "../../shared/contract";

/**
 * The main-process side of the IPC contract. Pure logic on purpose: it takes the
 * session's operations as dependencies, so it is testable without Electron. The
 * Electron edges (`ipcMain.handle` / `webContents.send`) live in `main/index.ts`.
 */
export interface BridgeDeps {
  snapshot(): UiSnapshot;
  login(username: string, secret: string): Promise<void>;
  submit(text: string): Promise<string>;
  answer(askId: string, answer: Answer): void;
  cancel(workflowId: string): Promise<void>;
  report(recordId: string, detailLevel?: "summary" | "full"): Promise<UiReport>;
  records(cursor: string | null, pageSize?: number): Promise<UiRecordList>;
  record(id: string): Promise<UiRecord>;
  emit(event: MainEvent): void;
}

export interface Bridge {
  handle(request: RendererRequest): Promise<unknown>;
}

export function createBridge(deps: BridgeDeps): Bridge {
  return {
    async handle(request: RendererRequest): Promise<unknown> {
      switch (request.kind) {
        case "snapshot":
          return deps.snapshot();
        case "login":
          await deps.login(request.username, request.secret);
          return undefined;
        case "submit":
          return deps.submit(request.text);
        case "answer":
          deps.answer(request.askId, request.answer);
          return undefined;
        case "cancel":
          await deps.cancel(request.workflowId);
          return undefined;
        case "report":
          return deps.report(request.recordId, request.detailLevel);
        case "records":
          return deps.records(request.cursor ?? null, request.pageSize);
        case "record":
          return deps.record(request.id);
      }
    },
  };
}
