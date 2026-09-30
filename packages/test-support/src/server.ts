import type { AddressInfo } from "node:net";
import {
  createPool,
  createServer,
  migrate,
  OrphanReclaimer,
  PostgresRecordStore,
  PostgresWorkflowStore,
  RecordService,
  registerSessionResume,
  registerWorkflowProtocol,
  LlmPlanner,
  SessionLifecycle,
  StepTimeoutMonitor,
  UserRepository,
  WorkflowEngine,
  WorkflowOrchestrator,
  type GuardrailConfig,
  type LlmProvider,
  type NormalizedCapability,
  type Planner,
  type PlannerDecision,
  type Pool,
  type RecordListPage,
  type RecordStore,
  type SessionManager,
  type WorkflowEngine as WorkflowEngineType,
  type RecordDocument,
  type WorkflowSnapshot,
} from "@adt/server";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://adt:adt@localhost:55432/adt_test";

export interface TestServerOptions {
  heartbeatIntervalMs?: number;
  maxMissed?: number;
  /** How long a disconnected session stays resumable (default 24h). */
  sessionTtlMs?: number;
  /** How often the session lifecycle sweeps and reclaims (default 60s). */
  reclaimIntervalMs?: number;
  /** Fallback step_timeout for capabilities that declare no timeout_hint. */
  stepTimeoutMs?: number;
  /** How often the step timeout monitor sweeps (default 1s). */
  timeoutSweepIntervalMs?: number;
  /** Scripted planner decisions; an exhausted script yields a completion candidate. */
  planner?: PlannerDecision[];
  /** A full planner implementation (takes precedence over `planner`). */
  plannerImpl?: Planner;
  /** Drives the real `LlmPlanner` with a (scripted) provider. */
  llm?: LlmProvider;
  failRecordPersistence?: boolean;
  /** Makes `RecordService.finalize` throw (as if a DB read failed). */
  throwOnFinalize?: boolean;
  guardrails?: GuardrailConfig;
}

export interface TestServer {
  url: string;
  deadSessions: string[];
  sessions: SessionManager;
  engine: WorkflowEngineType;
  capabilities(sessionId: string): Map<string, NormalizedCapability>;
  warnings(sessionId: string): string[];
  workflows(sessionId: string): Promise<WorkflowSnapshot[]>;
  recordForWorkflow(workflowId: string): Promise<RecordDocument | null>;
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

const emptyPage: RecordListPage = { records: [], next_cursor: null };

function failingRecordStore(): RecordStore {
  return {
    save: async () => {
      throw new Error("forced record persistence failure");
    },
    get: async () => null,
    findByWorkflow: async () => null,
    listByOwner: async () => emptyPage,
  };
}

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const pool: Pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
  await pool.query("TRUNCATE users");
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events, records");

  const users = new UserRepository(pool);
  await users.create("alice", "pw-alice");
  await users.create("bob", "pw-bob");

  // Workflow dependencies are built before the server so the session
  // lifecycle can feed the orphan reclaimer from the first disconnect.
  const workflowStore = new PostgresWorkflowStore(pool);
  // Ordering clock (events, workflow timestamps) vs wall clock (persisted step
  // deadlines, which must survive a restart). The timeout monitor MUST use the
  // wall clock, or it compares against a `performance.now()` base.
  const now = () => Date.now();
  const wallClock = now;
  const engine = new WorkflowEngine({
    store: workflowStore,
    now,
    wallClock,
    guardrails: opts.guardrails,
  });
  const realRecordStore = new PostgresRecordStore(pool);

  const finalizeStore: RecordStore = opts.throwOnFinalize
    ? {
        save: async () => {
          throw new Error("finalize read failed");
        },
        get: async () => null,
        findByWorkflow: async () => {
          throw new Error("finalize read failed");
        },
        listByOwner: async () => emptyPage,
      }
    : opts.failRecordPersistence
      ? failingRecordStore()
      : realRecordStore;

  const records = new RecordService({ store: finalizeStore, workflowStore });

  const sessionTtlMs = opts.sessionTtlMs ?? 86_400_000;
  const reclaimer = new OrphanReclaimer({
    engine,
    store: workflowStore,
    graceMs: sessionTtlMs,
    onReclaimed: async (workflowId) => {
      await records.finalize(workflowId);
    },
  });

  const deadSessions: string[] = [];
  const server = await createServer({
    pool,
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 15000,
    maxMissed: opts.maxMissed ?? 3,
    sessionTtlMs,
    onSessionDead: (sessionId) => {
      if (!deadSessions.includes(sessionId)) deadSessions.push(sessionId);
      reclaimer.onSessionDead(sessionId);
    },
    onSessionAlive: (sessionId) => reclaimer.onSessionAlive(sessionId),
  });

  const script = [...(opts.planner ?? [])];
  const planner: Planner = opts.llm
    ? new LlmPlanner({ provider: opts.llm })
    : (opts.plannerImpl ??
      ({
        initialCriteria: async () => ({ mode: "open", revision: 0 }),
        proposeNext: async () =>
          script.shift() ?? { kind: "completion_candidate", summary: "", evidenceRefs: [] },
      } satisfies Planner));
  const orchestrator = new WorkflowOrchestrator({
    engine,
    store: workflowStore,
    planner,
    capabilitiesOf: (sessionId) => [...server.sessions.capabilitiesOf(sessionId).values()],
    defaultStepTimeoutMs: opts.stepTimeoutMs,
  });

  const protocol = registerWorkflowProtocol({
    router: server.router,
    sessions: server.sessions,
    engine,
    store: workflowStore,
    orchestrator,
    planner,
    records,
    recordStore: realRecordStore,
  });

  registerSessionResume({
    router: server.router,
    sessions: server.sessions,
    users,
    store: workflowStore,
    records,
    onResumed: (sessionId) => reclaimer.onSessionAlive(sessionId),
  });

  const lifecycle = new SessionLifecycle(
    { sessions: server.sessions, reclaimer },
    { intervalMs: opts.reclaimIntervalMs ?? 60_000 },
  );
  lifecycle.start();

  const stepTimeouts = new StepTimeoutMonitor(
    {
      engine,
      store: workflowStore,
      clock: wallClock,
      onStepEnded: (workflowId) => protocol.advance(workflowId),
    },
    { intervalMs: opts.timeoutSweepIntervalMs ?? 1000 },
  );
  stepTimeouts.start();

  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (server.app.server.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    deadSessions,
    sessions: server.sessions,
    engine,
    capabilities: (sessionId: string) => server.sessions.capabilitiesOf(sessionId),
    warnings: (sessionId: string) => server.sessions.get(sessionId)?.connection?.warnings ?? [],
    workflows: (sessionId: string) => workflowStore.listWorkflowsBySession(sessionId),
    recordForWorkflow: (workflowId: string) => finalizeStore.findByWorkflow(workflowId),
    waitFor: async (predicate: () => boolean, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("waitFor timed out");
    },
    close: async () => {
      stepTimeouts.stop();
      lifecycle.stop();
      await server.close();
      await pool.end();
    },
  };
}
