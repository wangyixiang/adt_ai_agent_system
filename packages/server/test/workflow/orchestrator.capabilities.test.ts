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
      planner: { initialCriteria: async () => ({ mode: "open", revision: 0 }), proposeNext: async () => script.shift()! },
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
        initialCriteria: async () => ({ mode: "open", revision: 0 }),
        proposeNext: async (input) => {
          seen = input.capabilities;
          return { kind: "completion_candidate", summary: "", evidenceRefs: [] };
        },
      },
      capabilitiesOf: () => [readCap()],
    });
    await orch.advance(wf.id);
    // The reserved advisory capability is always offered (CAPABILITY_SPEC.md §6).
    expect(seen).toEqual([
      readCap(),
      {
        name: "human.manual_action",
        side_effect: false,
        interruptible: true,
        idempotent: false,
        output_type: "manual_action_result",
        input_schema: {
          type: "object",
          required: ["instruction"],
          properties: { instruction: { type: "string" } },
        },
        output_schema: {
          type: "object",
          required: ["outcome", "observation"],
          properties: {
            outcome: { type: "string", enum: ["succeeded", "failed", "partially", "unknown"] },
            observation: { type: "string" },
            details: { type: "object" },
          },
        },
      },
    ]);
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
        initialCriteria: async () => ({ mode: "open", revision: 0 }),
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

describe("side-effect blocking (WORKFLOW_SPEC.md §4.3)", () => {
  const resetCap = (over: Partial<NormalizedCapability> = {}): NormalizedCapability => ({
    name: "sim_rig.trigger_reset",
    side_effect: true,
    interruptible: false,
    idempotent: false,
    ...over,
  });

  async function unknownWorkflow(engine: WorkflowEngine): Promise<string> {
    const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
    const reset = await engine.dispatchStep(wf.id, {
      objective: "reset",
      capability: "sim_rig.trigger_reset",
      sideEffect: true,
      interruptible: false,
    });
    await engine.applyStepStatus(wf.id, reset.id, { state: "RUNNING" });
    await engine.applyStepStatus(wf.id, reset.id, { state: "UNKNOWN" });
    return wf.id;
  }

  it("withholds side-effect capabilities from the planner while an UNKNOWN awaits reconciliation", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const workflowId = await unknownWorkflow(engine);

    let seen: NormalizedCapability[] = [];
    const orch = new WorkflowOrchestrator({
      engine,
      store,
      planner: {
        initialCriteria: async () => ({ mode: "open", revision: 0 }),
        proposeNext: async (input) => {
          seen = input.capabilities;
          return { kind: "completion_candidate", summary: "", evidenceRefs: [] };
        },
      },
      capabilitiesOf: () => [readCap(), resetCap()],
    });
    await orch.advance(workflowId);

    expect(seen.map((capability) => capability.name)).toEqual([
      "git.collect_diagnostics",
      "human.manual_action",
    ]);
  });

  it("fails deterministically if a planner proposes a side effect anyway", async () => {
    const store = new PostgresWorkflowStore(pool);
    const engine = new WorkflowEngine({ store, now: () => 1000 });
    const workflowId = await unknownWorkflow(engine);

    const orch = new WorkflowOrchestrator({
      engine,
      store,
      planner: {
        initialCriteria: async () => ({ mode: "open", revision: 0 }),
        proposeNext: async () => ({
          kind: "step",
          step: {
            objective: "reset again",
            capability: "sim_rig.trigger_reset",
            sideEffect: true,
            interruptible: false,
          },
        }),
      },
      capabilitiesOf: () => [readCap(), resetCap()],
    });

    expect(await orch.advance(workflowId)).toEqual({});
    const after = (await engine.get(workflowId))!;
    expect(after.state).toBe("FAILED");
    expect(after.terminalReason).toBe("planner_error");
    // Only the original side effect exists; nothing new reached the device.
    expect(await store.listSteps(workflowId)).toHaveLength(1);
  });
});
