import { randomUUID } from "node:crypto";

import { ClientDaemon, openLedger, openSessionStore } from "@adt/client-daemon";

import type { UiEvent, UiEventInput, UiRecord, UiRecordList, UiRecordSummary, UiReport, UiExportResult, UiSnapshot } from "../../shared/contract";
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
  submit(text: string): Promise<string>;
  answer(askId: string, body: unknown): void;
  /** Ask the Server to cancel a run; resolves once the cancel is acknowledged. */
  cancel(workflowId: string): Promise<void>;
  /** Ask the Server to generate a Report from a Record; the content is the Server's. */
  report(recordId: string, detailLevel?: "summary" | "full"): Promise<UiReport>;
  /** Ask the Server to export a Record/Report to the configured KB (ADR-005). */
  export(recordId: string, object: "record" | "report"): Promise<UiExportResult>;
  /** List this user's finished Records (the Server filters by owner). */
  records(cursor?: string | null, pageSize?: number): Promise<UiRecordList>;
  /** One finished Record, by id. */
  record(id: string): Promise<UiRecord>;
  /** Is any workflow still live (not terminated)? */
  isRunning(): boolean;
  close(): Promise<void>;
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

    async submit(text) {
      if (daemon === null) throw new Error("not logged in");
      const created = await daemon.connection.request(
        "workflow.request",
        {
          client_request_id: randomUUID(),
          user_request: { text, attachments: [], context: {} },
        },
        "workflow.created",
      );
      const workflowId = String(created["workflow_id"] ?? "");
      // Only this call knows the text the human typed; the Server's reply does
      // not carry it back.
      projection.noteRequest(workflowId, text);
      emitUi({ type: "workflow.created", workflowId, userRequest: { text } });
      return workflowId;
    },

    answer(askId, body) {
      const outcome = host.answer(askId, body);
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
