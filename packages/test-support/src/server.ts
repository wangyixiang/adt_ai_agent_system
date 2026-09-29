import type { AddressInfo } from "node:net";
import {
  createPool,
  createServer,
  migrate,
  PostgresRecordStore,
  PostgresWorkflowStore,
  RecordService,
  registerWorkflowProtocol,
  UserRepository,
  WorkflowEngine,
  WorkflowOrchestrator,
  type GuardrailConfig,
  type NormalizedCapability,
  type PlannerDecision,
  type Pool,
  type RecordListPage,
  type RecordStore,
  type SessionManager,
  type WorkflowEngine as WorkflowEngineType,
} from "@adt/server";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://adt:adt@localhost:55432/adt_test";

export interface TestServerOptions {
  heartbeatIntervalMs?: number;
  maxMissed?: number;
  /** Scripted planner decisions; an exhausted script yields a completion candidate. */
  planner?: PlannerDecision[];
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

  const deadSessions: string[] = [];
  const server = await createServer({
    pool,
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 15000,
    maxMissed: opts.maxMissed ?? 3,
    onSessionDead: (sessionId) => {
      if (!deadSessions.includes(sessionId)) deadSessions.push(sessionId);
    },
  });

  const workflowStore = new PostgresWorkflowStore(pool);
  const engine = new WorkflowEngine({
    store: workflowStore,
    now: () => Date.now(),
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

  const script = [...(opts.planner ?? [])];
  const orchestrator = new WorkflowOrchestrator({
    engine,
    store: workflowStore,
    planner: {
      proposeNext: async () =>
        script.shift() ?? { kind: "completion_candidate", summary: "", evidenceRefs: [] },
    },
  });

  registerWorkflowProtocol({
    router: server.router,
    sessions: server.sessions,
    engine,
    store: workflowStore,
    orchestrator,
    records,
    recordStore: realRecordStore,
  });

  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (server.app.server.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    deadSessions,
    sessions: server.sessions,
    engine,
    capabilities: (sessionId: string) => server.sessions.capabilitiesOf(sessionId),
    warnings: (sessionId: string) => server.sessions.get(sessionId)?.connection?.warnings ?? [],
    waitFor: async (predicate: () => boolean, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("waitFor timed out");
    },
    close: async () => {
      await server.close();
      await pool.end();
    },
  };
}
