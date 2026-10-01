import { contextBridge, ipcRenderer } from "electron";

import type {
  AdtBridge,
  MainEvent,
  RendererRequest,
  UiRecord,
  UiRecordList,
  UiSnapshot,
} from "../shared/contract";
import { IPC } from "../shared/contract";

/**
 * The whole surface the renderer gets: a narrow set of methods, nothing else.
 * No Node, no daemon, no Server protocol — every call is one IPC request.
 */
const bridge: AdtBridge = {
  snapshot: () =>
    ipcRenderer.invoke(IPC.invoke, { kind: "snapshot" } satisfies RendererRequest) as Promise<UiSnapshot>,

  login: (username, secret) =>
    ipcRenderer.invoke(IPC.invoke, {
      kind: "login",
      username,
      secret,
    } satisfies RendererRequest) as Promise<void>,

  submit: (text) =>
    ipcRenderer.invoke(IPC.invoke, { kind: "submit", text } satisfies RendererRequest) as Promise<string>,

  answer: (askId, answer) =>
    ipcRenderer.invoke(IPC.invoke, { kind: "answer", askId, answer } satisfies RendererRequest) as Promise<void>,

  cancel: (workflowId) =>
    ipcRenderer.invoke(IPC.invoke, { kind: "cancel", workflowId } satisfies RendererRequest) as Promise<void>,

  records: (cursor, pageSize) =>
    ipcRenderer.invoke(IPC.invoke, {
      kind: "records",
      cursor: cursor ?? null,
      ...(pageSize === undefined ? {} : { pageSize }),
    } satisfies RendererRequest) as Promise<UiRecordList>,

  record: (id) =>
    ipcRenderer.invoke(IPC.invoke, { kind: "record", id } satisfies RendererRequest) as Promise<UiRecord>,

  onEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: MainEvent): void => listener(event);
    ipcRenderer.on(IPC.event, handler);
    return () => {
      ipcRenderer.off(IPC.event, handler);
    };
  },
};

contextBridge.exposeInMainWorld("adt", bridge);
