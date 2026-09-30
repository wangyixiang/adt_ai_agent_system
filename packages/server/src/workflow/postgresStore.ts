import type pg from "pg";
import type { Pool } from "../db/pool";
import type {
  StepSnapshot,
  WorkflowEvent,
  WorkflowSnapshot,
  WorkflowStore,
} from "./store";

interface WorkflowRow {
  id: string;
  user_id: string;
  session_id: string;
  user_request: unknown;
  state: string;
  terminal_reason: string | null;
  criteria: unknown;
  created_at: string | number;
  ended_at: string | number | null;
  not_solved_rounds: number;
}

interface StepRow {
  id: string;
  workflow_id: string;
  state: string;
  objective: string;
  capability: string;
  side_effect: boolean;
  interruptible: boolean;
  idempotency_key: string | null;
  attempt: number;
  wait_class: string | null;
  input: unknown;
  output_schema: unknown;
  expected_output: string | null;
  updated_at: string | number;
  timeout_ms: string | number;
}

interface EventRow {
  id: string;
  workflow_id: string;
  kind: string;
  ts: string | number;
  payload: unknown;
}

const toWorkflow = (row: WorkflowRow): WorkflowSnapshot => ({
  id: row.id,
  userId: row.user_id,
  sessionId: row.session_id,
  userRequest: row.user_request,
  state: row.state as WorkflowSnapshot["state"],
  terminalReason: row.terminal_reason,
  criteria: row.criteria as WorkflowSnapshot["criteria"],
  createdAt: Number(row.created_at),
  endedAt: row.ended_at === null ? null : Number(row.ended_at),
  notSolvedRounds: row.not_solved_rounds,
});

const toStep = (row: StepRow): StepSnapshot => ({
  id: row.id,
  workflowId: row.workflow_id,
  state: row.state as StepSnapshot["state"],
  objective: row.objective,
  capability: row.capability,
  sideEffect: row.side_effect,
  interruptible: row.interruptible,
  idempotencyKey: row.idempotency_key,
  attempt: row.attempt,
  waitClass: row.wait_class as StepSnapshot["waitClass"],
  input: (row.input ?? {}) as Record<string, unknown>,
  outputSchema: (row.output_schema ?? null) as Record<string, unknown> | null,
  expectedOutput: row.expected_output,
  updatedAt: Number(row.updated_at),
  timeoutMs: Number(row.timeout_ms),
});

const toEvent = (row: EventRow): WorkflowEvent => ({
  id: row.id,
  workflowId: row.workflow_id,
  kind: row.kind as WorkflowEvent["kind"],
  ts: Number(row.ts),
  payload: row.payload,
});

export class PostgresWorkflowStore implements WorkflowStore {
  constructor(private readonly pool: Pool) {}

  private async tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure; a rollback error must not mask it.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private insertWorkflow(client: pg.PoolClient, w: WorkflowSnapshot): Promise<unknown> {
    return client.query(
      `INSERT INTO workflows (id, user_id, session_id, user_request, state, terminal_reason, criteria, created_at, ended_at, not_solved_rounds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state,
         terminal_reason = EXCLUDED.terminal_reason,
         criteria = EXCLUDED.criteria,
         ended_at = EXCLUDED.ended_at,
         not_solved_rounds = EXCLUDED.not_solved_rounds`,
      [
        w.id, w.userId, w.sessionId, JSON.stringify(w.userRequest ?? {}), w.state,
        w.terminalReason, JSON.stringify(w.criteria), w.createdAt, w.endedAt,
        w.notSolvedRounds,
      ],
    );
  }

  private insertStep(client: pg.PoolClient, s: StepSnapshot): Promise<unknown> {
    return client.query(
      `INSERT INTO workflow_steps (id, workflow_id, state, objective, capability, side_effect, interruptible, idempotency_key, attempt, wait_class, input, output_schema, expected_output, updated_at, timeout_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, wait_class = EXCLUDED.wait_class, attempt = EXCLUDED.attempt, updated_at = EXCLUDED.updated_at`,
      [
        s.id, s.workflowId, s.state, s.objective, s.capability,
        s.sideEffect, s.interruptible, s.idempotencyKey, s.attempt, s.waitClass,
        JSON.stringify(s.input ?? {}),
        s.outputSchema === null ? null : JSON.stringify(s.outputSchema),
        s.expectedOutput,
        s.updatedAt, s.timeoutMs,
      ],
    );
  }

  private insertEvent(client: pg.PoolClient, e: WorkflowEvent): Promise<unknown> {
    return client.query(
      "INSERT INTO workflow_events (id, workflow_id, kind, ts, payload) VALUES ($1,$2,$3,$4,$5)",
      [e.id, e.workflowId, e.kind, e.ts, JSON.stringify(e.payload ?? {})],
    );
  }

  async createWorkflow(workflow: WorkflowSnapshot, event: WorkflowEvent): Promise<void> {
    await this.tx(async (client) => {
      await this.insertWorkflow(client, workflow);
      await this.insertEvent(client, event);
    });
  }

  async saveWorkflow(workflow: WorkflowSnapshot, event: WorkflowEvent): Promise<void> {
    await this.saveWorkflowWithEvents(workflow, [event]);
  }

  async saveWorkflowWithEvents(
    workflow: WorkflowSnapshot,
    events: WorkflowEvent[],
  ): Promise<void> {
    await this.tx(async (client) => {
      await this.insertWorkflow(client, workflow);
      for (const event of events) await this.insertEvent(client, event);
    });
  }

  async saveStepAndWorkflow(
    step: StepSnapshot,
    workflow: WorkflowSnapshot,
    events: WorkflowEvent[],
  ): Promise<void> {
    await this.tx(async (client) => {
      await this.insertStep(client, step);
      await this.insertWorkflow(client, workflow);
      for (const event of events) await this.insertEvent(client, event);
    });
  }

  async getWorkflow(id: string): Promise<WorkflowSnapshot | null> {
    const result = await this.pool.query<WorkflowRow>("SELECT * FROM workflows WHERE id = $1", [id]);
    return result.rows[0] ? toWorkflow(result.rows[0]) : null;
  }

  async listWorkflowsByUser(userId: string): Promise<WorkflowSnapshot[]> {
    const result = await this.pool.query<WorkflowRow>(
      "SELECT * FROM workflows WHERE user_id = $1 ORDER BY created_at",
      [userId],
    );
    return result.rows.map(toWorkflow);
  }

  async listWorkflowsBySession(sessionId: string): Promise<WorkflowSnapshot[]> {
    const result = await this.pool.query<WorkflowRow>(
      "SELECT * FROM workflows WHERE session_id = $1 ORDER BY created_at, id",
      [sessionId],
    );
    return result.rows.map(toWorkflow);
  }

  async findActiveWorkflows(): Promise<WorkflowSnapshot[]> {
    const result = await this.pool.query<WorkflowRow>(
      "SELECT * FROM workflows WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY created_at",
    );
    return result.rows.map(toWorkflow);
  }

  async createStep(step: StepSnapshot, event: WorkflowEvent): Promise<void> {
    await this.tx(async (client) => {
      await this.insertStep(client, step);
      await this.insertEvent(client, event);
    });
  }

  async saveStep(step: StepSnapshot, event: WorkflowEvent): Promise<void> {
    await this.tx(async (client) => {
      await this.insertStep(client, step);
      await this.insertEvent(client, event);
    });
  }

  async getStep(id: string): Promise<StepSnapshot | null> {
    const result = await this.pool.query<StepRow>("SELECT * FROM workflow_steps WHERE id = $1", [id]);
    return result.rows[0] ? toStep(result.rows[0]) : null;
  }

  async listSteps(workflowId: string): Promise<StepSnapshot[]> {
    const result = await this.pool.query<StepRow>(
      "SELECT * FROM workflow_steps WHERE workflow_id = $1 ORDER BY id",
      [workflowId],
    );
    return result.rows.map(toStep);
  }

  async listEvents(workflowId: string): Promise<WorkflowEvent[]> {
    const result = await this.pool.query<EventRow>(
      // `seq` (bigserial) is the insertion order; `ts` is a monotonic clock
      // that resets across restarts and can tie.
      "SELECT * FROM workflow_events WHERE workflow_id = $1 ORDER BY seq",
      [workflowId],
    );
    return result.rows.map(toEvent);
  }
}
