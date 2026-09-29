export { buildServer, type ServerDeps } from "./http/app";
export { Connection, type SocketLike } from "./ws/connection";
export {
  MessageRouter,
  type MessageContext,
  type MessageHandler,
  type SessionResolver,
} from "./ws/messageRouter";
export { SessionManager, type Session, type SessionManagerOptions } from "./session/sessionManager";
export { registerHandshake, type HandshakeDeps } from "./session/handshake";
export {
  CapabilityRegistry,
  type CapabilityDescriptor,
  type NormalizedCapability,
  type CapabilitySyncPayload,
} from "./capability/capabilityRegistry";
export { KNOWN_CAPABILITIES } from "./capability/known";
export { registerCapabilitySync } from "./capability/handler";
export { HeartbeatMonitor, registerHeartbeat, type HeartbeatOptions } from "./ws/heartbeat";
export { UserRepository, type User } from "./auth/userRepository";
export { hashPassword, verifyPassword } from "./auth/password";
export { createPool, type Pool } from "./db/pool";
export { migrate, MIGRATIONS_DIR } from "./db/migrate";
export { createServer, type CreateServerOptions, type CreatedServer } from "./server";
export {
  WorkflowEngine,
  GuardrailError,
  WorkflowBusyError,
  WorkflowTerminalError,
  type EngineDeps,
  type NewStep,
  type StepStatusUpdate,
} from "./workflow/engine";
export { PostgresWorkflowStore } from "./workflow/postgresStore";
export type {
  StepSnapshot,
  WorkflowEvent,
  WorkflowEventKind,
  WorkflowSnapshot,
  WorkflowStore,
} from "./workflow/store";
export {
  breachedGuardrail,
  DEFAULT_GUARDRAILS,
  type GuardrailConfig,
  type GuardrailInput,
  type GuardrailReason,
} from "./workflow/guardrails";
export { reviseCriteria, type CompletionCriteria } from "./workflow/criteria";
export { OrphanReclaimer, type ReclamationDeps } from "./workflow/reclamation";
export {
  canTransitionStep,
  isActiveStep,
  isTerminalStep,
  isTerminalWorkflow,
} from "./workflow/stateMachine";
export {
  convergesCancelling,
  decideCancel,
  type CancelContext,
  type CancelDecision,
  type WaitClass,
} from "./workflow/cancel";
export type {
  ActiveStepState,
  StepState,
  TerminalStepState,
  TerminalWorkflowState,
  WorkflowState,
} from "./workflow/types";
export {
  WorkflowOrchestrator,
  type AdvanceResult,
  type OrchestratorDeps,
  type Planner,
  type PlannerDecision,
  type PlannerInput,
} from "./workflow/orchestrator";
export {
  PostgresRecordStore,
} from "./record/postgresRecordStore";
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type RecordListFilters,
  type RecordListItem,
  type RecordListPage,
  type RecordStore,
} from "./record/store";
export { RecordService, type FinalizeResult, type RecordServiceDeps } from "./record/service";
export { buildRecord, renderNarrative, type BuildRecordInput } from "./record/builder";
export type {
  RecordDocument,
  RecordEntry,
  RecordEntryKind,
  RecordSummary,
  UnresolvedSideEffect,
} from "./record/types";
export {
  generateReport,
  resolveDetailLevel,
  type DetailLevel,
  type ReportErrorCode,
  type ReportResult,
} from "./report/generate";
export {
  registerWorkflowProtocol,
  toStepStatusUpdate,
  type WorkflowProtocolDeps,
} from "./protocol/workflowProtocol";

import { createPool } from "./db/pool";
import { migrate } from "./db/migrate";
import { createServer } from "./server";
import type { SessionManager } from "./session/sessionManager";

export interface StartOptions {
  port?: number;
  host?: string;
  databaseUrl?: string;
  heartbeatIntervalMs?: number;
  maxMissed?: number;
  onSessionDead?: (sessionId: string) => void;
}

export interface RunningServer {
  url: string;
  sessions: SessionManager;
  close(): Promise<void>;
}

export async function start(opts: StartOptions = {}): Promise<RunningServer> {
  const databaseUrl =
    opts.databaseUrl ??
    process.env.DATABASE_URL ??
    "postgres://adt:adt@localhost:55432/adt";

  const pool = createPool(databaseUrl);
  await migrate(pool);

  const server = await createServer({
    pool,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    maxMissed: opts.maxMissed,
    onSessionDead: opts.onSessionDead,
  });

  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const host = opts.host ?? "0.0.0.0";
  await server.app.listen({ port, host });

  const address = server.app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `ws://127.0.0.1:${actualPort}/ws`,
    sessions: server.sessions,
    close: async () => {
      await server.close();
      await pool.end();
    },
  };
}

const isMain = Boolean(process.argv[1]) && /index\.(ts|js)$/.test(process.argv[1]!);
if (isMain) {
  start()
    .then((s) => console.log(`server listening at ${s.url}`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
