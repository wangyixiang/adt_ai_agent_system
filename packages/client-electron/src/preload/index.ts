import { contextBridge, ipcRenderer } from "electron";

import type {
  AdtBridge,
  IncomingAttachment,
  MainEvent,
  RendererRequest,
  UiBlobPreview,
  UiConfig,
  UiExportResult,
  UiRecord,
  UiRecordList,
  UiReport,
  UiSaveResult,
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

  submit: (text, attachments) =>
    ipcRenderer.invoke(IPC.invoke, { kind: "submit", text, attachments } satisfies RendererRequest) as Promise<string>,

  answer: (askId, answer) =>
    ipcRenderer.invoke(IPC.invoke, { kind: "answer", askId, answer } satisfies RendererRequest) as Promise<void>,

  cancel: (workflowId) =>
    ipcRenderer.invoke(IPC.invoke, { kind: "cancel", workflowId } satisfies RendererRequest) as Promise<void>,

  report: (recordId, detailLevel) =>
    ipcRenderer.invoke(IPC.invoke, {
      kind: "report",
      recordId,
      ...(detailLevel === undefined ? {} : { detailLevel }),
    } satisfies RendererRequest) as Promise<UiReport>,

  export: (recordId, object) =>
    ipcRenderer.invoke(IPC.invoke, {
      kind: "export",
      recordId,
      object,
    } satisfies RendererRequest) as Promise<UiExportResult>,

  saveText: (suggestedName, content) =>
    ipcRenderer.invoke(IPC.invoke, {
      kind: "save_text",
      suggestedName,
      content,
    } satisfies RendererRequest) as Promise<UiSaveResult>,

  blobPreview: (contentRef, mediaType) =>
    ipcRenderer.invoke(IPC.invoke, { kind: "blob_preview", contentRef, mediaType } satisfies RendererRequest) as Promise<UiBlobPreview>,

  blobSave: (contentRef, mediaType, suggestedName) =>
    ipcRenderer.invoke(IPC.invoke, {
      kind: "blob_save",
      contentRef,
      mediaType,
      ...(suggestedName === undefined ? {} : { suggestedName }),
    } satisfies RendererRequest) as Promise<UiSaveResult>,

  configGet: () =>
    ipcRenderer.invoke(IPC.invoke, { kind: "config_get" } satisfies RendererRequest) as Promise<UiConfig>,

  configSet: (serverUrl, workspaceRoot) =>
    ipcRenderer.invoke(IPC.invoke, {
      kind: "config_set",
      serverUrl,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    } satisfies RendererRequest) as Promise<UiConfig>,

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
