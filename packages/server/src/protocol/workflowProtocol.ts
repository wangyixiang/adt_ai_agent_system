import { newMessageId, nowUtcIso, PROTOCOL_VERSION, validateJsonSchema, type Envelope, type JsonSchema } from "@adt/shared";
import { randomUUID } from "node:crypto";
import type { SessionManager, Session } from "../session/sessionManager";
import type { Connection } from "../ws/connection";
import { sendError } from "../ws/errors";
import type { MessageRouter } from "../ws/messageRouter";
import type { RecordService } from "../record/service";
import {
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  type RecordListFilters,
  type RecordStore,
} from "../record/store";
import { generateReport, resolveDetailLevel } from "../report/generate";
import type { StepStatusUpdate, WorkflowEngine } from "../workflow/engine";
import type { WorkflowOrchestrator } from "../workflow/orchestrator";
import { isTerminalWorkflow } from "../workflow/stateMachine";
import type { StepSnapshot, WorkflowSnapshot, WorkflowStore } from "../workflow/store";
import type { WorkflowEventKind } from "../workflow/store";
import type { Planner } from "../workflow/planner";

export interface WorkflowProtocolDeps {
  router: MessageRouter;
  sessions: SessionManager;
  engine: WorkflowEngine;
  store: WorkflowStore;
  orchestrator: WorkflowOrchestrator;
  planner: Planner;
  records: RecordService;
  recordStore: RecordStore;
}

export interface WorkflowProtocolHandle {
  /**
   * Advances a workflow whose trigger did not come from a client message (a
   * step timed out, for instance) and pushes the outcome to the owning
   * session's live connection when there is one.
   */
  advance(workflowId: string): Promise<void>;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  (value ?? {}) as Record<string, unknown>;

/** Maps a protocol `step.status` payload onto an engine update, or null. */
export function toStepStatusUpdate(payload: Record<string, unknown>): StepStatusUpdate | null {
  // `null` is not evidence; only a real value counts.
  const evidence = payload.evidence ?? undefined;
  switch (payload.status) {
    case "RUNNING":
      return { state: "RUNNING" };
    case "WAITING": {
      const code = (asRecord(payload.wait_reason).code ?? payload.wait_reason) as unknown;
      const human = code === "user_input" || code === "user_confirmation";
      return { state: "WAITING", waitClass: human ? "human" : "execution" };
    }
    case "COMPLETED":
      return evidence === undefined
        ? { state: "COMPLETED" }
        : { state: "COMPLETED", evidence };
    case "FAILED": {
      const reason = asRecord(payload.fail_reason);
      const code = reason.code ?? payload.fail_reason;
      const failReason =
        typeof code === "string"
          ? { code, ...(typeof reason.message === "string" ? { message: reason.message } : {}) }
          : undefined;
      return {
        state: "FAILED",
        ...(evidence === undefined ? {} : { evidence }),
        ...(failReason === undefined ? {} : { failReason }),
      };
    }
    case "REJECTED": {
      const reason = asRecord(payload.reject_reason);
      const code = reason.code ?? payload.reject_reason;
      const rejectReason =
        typeof code === "string"
          ? { code, ...(typeof reason.message === "string" ? { message: reason.message } : {}) }
          : undefined;
      return rejectReason === undefined ? { state: "REJECTED" } : { state: "REJECTED", rejectReason };
    }
    case "UNKNOWN":
      return { state: "UNKNOWN" };
    default:
      return null;
  }
}

export interface StepDispatchPayload {
  workflow_id: string;
  step_id: string;
  objective: string;
  capability: string;
  input: Record<string, unknown>;
  expected_output: null;
  requires_confirmation: boolean;
  idempotency_key: string | null;
}

/** The `step.dispatch` wire payload for a step; also used by `session.resume`. */
export function stepDispatchPayload(step: StepSnapshot): StepDispatchPayload {
  return {
    workflow_id: step.workflowId,
    step_id: step.id,
    objective: step.objective,
    capability: step.capability,
    input: step.input,
    expected_output: null,
    requires_confirmation: step.sideEffect,
    idempotency_key: step.idempotencyKey,
  };
}

/**
 * CAPABILITY_SPEC.md §5.2: a COMPLETED step's `evidence.result` must satisfy the
 * output schema that was declared when the step was dispatched (frozen on the
 * step, §4.1); an invalid or missing result is recorded as
 * `FAILED(invalid_output)` and the rejected evidence is preserved for the
 * Record. A step with no declared schema does not block (§5.4) — it warns.
 */
async function withOutputValidation(
  conn: Connection,
  engine: WorkflowEngine,
  workflowId: string,
  stepId: string,
  update: StepStatusUpdate,
): Promise<StepStatusUpdate> {
  if (update.state !== "COMPLETED") return update;

  const step = await engine.getStep(stepId);
  // Never read a schema off a step that belongs to another workflow.
  if (!step || step.workflowId !== workflowId) return update;

  const schema = step.outputSchema as JsonSchema | null | undefined;
  if (!schema) {
    conn.warn(`no output_schema for step ${stepId}; skipping evidence validation`);
    return update;
  }

  const invalid = (reason: string): StepStatusUpdate => {
    conn.warn(`invalid evidence for step ${stepId}: ${reason}`);
    return {
      state: "FAILED",
      evidence: update.evidence,
      failReason: { code: "invalid_output" },
    };
  };

  const result = (update.evidence as { result?: unknown } | undefined)?.result;
  if (result === undefined) return invalid("evidence has no result");

  const validation = validateJsonSchema(schema, result);
  return validation.valid ? update : invalid(validation.errors.join("; "));
}

export function registerWorkflowProtocol(deps: WorkflowProtocolDeps): WorkflowProtocolHandle {
  const { router, sessions, engine, store, orchestrator, planner, records, recordStore } = deps;
  const notified = new Set<string>();

  const send = (
    conn: Connection,
    session: Session,
    type: string,
    workflowId: string | null,
    payload: unknown,
    inReplyTo: string | null = null,
  ): void => {
    conn.send({
      protocol_version: PROTOCOL_VERSION,
      message_id: newMessageId(),
      session_id: session.id,
      workflow_id: workflowId,
      user_id: session.userId,
      type,
      ts: nowUtcIso(),
      in_reply_to: inReplyTo,
      payload,
    });
  };

  /** Session-scoped ownership (ADR-003 §3/§5). */
  const ownedWorkflow = async (
    workflowId: unknown,
    session: Session,
  ): Promise<WorkflowSnapshot | null> => {
    if (typeof workflowId !== "string") return null;
    const workflow = await engine.get(workflowId);
    if (!workflow || workflow.sessionId !== session.id) return null;
    return workflow;
  };

  const sendStepDispatch = (conn: Connection, session: Session, step: StepSnapshot): void => {
    send(conn, session, "step.dispatch", step.workflowId, stepDispatchPayload(step));
  };

  /** Records a protocol-layer event (no state change). */
  const recordEvent = async (
    workflowId: string,
    kind: WorkflowEventKind,
    payload: unknown,
  ): Promise<void> => {
    const workflow = await engine.get(workflowId);
    if (!workflow) return;
    await store.saveWorkflowWithEvents(workflow, [
      { id: `ev_${randomUUID()}`, workflowId, kind, ts: Date.now(), payload },
    ]);
  };

  /**
   * Persist the Record FIRST, then notify (PROTOCOL_SPEC.md §7.4 / D-D3).
   * Exactly one `workflow.terminated` per workflow, and a finalize failure
   * still notifies (with `record_id = null`).
   */
  const finalizeIfTerminated = async (
    conn: Connection,
    session: Session,
    workflowId: string,
  ): Promise<void> => {
    const workflow = await engine.get(workflowId);
    if (!workflow || !isTerminalWorkflow(workflow.state)) return;
    if (notified.has(workflowId)) return;

    let result;
    try {
      result = await records.finalize(workflowId);
    } catch (error) {
      conn.warn(`record finalize failed for ${workflowId}: ${(error as Error).message}`);
      result = { recordId: null, persistenceFailed: true };
    }

    // Mark only once we are actually about to notify, so a throw above does
    // not permanently suppress the termination message.
    notified.add(workflowId);

    send(conn, session, "workflow.terminated", workflowId, {
      workflow_id: workflowId,
      terminal_state: workflow.state,
      terminal_reason: workflow.terminalReason,
      record_id: result.recordId,
      record_persistence_failed: result.persistenceFailed,
    });
  };

  const advanceAndPush = async (
    conn: Connection,
    session: Session,
    workflowId: string,
  ): Promise<void> => {
    try {
      const result = await orchestrator.advance(workflowId);
      if (result.dispatched) {
        sendStepDispatch(conn, session, result.dispatched);
      } else if (result.completionCandidate) {
        await recordEvent(workflowId, "completion_candidate", {
          summary: result.completionCandidate.summary,
          evidenceRefs: result.completionCandidate.evidenceRefs,
        });
        send(conn, session, "workflow.completion_candidate", workflowId, {
          summary: result.completionCandidate.summary,
          evidence_refs: result.completionCandidate.evidenceRefs,
        });
      }
    } catch (error) {
      // A guardrail breach terminates the workflow and THEN throws; other
      // failures leave it non-terminal, so finalize below is a safe no-op.
      conn.warn(`advance failed for ${workflowId}: ${(error as Error).message}`);
    }
    await finalizeIfTerminated(conn, session, workflowId);
  };

  router.register("workflow.request", async ({ conn, session }, env) => {
    if (!session) return;
    const payload = asRecord(env.payload);
    const request = asRecord(payload.user_request);
    const text = request.text;

    if (typeof payload.client_request_id !== "string" || typeof text !== "string") {
      sendError(conn, session, "malformed_payload", "invalid workflow.request", env.message_id);
      return;
    }

    // Idempotent create (PROTOCOL_SPEC.md §7.1): a replayed client_request_id
    // returns the workflow it already created, without re-planning.
    const existingId = sessions.findClientRequest(session.id, payload.client_request_id);
    if (existingId) {
      const existing = await engine.get(existingId);
      send(
        conn,
        session,
        "workflow.created",
        existingId,
        { workflow_id: existingId, workflow_status: existing?.state ?? "CREATED" },
        env.message_id,
      );
      return;
    }

    if (!sessions.tryReserveClientRequest(session.id, payload.client_request_id)) {
      conn.warn(`duplicate workflow.request in flight: ${payload.client_request_id}`);
      return;
    }

    const capabilities = [...session.capabilities.asMap().values()];
    let workflow: WorkflowSnapshot;
    try {
      const criteria = await planner.initialCriteria(request, capabilities).catch((error) => {
        conn.warn(`initial criteria failed: ${(error as Error).message}`);
        return { mode: "open" as const, revision: 0 };
      });
      workflow = await engine.create(session.userId, session.id, request, criteria);
      sessions.rememberClientRequest(session.id, payload.client_request_id, workflow.id);
    } catch (error) {
      // Release the reservation so a retry with the same id can succeed.
      sessions.forgetClientRequest(session.id, payload.client_request_id);
      throw error;
    }

    send(
      conn,
      session,
      "workflow.created",
      workflow.id,
      { workflow_id: workflow.id, workflow_status: workflow.state },
      env.message_id,
    );
    await advanceAndPush(conn, session, workflow.id);
  });

  router.register("step.status", async ({ conn, session }, env) => {
    if (!session) return;
    const payload = asRecord(env.payload);
    const workflowId = payload.workflow_id;

    const workflow = await ownedWorkflow(workflowId, session);
    if (!workflow) {
      sendError(conn, session, "unknown_workflow", "unknown workflow", env.message_id);
      return;
    }

    const update = toStepStatusUpdate(payload);
    if (typeof payload.step_id !== "string" || !update) {
      sendError(conn, session, "malformed_payload", "invalid step.status", env.message_id);
      return;
    }

    const effective = await withOutputValidation(conn, engine, workflow.id, payload.step_id, update);

    try {
      await engine.applyStepStatus(workflow.id, payload.step_id, effective);
    } catch (error) {
      // An unknown step id is a protocol error, not a silent hang.
      if (error instanceof Error && /unknown step/i.test(error.message)) {
        sendError(conn, session, "unknown_step", "unknown step", env.message_id);
        return;
      }
      throw error;
    }
    await advanceAndPush(conn, session, workflow.id);
  });

  router.register("workflow.completion_response", async ({ conn, session }, env) => {
    if (!session) return;
    const payload = asRecord(env.payload);

    const workflow = await ownedWorkflow(payload.workflow_id, session);
    if (!workflow) {
      sendError(conn, session, "unknown_workflow", "unknown workflow", env.message_id);
      return;
    }

    const resolution = payload.resolution;
    if (resolution !== "solved" && resolution !== "not_solved") {
      sendError(conn, session, "malformed_payload", "invalid resolution", env.message_id);
      return;
    }

    await engine.confirmCompletion(
      workflow.id,
      resolution,
      typeof payload.feedback === "string" ? payload.feedback : undefined,
    );
    await advanceAndPush(conn, session, workflow.id);
  });

  router.register("workflow.cancel_request", async ({ conn, session }, env) => {
    if (!session) return;
    const payload = asRecord(env.payload);

    const workflow = await ownedWorkflow(payload.workflow_id, session);
    if (!workflow) {
      sendError(conn, session, "unknown_workflow", "unknown workflow", env.message_id);
      return;
    }

    const updated = await engine.cancel(
      workflow.id,
      typeof payload.reason === "string" ? payload.reason : "user_cancelled",
    );

    send(
      conn,
      session,
      "workflow.cancel_ack",
      workflow.id,
      { workflow_id: workflow.id, workflow_status: updated.state },
      env.message_id,
    );
    await finalizeIfTerminated(conn, session, workflow.id);
  });

  // Kept so the module owns its store dependency explicitly.
  void store;

  // ---- Record query (PROTOCOL_SPEC.md §10) --------------------------------

  router.register("record.list_request", async ({ conn, session }, env) => {
    if (!session) return;
    const payload = asRecord(env.payload);
    const raw = asRecord(payload.filters);

    const filters: RecordListFilters = {};
    const range = asRecord(raw.time_range);
    if (range.from !== undefined || range.to !== undefined) {
      const from = Date.parse(String(range.from));
      const to = Date.parse(String(range.to));
      if (!Number.isFinite(from) || !Number.isFinite(to)) {
        sendError(conn, session, "malformed_payload", "invalid time_range", env.message_id);
        return;
      }
      filters.timeRange = { from, to };
    }
    if (typeof raw.keyword === "string") filters.keyword = raw.keyword;
    if (typeof raw.terminal_state === "string") filters.terminalState = raw.terminal_state;

    const cursor = typeof payload.cursor === "string" ? payload.cursor : null;
    const pageSize =
      typeof payload.page_size === "number" ? payload.page_size : DEFAULT_PAGE_SIZE;

    let page;
    try {
      page = await recordStore.listByOwner(session.userId, filters, cursor, pageSize);
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        sendError(conn, session, "malformed_payload", "invalid cursor", env.message_id);
        return;
      }
      throw error;
    }

    send(
      conn,
      session,
      "record.list_response",
      null,
      { records: page.records, next_cursor: page.next_cursor },
      env.message_id,
    );
  });

  router.register("record.get_request", async ({ conn, session }, env) => {
    if (!session) return;
    const recordId = asRecord(env.payload).record_id;
    if (typeof recordId !== "string") {
      sendError(conn, session, "malformed_payload", "invalid record.get_request", env.message_id);
      return;
    }

    // Owner-scoped: "missing" and "not yours" are indistinguishable.
    const record = await recordStore.get(recordId, session.userId);
    if (!record) {
      sendError(conn, session, "unknown_record", "unknown record", env.message_id);
      return;
    }

    send(conn, session, "record.get_response", null, { record }, env.message_id);
  });

  // ---- Report generation (PROTOCOL_SPEC.md §11) ---------------------------

  router.register("report.generate_request", async ({ conn, session }, env) => {
    if (!session) return;
    const payload = asRecord(env.payload);
    const recordId = payload.record_id;
    if (typeof recordId !== "string") {
      sendError(
        conn,
        session,
        "malformed_payload",
        "invalid report.generate_request",
        env.message_id,
      );
      return;
    }

    const record = await recordStore.get(recordId, session.userId);
    if (!record) {
      sendError(conn, session, "unknown_record", "unknown record", env.message_id);
      return;
    }

    const detailLevel = resolveDetailLevel(asRecord(payload.options).detail_level);
    if (!detailLevel) {
      send(
        conn,
        session,
        "report.generate_result",
        null,
        {
          record_id: recordId,
          status: "failed",
          report: null,
          error_code: "invalid_option",
          message: "unknown detail_level",
        },
        env.message_id,
      );
      return;
    }

    const result = generateReport(record, detailLevel);
    send(
      conn,
      session,
      "report.generate_result",
      null,
      result.status === "ok"
        ? {
            record_id: recordId,
            status: "ok",
            report: { format: result.format, content: result.content },
            error_code: null,
            message: null,
          }
        : {
            record_id: recordId,
            status: "failed",
            report: null,
            error_code: result.error_code,
            message: result.message,
          },
      env.message_id,
    );
  });

  // ---- Out-of-band trigger ------------------------------------------------

  return {
    advance: async (workflowId: string): Promise<void> => {
      const workflow = await engine.get(workflowId);
      if (!workflow) return;

      const session = sessions.get(workflow.sessionId);
      const conn = session?.connection ?? null;

      // No live client (disconnected, or the session is gone): still let the
      // workflow converge — reconciliation and terminal transitions are
      // server-owned, and reclamation deals with a workflow that can go no
      // further.
      if (!session || !conn) {
        try {
          await orchestrator.advance(workflowId);
        } catch (error) {
          console.error(`[workflow] out-of-band advance failed for ${workflowId}:`, error);
        }
        return;
      }

      await advanceAndPush(conn, session, workflowId);
    },
  };
}
