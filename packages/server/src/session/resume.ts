import { newMessageId, nowUtcIso, PROTOCOL_VERSION } from "@adt/shared";
import type { UserRepository } from "../auth/userRepository";
import { stepDispatchPayload, type StepDispatchPayload } from "../protocol/workflowProtocol";
import type { RecordService } from "../record/service";
import { isActiveStep, isTerminalWorkflow } from "../workflow/stateMachine";
import type { WorkflowSnapshot, WorkflowStore } from "../workflow/store";
import type { WorkflowState } from "../workflow/types";
import type { Connection } from "../ws/connection";
import { sendError } from "../ws/errors";
import type { MessageRouter } from "../ws/messageRouter";
import type { Session, SessionManager } from "./sessionManager";

export interface SessionResumeDeps {
  router: MessageRouter;
  sessions: SessionManager;
  users: UserRepository;
  store: WorkflowStore;
  records: RecordService;
  /** A live session came back (reconnect): stop counting it down for reclamation. */
  onResumed?: (sessionId: string) => void;
}

export interface StateSyncWorkflow {
  workflow_id: string;
  workflow_status: WorkflowState;
  pending_step: StepDispatchPayload | null;
  record_id: string | null;
  record_persistence_failed: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  (value ?? {}) as Record<string, unknown>;

async function describeWorkflow(
  workflow: WorkflowSnapshot,
  store: WorkflowStore,
  records: RecordService,
  terminal: boolean,
): Promise<StateSyncWorkflow> {
  if (!terminal) {
    const steps = await store.listSteps(workflow.id);
    const active = steps.find((step) => isActiveStep(step.state));
    return {
      workflow_id: workflow.id,
      workflow_status: workflow.state,
      pending_step: active ? stepDispatchPayload(active) : null,
      record_id: null,
      record_persistence_failed: false,
    };
  }

  // Terminal: `finalize` is idempotent and heals a Record that the disconnect
  // prevented from being written (PROTOCOL_SPEC.md §7.4).
  const finalize = await records.finalize(workflow.id);
  return {
    workflow_id: workflow.id,
    workflow_status: workflow.state,
    pending_step: null,
    record_id: finalize.recordId,
    record_persistence_failed: finalize.persistenceFailed,
  };
}

function sendStateSync(
  conn: Connection,
  session: Session,
  inReplyTo: string,
  workflows: StateSyncWorkflow[],
): void {
  conn.send({
    protocol_version: PROTOCOL_VERSION,
    message_id: newMessageId(),
    session_id: session.id,
    workflow_id: null,
    user_id: session.userId,
    type: "workflow.state_sync",
    ts: nowUtcIso(),
    in_reply_to: inReplyTo,
    payload: { resumed: true, workflows },
  });
}

/**
 * `session.resume` (PROTOCOL_SPEC.md §5.2, ADR-003 §3): authenticate the new
 * physical connection FIRST, then rebind the logical session and hand back the
 * server's authoritative state. Resume never leaks another user's session.
 */
export function registerSessionResume(deps: SessionResumeDeps): void {
  const { router, sessions, users, store, records } = deps;

  router.register("session.resume", async ({ conn }, env) => {
    const payload = asRecord(env.payload);
    const sessionId = payload.session_id;
    const auth = asRecord(payload.auth);
    const username = auth.username;
    const secret = auth.secret;

    if (typeof sessionId !== "string" || typeof username !== "string" || typeof secret !== "string") {
      sendError(conn, null, "malformed_payload", "invalid session.resume payload", env.message_id);
      return;
    }

    const user = await users.verifyCredentials(username, secret);
    if (!user) {
      sendError(conn, null, "auth_failed", "invalid credentials", env.message_id);
      return;
    }

    const existing = sessions.get(sessionId);
    if (!existing || sessions.isExpired(existing)) {
      sendError(conn, null, "session_expired", "unknown or expired session", env.message_id);
      return;
    }

    if (existing.userId !== user.id) {
      sendError(conn, null, "auth_failed", "session does not belong to this user", env.message_id);
      return;
    }

    sessions.attach(existing.id, conn);
    deps.onResumed?.(existing.id);

    // `known_workflows` only selects which already-terminal workflows to
    // reconcile; state itself always comes from the server (ADR-001).
    const known = new Set(
      (Array.isArray(payload.known_workflows) ? payload.known_workflows : [])
        .map((entry) => asRecord(entry).workflow_id)
        .filter((id): id is string => typeof id === "string"),
    );

    const own = await store.listWorkflowsBySession(existing.id);
    const workflows: StateSyncWorkflow[] = [];
    for (const workflow of own) {
      const terminal = isTerminalWorkflow(workflow.state);
      if (terminal && !known.has(workflow.id)) continue;
      workflows.push(await describeWorkflow(workflow, store, records, terminal));
    }

    sendStateSync(conn, existing, env.message_id, workflows);
  });
}
