import { describe, it, expect } from "vitest";
import { LlmPlanner } from "../../src/workflow/llmPlanner";
import { ScriptedLlmProvider } from "@adt/test-support";
import type { NormalizedCapability } from "@adt/shared";
import type { StepSnapshot, WorkflowSnapshot } from "../../src/workflow/store";

const caps: NormalizedCapability[] = [
  {
    name: "git.collect_diagnostics",
    side_effect: false,
    interruptible: true,
    idempotent: false,
    input_schema: { type: "object", properties: { project_path: { type: "string" } } },
  },
];
const workflow: WorkflowSnapshot = {
  id: "wf_1",
  userId: "usr_1",
  sessionId: "sess_1",
  userRequest: { text: "x" },
  state: "RUNNING",
  terminalReason: null,
  criteria: { mode: "open", revision: 0, description: "问题消失" },
  createdAt: 0,
  endedAt: null,
  notSolvedRounds: 0,
};

const unknownStep: StepSnapshot = {
  id: "step_unknown",
  workflowId: "wf_1",
  state: "UNKNOWN",
  objective: "复位",
  capability: "sim_rig.trigger_reset",
  sideEffect: true,
  interruptible: false,
  idempotencyKey: "idem_1",
  attempt: 1,
  waitClass: null,
  input: {},
  outputSchema: null,
  updatedAt: 0,
  timeoutMs: 0,
};

describe("LlmPlanner", () => {
  it("parses an initial-criteria tool call", async () => {
    const llm = new ScriptedLlmProvider([
      {
        toolCalls: [
          { name: "set_completion_criteria", arguments: { mode: "open", description: "服务恢复" } },
        ],
      },
    ]);
    const planner = new LlmPlanner({ provider: llm });
    expect(await planner.initialCriteria({ text: "x" }, caps)).toEqual({
      mode: "open",
      revision: 0,
      description: "服务恢复",
    });
  });

  it("parses a step decision and exposes the capability enum to the model", async () => {
    const llm = new ScriptedLlmProvider([
      {
        toolCalls: [
          {
            name: "propose_step",
            arguments: {
              action: "step",
              step: {
                objective: "查看 git",
                capability: "git.collect_diagnostics",
                input: { project_path: "/a" },
              },
            },
          },
        ],
      },
    ]);
    const planner = new LlmPlanner({ provider: llm });
    const decision = await planner.proposeNext({ workflow, steps: [], events: [], capabilities: caps });
    expect(decision).toEqual({
      kind: "step",
      step: {
        objective: "查看 git",
        capability: "git.collect_diagnostics",
        sideEffect: false,
        interruptible: true,
        input: { project_path: "/a" },
      },
    });
    const tool = llm.requests[0]!.tools[0]!;
    expect((tool.parameters as any).properties.step.properties.capability.enum).toEqual([
      "git.collect_diagnostics",
    ]);
    expect(llm.requests[0]!.messages.some((m) => m.content.includes("问题消失"))).toBe(true);
  });

  it("throws on a response with no tool call", async () => {
    const planner = new LlmPlanner({ provider: new ScriptedLlmProvider([{ toolCalls: [] }]) });
    await expect(
      planner.proposeNext({ workflow, steps: [], events: [], capabilities: caps }),
    ).rejects.toThrow();
  });

  it("maps an optional criteria revision from the tool call", async () => {
    const llm = new ScriptedLlmProvider([
      {
        toolCalls: [
          {
            name: "propose_step",
            arguments: {
              action: "completion_candidate",
              completion: { summary: "好了", evidence_refs: [] },
              criteria: { mode: "open", description: "新的完成条件" },
            },
          },
        ],
      },
    ]);
    const planner = new LlmPlanner({ provider: llm });
    const decision = await planner.proposeNext({ workflow, steps: [], events: [], capabilities: caps });
    expect(decision).toEqual({
      kind: "completion_candidate",
      summary: "好了",
      evidenceRefs: [],
      criteria: { mode: "open", description: "新的完成条件" },
    });
    const tool = llm.requests[0]!.tools[0]!;
    expect((tool.parameters as any).properties.criteria).toBeDefined();
  });

  it("parses a reconcile decision and advertises the UNKNOWN step", async () => {
    const llm = new ScriptedLlmProvider([
      {
        toolCalls: [
          {
            name: "propose_step",
            arguments: {
              action: "reconcile",
              reconcile: {
                step_id: "step_unknown",
                outcome: "COMPLETED",
                evidence_refs: ["step_state"],
              },
            },
          },
        ],
      },
    ]);
    const planner = new LlmPlanner({ provider: llm });
    const decision = await planner.proposeNext({
      workflow,
      steps: [unknownStep],
      events: [],
      capabilities: caps,
    });

    expect(decision).toEqual({
      kind: "reconcile",
      stepId: "step_unknown",
      outcome: "COMPLETED",
      evidenceRefs: ["step_state"],
    });
    // The model has to be told which step is reconcilable.
    expect(llm.requests[0]!.messages[1]!.content).toContain("step_unknown");
  });

  it("refuses to reconcile a step that is not UNKNOWN", async () => {
    const llm = new ScriptedLlmProvider([
      {
        toolCalls: [
          {
            name: "propose_step",
            arguments: {
              action: "reconcile",
              reconcile: { step_id: "step_done", outcome: "COMPLETED", evidence_refs: [] },
            },
          },
        ],
      },
    ]);
    const planner = new LlmPlanner({ provider: llm });
    await expect(
      planner.proposeNext({
        workflow,
        steps: [{ ...unknownStep, id: "step_done", state: "COMPLETED" }],
        events: [],
        capabilities: caps,
      }),
    ).rejects.toThrow(/not UNKNOWN/);
  });
});
