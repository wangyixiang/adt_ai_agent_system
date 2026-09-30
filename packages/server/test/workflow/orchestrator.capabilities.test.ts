import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import { WorkflowOrchestrator, type PlannerDecision } from "../../src/workflow/orchestrator";
import type { NormalizedCapability } from "@adt/shared";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;
beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
});
afterAll(async () => {
  await pool.end();
});

const readCap = (over: Partial<NormalizedCapability> = {}): NormalizedCapability => ({
  name: "git.collect_diagnostics",
  side_effect: false,
  interruptible: true,
  idempotent: false,
  input_schema: {
    type: "object",
    required: ["project_path"],
    properties: { project_path: { type: "string" } },
  },
  ...over,
});

function orchestrated(decisions: PlannerDecision[], capabilities: NormalizedCapability[]) {
  const store = new PostgresWorkflowStore(pool);
  const engine = new WorkflowEngine({ store, now: () => 1000 });
  const script = [...decisions];
  return {
    engine,
    store,
    orch: new WorkflowOrchestrator({
      engine,
      store,
      planner: { proposeNext: async () => script.shift()! },
      capabilitiesOf: () => capabilities,
    }),
  };
}

describe("planner capabilities + input validation", () => {
  it("passes the session's capabilities to the planner", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    let seen: unknown;
    const orch = new WorkflowOrchestrator({
      engine,
      store,
      planner: {
        proposeNext: async (input) => {
          seen = input.capabilities;
          return { kind: "completion_candidate", summary: "", evidenceRefs: [] };
        },
      },
      capabilitiesOf: () => [readCap()],
    });
    await orch.advance(wf.id);
    expect(seen).toEqual([readCap()]);
  });

  it("dispatches a step whose input matches the capability schema", async () => {
    const { engine, orch } = orchestrated(
      [
        {
          kind: "step",
          step: {
            objective: "read",
            capability: "git.collect_diagnostics",
            sideEffect: false,
            interruptible: true,
            input: { project_path: "/a" },
          },
        },
      ],
      [readCap()],
    );
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const result = await orch.advance(wf.id);
    expect(result.dispatched!.capability).toBe("git.collect_diagnostics");
    expect(result.dispatched!.input).toEqual({ project_path: "/a" });
  });

  it("does not dispatch invalid input and fails the workflow instead", async () => {
    const { engine, store, orch } = orchestrated(
      [
        {
          kind: "step",
          step: {
            objective: "read",
            capability: "git.collect_diagnostics",
            sideEffect: false,
            interruptible: true,
            input: { project_path: 7 },
          },
        },
      ],
      [readCap()],
    );
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    expect(await orch.advance(wf.id)).toEqual({});
    const after = (await engine.get(wf.id))!;
    expect(after.state).toBe("FAILED");
    expect(after.terminalReason).toBe("invalid_input");
    expect(await store.listSteps(wf.id)).toHaveLength(0);
  });

  it("fails the workflow as planner_error when the planner throws", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const orch = new WorkflowOrchestrator({
      engine,
      store,
      planner: {
        proposeNext: async () => {
          throw new Error("llm down");
        },
      },
      capabilitiesOf: () => [],
    });
    expect(await orch.advance(wf.id)).toEqual({});
    const after = (await engine.get(wf.id))!;
    expect(after.state).toBe("FAILED");
    expect(after.terminalReason).toBe("planner_error");
  });
});
