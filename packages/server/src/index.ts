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
  SessionLifecycle,
  type LifecycleSweepResult,
  type Reclaimable,
  type SessionLifecycleDeps,
  type SessionLifecycleOptions,
} from "./session/lifecycle";
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
  StepTimeoutMonitor,
  type StepTimeoutDeps,
  type StepTimeoutOptions,
} from "./workflow/stepTimeout";
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
export { NOOP_PLANNER } from "./workflow/planner";
export { LlmPlanner } from "./workflow/llmPlanner";
export {
  PostgresRecordStore,
} from "./record/postgresRecordStore";
export {
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
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
  stepDispatchPayload,
  toStepStatusUpdate,
  type StepDispatchPayload,
  type WorkflowProtocolDeps,
  type WorkflowProtocolHandle,
} from "./protocol/workflowProtocol";
export {
  registerSessionResume,
  type SessionResumeDeps,
  type StateSyncWorkflow,
} from "./session/resume";
export type {
  LlmMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmTool,
  LlmToolCall,
} from "./llm/provider";
export {
  OpenAiCompatibleProvider,
  llmProviderFromEnv,
  type OpenAiCompatibleOptions,
} from "./llm/openaiCompatible";
export { selectPlanner } from "./llm/selectPlanner";

import { createPool } from "./db/pool";
import { migrate } from "./db/migrate";
import { createServer } from "./server";
import type { SessionManager } from "./session/sessionManager";
import { PostgresWorkflowStore } from "./workflow/postgresStore";
import { WorkflowEngine } from "./workflow/engine";
import { WorkflowOrchestrator } from "./workflow/orchestrator";
import type { Planner } from "./workflow/planner";
import { selectPlanner } from "./llm/selectPlanner";
import { PostgresRecordStore } from "./record/postgresRecordStore";
import { RecordService } from "./record/service";
import { registerWorkflowProtocol } from "./protocol/workflowProtocol";
import { registerSessionResume } from "./session/resume";
import { OrphanReclaimer } from "./workflow/reclamation";
import { SessionLifecycle } from "./session/lifecycle";
import { StepTimeoutMonitor } from "./workflow/stepTimeout";
import { UserRepository } from "./auth/userRepository";

export interface StartOptions {
  port?: number;
  host?: string;
  databaseUrl?: string;
  heartbeatIntervalMs?: number;
  maxMissed?: number;
  /** How long a disconnected session stays resumable (default 24h). */
  sessionTtlMs?: number;
  /** How often the session lifecycle sweeps and reclaims (default 60s). */
  reclaimIntervalMs?: number;
  /** Fallback step_timeout for capabilities that declare no timeout_hint. */
  stepTimeoutMs?: number;
  /** How often the step timeout monitor sweeps (default 1s). */
  stepTimeoutSweepIntervalMs?: number;
  onSessionDead?: (sessionId: string) => void;
  /** Defaults to a no-op planner until P3 wires the LLM planner. */
  planner?: Planner;
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

  const sessionTtlMs = opts.sessionTtlMs ?? 86_400_000;
  const reclaimIntervalMs = opts.reclaimIntervalMs ?? 60_000;

  const workflowStore = new PostgresWorkflowStore(pool);
  // One clock for the engine and the timeout monitor: comparing a Date.now()
  // deadline against performance.now() would make every step look overdue
  // (or never overdue, depending on the sign).
  const now = () => Math.floor(performance.now());
  const engine = new WorkflowEngine({ store: workflowStore, now });
  const recordStore = new PostgresRecordStore(pool);
  const records = new RecordService({ store: recordStore, workflowStore });
  const reclaimer = new OrphanReclaimer({
    engine,
    store: workflowStore,
    graceMs: sessionTtlMs,
    // WORKFLOW_SPEC.md §2.2: a reclaimed workflow still gets its Record.
    onReclaimed: async (workflowId) => {
      await records.finalize(workflowId);
    },
  });

  const server = await createServer({
    pool,
    heartbeatIntervalMs: opts.heartbeatIntervalMs,
    maxMissed: opts.maxMissed,
    sessionTtlMs,
    onSessionDead: (sessionId) => {
      opts.onSessionDead?.(sessionId);
      reclaimer.onSessionDead(sessionId);
    },
    onSessionAlive: (sessionId) => reclaimer.onSessionAlive(sessionId),
  });

  const planner = selectPlanner(process.env, opts.planner);
  const orchestrator = new WorkflowOrchestrator({
    engine,
    store: workflowStore,
    planner,
    capabilitiesOf: (sessionId) => [...server.sessions.capabilitiesOf(sessionId).values()],
    defaultStepTimeoutMs: opts.stepTimeoutMs,
  });

  const workflowProtocol = registerWorkflowProtocol({
    router: server.router,
    sessions: server.sessions,
    engine,
    store: workflowStore,
    orchestrator,
    planner,
    records,
    recordStore,
  });

  registerSessionResume({
    router: server.router,
    sessions: server.sessions,
    users: new UserRepository(pool),
    store: workflowStore,
    records,
    onResumed: (sessionId) => reclaimer.onSessionAlive(sessionId),
  });

  const lifecycle = new SessionLifecycle(
    { sessions: server.sessions, reclaimer },
    { intervalMs: reclaimIntervalMs },
  );
  lifecycle.start();

  const stepTimeouts = new StepTimeoutMonitor(
    {
      engine,
      store: workflowStore,
      now,
      onStepEnded: (workflowId) => workflowProtocol.advance(workflowId),
    },
    { intervalMs: opts.stepTimeoutSweepIntervalMs ?? 1000 },
  );
  stepTimeouts.start();

  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const host = opts.host ?? "0.0.0.0";
  await server.app.listen({ port, host });

  const address = server.app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `ws://127.0.0.1:${actualPort}/ws`,
    sessions: server.sessions,
    close: async () => {
      stepTimeouts.stop();
      lifecycle.stop();
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
