import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import {
  WorkflowOrchestrator,
  type Planner,
  type PlannerDecision,
} from "../../src/workflow/orchestrator";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
let store!: PostgresWorkflowStore;
let engine!: WorkflowEngine;

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

const scripted = (decisions: PlannerDecision[]): Planner => ({
  initialCriteria: async () => ({ mode: "open", revision: 0 }),
  proposeNext: async () => decisions.shift()!,
});

const open = { mode: "open" as const, revision: 0 };
const readStep = {
  objective: "read",
  capability: "git.collect_diagnostics",
  sideEffect: false,
  interruptible: true,
};

describe("WorkflowOrchestrator.advance", () => {
  it("dispatches the step the planner proposes", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const orch = new WorkflowOrchestrator({
      engine,
      store,
      planner: scripted([{ kind: "step", step: readStep }]),
    });

    const result = await orch.advance(wf.id);

    expect(result.dispatched!.capability).toBe("git.collect_diagnostics");
    expect((await engine.get(wf.id))!.state).toBe("RUNNING");
  });

  it("returns a completion candidate without changing state", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    const orch = new WorkflowOrchestrator({
      engine,
      store,
      planner: scripted([
        { kind: "completion_candidate", summary: "看起来好了", evidenceRefs: ["step_1"] },
      ]),
    });

    const result = await orch.advance(wf.id);

    expect(result.completionCandidate).toEqual({
      summary: "看起来好了",
      evidenceRefs: ["step_1"],
    });
    expect((await engine.get(wf.id))!.state).toBe("CREATED");
  });

  it("does not ask the planner while a step is active", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    let calls = 0;
    const planner: Planner = {
      initialCriteria: async () => ({ mode: "open", revision: 0 }),
      proposeNext: async () => {
        calls++;
        return { kind: "step", step: readStep };
      },
    };
    const orch = new WorkflowOrchestrator({ engine, store, planner });

    await orch.advance(wf.id);
    const second = await orch.advance(wf.id);

    expect(calls).toBe(1);
    expect(second.dispatched).toBeUndefined();
  });

  it("does not ask the planner for a terminal workflow", async () => {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, open);
    await engine.confirmCompletion(wf.id, "solved");
    let calls = 0;
    const planner: Planner = {
      initialCriteria: async () => ({ mode: "open", revision: 0 }),
      proposeNext: async () => {
        calls++;
        return { kind: "step", step: readStep };
      },
    };
    const orch = new WorkflowOrchestrator({ engine, store, planner });

    expect(await orch.advance(wf.id)).toEqual({});
    expect(calls).toBe(0);
  });
});
