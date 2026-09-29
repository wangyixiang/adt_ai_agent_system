import { newMessageId, nowUtcIso, PROTOCOL_VERSION, type Envelope } from "@adt/shared";
import type { SessionManager, Session } from "../session/sessionManager";
import type { Connection } from "../ws/connection";
import { sendError } from "../ws/errors";
import type { MessageRouter } from "../ws/messageRouter";
import type { RecordService } from "../record/service";
import type { StepStatusUpdate, WorkflowEngine } from "../workflow/engine";
import type { WorkflowOrchestrator } from "../workflow/orchestrator";
import { isTerminalWorkflow } from "../workflow/stateMachine";
import type { StepSnapshot, WorkflowSnapshot, WorkflowStore } from "../workflow/store";

export interface WorkflowProtocolDeps {
  router: MessageRouter;
  sessions: SessionManager;
  engine: WorkflowEngine;
  store: WorkflowStore;
  orchestrator: WorkflowOrchestrator;
  records: RecordService;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  (value ?? {}) as Record<string, unknown>;

/** Maps a protocol `step.status` payload onto an engine update, or null. */
export function toStepStatusUpdate(payload: Record<string, unknown>): StepStatusUpdate | null {
  const evidence = payload.evidence;
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
    case "FAILED":
      return evidence === undefined ? { state: "FAILED" } : { state: "FAILED", evidence };
    case "REJECTED":
      return { state: "REJECTED" };
    case "UNKNOWN":
      return { state: "UNKNOWN" };
    default:
      return null;
  }
}

export function registerWorkflowProtocol(deps: WorkflowProtocolDeps): void {
  const { router, engine, store, orchestrator, records } = deps;
  const requestText = new Map<string, unknown>();
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

  /** Session-scoped ownership (ADR-003 §3/§5); resume arrives in P2c. */
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
    send(conn, session, "step.dispatch", step.workflowId, {
      workflow_id: step.workflowId,
      step_id: step.id,
      objective: step.objective,
      capability: step.capability,
      input: {},
      expected_output: null,
      requires_confirmation: step.sideEffect,
      idempotency_key: step.idempotencyKey,
    });
  };

  /**
   * Persist the Record FIRST, then notify (PROTOCOL_SPEC.md §7.4 / D-D3).
   * Exactly one `workflow.terminated` per workflow.
   */
  const finalizeIfTerminated = async (
    conn: Connection,
    session: Session,
    workflowId: string,
  ): Promise<void> => {
    const workflow = await engine.get(workflowId);
    if (!workflow || !isTerminalWorkflow(workflow.state)) return;
    if (notified.has(workflowId)) return;
    notified.add(workflowId);

    const result = await records.finalize(workflowId, requestText.get(workflowId) ?? null);

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
    const result = await orchestrator.advance(workflowId);
    if (result.dispatched) {
      sendStepDispatch(conn, session, result.dispatched);
    } else if (result.completionCandidate) {
      send(conn, session, "workflow.completion_candidate", workflowId, {
        summary: result.completionCandidate.summary,
        evidence_refs: result.completionCandidate.evidenceRefs,
      });
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

    const workflow = await engine.create(session.userId, session.id, { text }, {
      mode: "open",
      revision: 0,
    });
    requestText.set(workflow.id, request);

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

    await engine.applyStepStatus(workflow.id, payload.step_id, update);
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
}
