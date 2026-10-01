/**
 * The IPC contract between the renderer and main (ADR-006): the renderer is a
 * client of the daemon that lives in main, and this is the whole surface. No
 * Node, no Server protocol, no credentials beyond the login call.
 */
import type { Answer } from "@adt/shared";

import type { UiSnapshot } from "./ui";

export const IPC = {
  /** `renderer → main` request/response (`ipcRenderer.invoke`). */
  invoke: "adt:invoke",
  /** `main → renderer` push (`webContents.send`). */
  event: "adt:event",
} as const;

export type RendererRequest =
  | { kind: "snapshot" }
  | { kind: "login"; username: string; secret: string }
  | { kind: "submit"; text: string; attachments: IncomingAttachment[] }
  | { kind: "answer"; askId: string; answer: Answer }
  | { kind: "cancel"; workflowId: string }
  | { kind: "report"; recordId: string; detailLevel?: "summary" | "full" }
  | { kind: "export"; recordId: string; object: "record" | "report" }
  | { kind: "save_text"; suggestedName: string; content: string }
  | { kind: "records"; cursor?: string | null; pageSize?: number }
  | { kind: "record"; id: string };

/**
 * A Record, as the UI sees it — the finished document (`RECORD_SPEC.md` §3),
 * snake_case as stored. The renderer never imports the Server package.
 */
export interface UiRecordSummary {
  problem_short: string;
  terminal_state: string;
  result_short: string;
  duration_ms: number;
}

export interface UiRecordEntry {
  entry_id: string;
  ts: number;
  kind: string;
  ref: Record<string, unknown>;
  narrative: string;
}

export interface UiRecord {
  record_id: string;
  workflow_id: string;
  created_at: number;
  ended_at: number;
  terminal_state: string;
  terminal_reason: string | null;
  user_request: { text: string } & Record<string, unknown>;
  summary: UiRecordSummary;
  entries: UiRecordEntry[];
  final_result: Record<string, unknown>;
}

export interface UiRecordListEntry {
  recordId: string;
  workflowId: string;
  summary: UiRecordSummary;
}

export interface UiRecordList {
  records: UiRecordListEntry[];
  nextCursor: string | null;
}

/** A generated Report (`REPORT_SPEC.md` §4: markdown), or why it failed. */
export type UiReport =
  | { ok: true; markdown: string }
  | { ok: false; errorCode: string; message: string };

/**
 * The outcome of a KB export. `ok` means the endpoint **accepted** it — never
 * that it was indexed (ADR-005 §4).
 */
export interface UiExportResult {
  ok: boolean;
  errorCode: string | null;
  message: string | null;
}

/** The outcome of a "save as": `saved: false` means the human cancelled. */
export interface UiSaveResult {
  saved: boolean;
  path?: string;
}

/** An attachment the renderer hands to main (bytes as base64). */
export interface IncomingAttachment {
  name: string;
  mediaType: string;
  dataBase64: string;
}

/**
 * An attachment as it travels to the Server and is kept in the Record
 * (`RECORD_SPEC.md` v0.10): inline bytes, or a blob reference.
 */
export type UiAttachment = { name: string; media_type: string; size: number; sha256: string } & (
  | { mode: "inline"; data_base64: string }
  | { mode: "blob"; content_ref: string }
);

export type MainEvent = { type: "state"; snapshot: UiSnapshot } | { type: "ui"; event: import("./ui").UiEvent };

/** What preload exposes on `window.adt`. */
export interface AdtBridge {
  snapshot(): Promise<UiSnapshot>;
  login(username: string, secret: string): Promise<void>;
  submit(text: string, attachments: IncomingAttachment[]): Promise<string>;
  answer(askId: string, answer: Answer): Promise<void>;
  cancel(workflowId: string): Promise<void>;
  report(recordId: string, detailLevel?: "summary" | "full"): Promise<UiReport>;
  export(recordId: string, object: "record" | "report"): Promise<UiExportResult>;
  saveText(suggestedName: string, content: string): Promise<UiSaveResult>;
  records(cursor?: string | null, pageSize?: number): Promise<UiRecordList>;
  record(id: string): Promise<UiRecord>;
  onEvent(listener: (event: MainEvent) => void): () => void;
}

export type { UiEvent, UiEventInput, UiSnapshot, UiStep, UiWorkflow, UiEvidenceBlob } from "./ui";
