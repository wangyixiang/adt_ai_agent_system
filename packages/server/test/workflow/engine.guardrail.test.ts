import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { GuardrailError, WorkflowEngine } from "../../src/workflow/engine";
import { DEFAULT_GUARDRAILS } from "../../src/workflow/guardrails";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
});
afterAll(async () => {
  await pool.end();
});

const dispatch = (engine: WorkflowEngine, workflowId: string) =>
  engine.dispatchStep(workflowId, {
    objective: "r",
    capability: "git.collect_diagnostics",
    sideEffect: false,
    interruptible: true,
  });

describe("guardrail threshold", () => {
  it("writes the configured threshold into the guardrail_triggered event", async () => {
    const engine = new WorkflowEngine({
      store,
      now: () => 1000,
      guardrails: { ...DEFAULT_GUARDRAILS, maxStepsPerWorkflow: 0 },
    });
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });

    await expect(dispatch(engine, wf.id)).rejects.toBeInstanceOf(GuardrailError);

    const event = (await store.listEvents(wf.id)).find((e) => e.kind === "guardrail_triggered")!;
    expect(event.payload).toMatchObject({ reason: "step_limit", threshold: 0 });
  });

  it("records the guardrail when the engineer keeps saying not solved", async () => {
    const engine = new WorkflowEngine({
      store,
      now: () => 1000,
      guardrails: { ...DEFAULT_GUARDRAILS, maxNotSolvedRounds: 1 },
    });
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    await engine.confirmCompletion(wf.id, "not_solved");
    const terminated = await engine.confirmCompletion(wf.id, "not_solved");

    expect(terminated.state).toBe("FAILED");
    const event = (await store.listEvents(wf.id)).find((e) => e.kind === "guardrail_triggered")!;
    expect(event.payload).toMatchObject({ reason: "user_round_limit", threshold: 1 });
  });
});
