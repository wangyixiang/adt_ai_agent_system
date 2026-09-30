import { describe, it, expect } from "vitest";
import { LlmPlanner } from "../../src/workflow/llmPlanner";
import { ScriptedLlmProvider } from "@adt/test-support";
import type { NormalizedCapability } from "@adt/shared";
import type { WorkflowSnapshot } from "../../src/workflow/store";

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
});
