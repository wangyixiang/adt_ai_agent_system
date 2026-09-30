import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store: PostgresWorkflowStore;
let engine: WorkflowEngine;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
  store = new PostgresWorkflowStore(pool);
  engine = new WorkflowEngine({ store, now: () => 1000 });
});
afterAll(async () => {
  await pool.end();
});

describe("expected_output", () => {
  it("is frozen on the step at dispatch", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "read",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: true,
      expectedOutput: "git_status",
    });

    // Persisted, so a later capability.sync cannot move the goalposts for an
    // in-flight step (CAPABILITY_SPEC.md §4).
    expect(step.expectedOutput).toBe("git_status");
    expect((await store.getStep(step.id))!.expectedOutput).toBe("git_status");
  });

  it("is null when the capability declares no output type", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const step = await engine.dispatchStep(wf.id, {
      objective: "read",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: true,
    });

    expect(step.expectedOutput).toBeNull();
  });
});
