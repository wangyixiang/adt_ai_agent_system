import { describe, it, expect } from "vitest";

import type { UiEvent, UiSnapshot } from "../../shared/contract";
import { applyEvent, deriveTranscript, type TranscriptItem } from "./transcript";

const snapshot: UiSnapshot = {
  connection: "connected",
  userId: "usr_1",
  capabilities: ["git.collect_diagnostics"],
  workflows: [],
};

const run: UiEvent[] = [
  { id: 1, type: "workflow.created", workflowId: "wf_1", userRequest: { text: "项目起不来了" } },
  {
    id: 2,
    type: "step.dispatched",
    workflowId: "wf_1",
    stepId: "st_1",
    capability: "git.collect_diagnostics",
    objective: "先收集诊断信息",
    input: { maxLines: 200 },
    requiresConfirmation: false,
  },
  { id: 3, type: "step.status", workflowId: "wf_1", stepId: "st_1", state: "RUNNING" },
  {
    id: 4,
    type: "step.status",
    workflowId: "wf_1",
    stepId: "st_1",
    state: "COMPLETED",
    evidenceSummary: "git_status: clean",
  },
  {
    id: 5,
    type: "workflow.terminated",
    workflowId: "wf_1",
    terminalState: "COMPLETED",
    terminalReason: null,
    recordId: "rec_1",
  },
];

const kinds = (items: TranscriptItem[]): string[] => items.map((item) => item.kind);

describe("deriveTranscript", () => {
  it("builds user → assistant → tool → summary from the events", () => {
    const items = deriveTranscript(snapshot, run);
    expect(kinds(items)).toEqual(["user", "assistant", "tool", "summary"]);
    expect(items[0]).toMatchObject({ kind: "user", text: "项目起不来了" });
    expect(items[2]).toMatchObject({
      kind: "tool",
      capability: "git.collect_diagnostics",
      input: { maxLines: 200 },
      state: "COMPLETED",
      evidenceSummary: "git_status: clean",
    });
    expect(items[3]).toMatchObject({ kind: "summary", terminalState: "COMPLETED", recordId: "rec_1" });
  });

  it("applies an event with a duplicate id only once", () => {
    expect(deriveTranscript(snapshot, [...run, run[1]!, { ...run[3]! }])).toEqual(
      deriveTranscript(snapshot, run),
    );
  });

  it("is order-independent", () => {
    const shuffled = [run[3]!, run[0]!, run[4]!, run[2]!, run[1]!];
    expect(deriveTranscript(snapshot, shuffled)).toEqual(deriveTranscript(snapshot, run));
  });

  it("keeps the two kinds of `unknown` apart", () => {
    const events: UiEvent[] = [
      { id: 1, type: "workflow.created", workflowId: "wf_1", userRequest: { text: "重启服务" } },
      {
        id: 2,
        type: "step.dispatched",
        workflowId: "wf_1",
        stepId: "st_1",
        capability: "system.restart",
        objective: "重启服务",
        input: {},
        requiresConfirmation: false,
      },
      { id: 3, type: "step.status", workflowId: "wf_1", stepId: "st_1", state: "UNKNOWN" },
      {
        id: 4,
        type: "ask",
        workflowId: "wf_1",
        ask: {
          askId: "ask_1",
          kind: "manual_action",
          stepId: "st_1",
          capability: "system.restart",
          objective: "重启服务",
          instruction: "手动重启后告诉我结果",
          outcomes: ["succeeded", "failed", "partially", "unknown"],
        },
      },
      {
        id: 5,
        type: "ask.answered",
        workflowId: "wf_1",
        askId: "ask_1",
        answer: { kind: "manual_action", outcome: "unknown", observation: "看不出来" },
      },
    ];
    const items = deriveTranscript(snapshot, events);
    const tool = items.find((item) => item.kind === "tool")!;
    const ask = items.find((item) => item.kind === "ask")!;
    expect(tool.text).toContain("系统");
    expect(ask.text).toContain("人");
    expect(tool.text).not.toBe(ask.text);
  });

  it("rebuilds a transcript from the snapshot alone, including a pending ask", () => {
    const only: UiSnapshot = {
      connection: "connected",
      userId: "usr_1",
      capabilities: [],
      workflows: [
        {
          workflowId: "wf_1",
          userRequest: { text: "刷新前的请求" },
          terminalState: null,
          terminalReason: null,
          recordId: null,
          pendingAskId: "ask_9",
          pendingAsk: {
            askId: "ask_9",
            kind: "completion",
            workflowId: "wf_1",
            summary: "看起来好了",
            evidenceRefs: [],
          },
          steps: [],
        },
      ],
    };
    const items = deriveTranscript(only, []);
    expect(kinds(items)).toEqual(["user", "ask"]);
    expect(items[1]).toMatchObject({ kind: "ask", askId: "ask_9", askKind: "completion", answered: false });
  });
});

describe("applyEvent", () => {
  it("folds events in and ignores an id it already has", () => {
    let state = { snapshot, events: [] as UiEvent[] };
    state = applyEvent(state, run[0]!);
    state = applyEvent(state, run[1]!);
    const before = state.events.length;
    state = applyEvent(state, { ...run[1]! });
    expect(state.events).toHaveLength(before);
  });
});
