import { createHash, randomUUID } from "node:crypto";

import { ClientDaemon, downloadBlob, openLedger, openSessionStore, uploadBlob } from "@adt/client-daemon";

import type { UiAttachment, UiEvent, UiEventInput, UiRecord, UiRecordList, UiRecordSummary, UiReport, UiExportResult, UiSnapshot, UiBlobPreview, IncomingAttachment } from "../../shared/contract";
import { checkAttachments, normalizeMediaType, planAttachment } from "./attachments";
import { classifyBlob } from "./blobs";
import { createDecisionHost } from "./host";
import { createProjection } from "./projection";

export interface SessionOptions {
  serverUrl: string;
  workspaceRoot: string;
  clientInfo: { name: string; platform: string };
  /** Where the idempotency ledger lives (an absolute path under `userData`). */
  ledgerPath: string;
  /** Where the logical session is remembered across reconnects. */
  sessionPath: string;
  /** Push one event to the renderer (main wires this to `webContents.send`). */
  emit(event: import("../../shared/contract").MainEvent): void;
}

export interface Session {
  snapshot(): UiSnapshot;
  login(username: string, secret: string): Promise<void>;
  submit(text: string, attachments?: IncomingAttachment[]): Promise<string>;
  /** Answer one of the four decisions (manual-action `details.attachments` are built here). */
  answer(askId: string, body: unknown): Promise<void>;
  /** Ask the Server to cancel a run; resolves once the cancel is acknowledged. */
  cancel(workflowId: string): Promise<void>;
  /** Ask the Server to generate a Report from a Record; the content is the Server's. */
  report(recordId: string, detailLevel?: "summary" | "full"): Promise<UiReport>;
  /** Ask the Server to export a Record/Report to the configured KB (ADR-005). */
  export(recordId: string, object: "record" | "report"): Promise<UiExportResult>;
  /** Fetch a blob and decide how to show it (already sha256-verified). */
  blobPreview(contentRef: string, mediaType: string): Promise<UiBlobPreview>;
  /** Fetch a blob's raw bytes, e.g. for a save dialog. */
  blobBytes(contentRef: string): Promise<Uint8Array>;
  /** List this user's finished Records (the Server filters by owner). */
  records(cursor?: string | null, pageSize?: number): Promise<UiRecordList>;
  /** One finished Record, by id. */
  record(id: string): Promise<UiRecord>;
  /** Is any workflow still live (not terminated)? */
  isRunning(): boolean;
  close(): Promise<void>;
}

/** Build wire attachments: inline at/below the threshold, over blob above it. */
async function buildAttachments(
  daemon: ClientDaemon,
  incoming: readonly IncomingAttachment[],
): Promise<UiAttachment[]> {
  const built: UiAttachment[] = [];
  for (const item of incoming) {
    const bytes = Buffer.from(item.dataBase64, "base64");
    const mediaType = normalizeMediaType(item.mediaType);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (planAttachment(bytes).mode === "inline") {
      built.push({
        name: item.name,
        media_type: mediaType,
        size: bytes.length,
        sha256,
        mode: "inline",
        data_base64: item.dataBase64,
      });
    } else {
      const ref = await uploadBlob(
        { connection: daemon.connection },
        { name: item.name, mediaType, bytes },
      );
      built.push({
        name: ref.name ?? item.name,
        media_type: ref.media_type,
        size: ref.size,
        sha256: ref.sha256,
        mode: "blob",
        content_ref: ref.content_ref,
      });
    }
  }
  return built;
}

/** A manual-action answer may carry `details.attachments`; build those bytes here. */
async function prepareAnswer(daemon: ClientDaemon, body: unknown): Promise<unknown> {
  if (body === null || typeof body !== "object") return body;
  const answer = body as Record<string, unknown>;
  if (answer["kind"] !== "manual_action") return body;
  const details = answer["details"];
  if (details === null || typeof details !== "object") return body;
  const detail = details as Record<string, unknown>;
  if (!Array.isArray(detail["attachments"])) return body;
  const incoming = detail["attachments"] as IncomingAttachment[];
  // The same guardrail as `submit`: `details` reuses the attachment mechanism.
  const allowed = checkAttachments(incoming);
  if (!allowed.ok) throw new Error(`${allowed.code}: ${allowed.message}`);
  const attachments = await buildAttachments(daemon, incoming);
  return { ...answer, details: { ...detail, attachments } };
}

/**
 * The in-process daemon, seen through a UI-shaped lens: a snapshot plus an event
 * stream, with the four decisions answered by the renderer. ADR-006 keeps the
 * daemon in main; this is the seam the renderer talks to.
 */
export function createSession(options: SessionOptions): Session {
  const projection = createProjection();
  const host = createDecisionHost((ask, workflowId) =>
    emitUi(projection.observeAsk(ask, workflowId)),
  );
  let daemon: ClientDaemon | null = null;
  let nextEventId = 1;

  function emitUi(input: UiEventInput): void {
    options.emit({ type: "ui", event: { ...input, id: nextEventId++ } as UiEvent });
  }

  return {
    snapshot() {
      return projection.snapshot(daemon);
    },

    isRunning() {
      return projection.snapshot(daemon).workflows.some((workflow) => workflow.terminalState === null);
    },

    async login(username, secret) {
      const connected = await ClientDaemon.connect({
        url: options.serverUrl,
        credentials: { username, secret },
        clientInfo: options.clientInfo,
        workspaceRoot: options.workspaceRoot,
        ledger: openLedger(options.ledgerPath),
        sessionStore: openSessionStore(options.sessionPath),
        onConfirmationRequired: host.onConfirmationRequired,
        onUserInput: host.onUserInput,
        onResourceConflict: host.onResourceConflict,
        onStepStatus: (update) => emitUi(projection.observeStepStatus(update)),
      });
      daemon = connected;

      // The fourth decision: the Server proposes "solved?", only the human
      // disposes. `workflow_id` is on the envelope, not in this payload.
      connected.connection.on("workflow.completion_candidate", (env) => {
        const payload = env.payload as { summary?: string; evidence_refs?: string[] };
        void (async () => {
          const decision = await host.completion({
            workflowId: env.workflow_id ?? "",
            summary: payload.summary ?? "",
            evidenceRefs: payload.evidence_refs ?? [],
          });
          // `feedback` must reach the Server: on `not_solved` it is the text the
          // re-plan is built from (`PROTOCOL_SPEC.md` §7.2).
          connected.connection.send("workflow.completion_response", {
            workflow_id: env.workflow_id,
            resolution: decision.resolution,
            ...(decision.feedback === undefined ? {} : { feedback: decision.feedback }),
          });
        })();
      });

      for (const type of ["step.dispatch", "workflow.terminated", "protocol.error"]) {
        connected.connection.on(type, (env) => {
          const event = projection.observe(type, env);
          if (event !== null) emitUi(event);
        });
      }

      options.emit({ type: "state", snapshot: projection.snapshot(daemon) });
    },

    async submit(text, attachments = []) {
      if (daemon === null) throw new Error("not_logged_in: not logged in");
      const allowed = checkAttachments(attachments);
      if (!allowed.ok) throw new Error(`${allowed.code}: ${allowed.message}`);

      const built = await buildAttachments(daemon, attachments);

      const created = await daemon.connection.request(
        "workflow.request",
        {
          client_request_id: randomUUID(),
          user_request: { text, attachments: built, context: {} },
        },
        "workflow.created",
      );
      const workflowId = String(created["workflow_id"] ?? "");
      // Only this call knows the text the human typed; the Server's reply does
      // not carry it back.
      projection.noteRequest(workflowId, text);
      emitUi({ type: "workflow.created", workflowId, userRequest: { text }, attachments: built });
      return workflowId;
    },

    async answer(askId, body) {
      if (daemon === null) throw new Error("not_logged_in: not logged in");
      const outcome = host.answer(askId, await prepareAnswer(daemon, body));
      if (!outcome.ok) throw new Error(`${outcome.code}: ${outcome.message}`);
      const event = projection.noteAnswered(askId, outcome.answer);
      if (event !== null) emitUi(event);
    },

    async cancel(workflowId) {
      if (daemon === null) throw new Error("not_logged_in: not logged in");
      // No `reason`: the UI asks once and only says "cancel" (design §2/§7).
      const ack = (await daemon.connection.request(
        "workflow.cancel_request",
        { workflow_id: workflowId },
        "workflow.cancel_ack",
      )) as { workflow_status?: unknown };
      // "CANCELLING" means a non-interruptible step is finishing; "CANCELLED"
      // means it is already over, so there is no convergence window to show.
      projection.observeCancelAck(workflowId, String(ack.workflow_status ?? ""));
      options.emit({ type: "state", snapshot: projection.snapshot(daemon) });
    },

    async report(recordId, detailLevel = "full") {
      if (daemon === null) throw new Error("not_logged_in: not logged in");
      const result = (await daemon.connection.request(
        "report.generate_request",
        { record_id: recordId, options: { detail_level: detailLevel } },
        "report.generate_result",
      )) as { status?: unknown; report?: { format?: unknown; content?: unknown } | null; error_code?: unknown; message?: unknown };

      const report = result.report ?? null;
      if (result.status === "ok" && report !== null && report.format === "markdown" && typeof report.content === "string") {
        return { ok: true as const, markdown: report.content };
      }
      return {
        ok: false as const,
        errorCode: String(result.error_code ?? "generation_failed"),
        message: String(result.message ?? ""),
      };
    },

    async export(recordId, object) {
      if (daemon === null) throw new Error("not_logged_in: not logged in");
      const result = (await daemon.connection.request(
        "record.export_request",
        { record_id: recordId, object, target: "knowledge_base" },
        "record.export_result",
      )) as { status?: unknown; error_code?: unknown; message?: unknown };
      return {
        ok: result.status === "ok",
        errorCode: typeof result.error_code === "string" ? result.error_code : null,
        message: typeof result.message === "string" ? result.message : null,
      };
    },

    async blobPreview(contentRef, mediaType) {
      if (daemon === null) throw new Error("not_logged_in: not logged in");
      const bytes = await downloadBlob({ connection: daemon.connection }, contentRef);
      return classifyBlob(bytes, mediaType);
    },

    async blobBytes(contentRef) {
      if (daemon === null) throw new Error("not_logged_in: not logged in");
      return downloadBlob({ connection: daemon.connection }, contentRef);
    },

    async records(cursor = null, pageSize = 100) {
      if (daemon === null) throw new Error("not_logged_in: not logged in");
      const payload = (await daemon.connection.request(
        "record.list_request",
        { filters: {}, cursor, page_size: pageSize },
        "record.list_response",
      )) as {
        records?: Array<{ record_id: string; workflow_id: string; summary: UiRecordSummary }>;
        next_cursor?: string | null;
      };
      return {
        records: (payload.records ?? []).map((row) => ({
          recordId: row.record_id,
          workflowId: row.workflow_id,
          summary: row.summary,
        })),
        nextCursor: payload.next_cursor ?? null,
      };
    },

    async record(id) {
      if (daemon === null) throw new Error("not_logged_in: not logged in");
      const payload = (await daemon.connection.request(
        "record.get_request",
        { record_id: id },
        "record.get_response",
      )) as { record: UiRecord };
      return payload.record;
    },

    async close() {
      host.abandon();
      await daemon?.close();
    },
  };
}
