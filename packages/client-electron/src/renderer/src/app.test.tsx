// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { MainEvent, UiEvent, UiRecord, UiSnapshot } from "../../shared/contract";
import type { AdtClient } from "./api";
import { App } from "./app";

const disconnected: UiSnapshot = {
  connection: "disconnected",
  userId: null,
  capabilities: [],
  workflows: [],
};

const connected = (workflows: UiSnapshot["workflows"] = []): UiSnapshot => ({
  connection: "connected",
  userId: "usr_1",
  capabilities: ["git.collect_diagnostics"],
  workflows,
});

function fakeClient(overrides: Partial<AdtClient> = {}): AdtClient {
  return {
    snapshot: async () => connected(),
    login: async () => undefined,
    submit: async () => "wf_1",
    answer: async () => undefined,
    records: async () => ({ records: [], nextCursor: null }),
    record: async () => {
      throw new Error("record is not used in this test");
    },
    onEvent: () => () => undefined,
    ...overrides,
  };
}

const pushUi = (push: (e: MainEvent) => void, event: UiEvent): void =>
  push({ type: "ui", event });

describe("the app", () => {
  it("shows the login error instead of pretending to be in", async () => {
    const client = fakeClient({
      snapshot: async () => disconnected,
      login: async () => {
        throw new Error("auth_failed: 账号或密码不对");
      },
    });
    render(<App client={client} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("用户名"), "alice");
    await user.type(screen.getByLabelText("密码"), "wrong");
    await user.click(screen.getByRole("button", { name: /登录/ }));
    expect(await screen.findByText(/auth_failed/)).toBeTruthy();
    expect(screen.queryByTestId("app")).toBeNull();
  });

  it("renders the transcript from a snapshot and a stream of events", async () => {
    let push!: (e: MainEvent) => void;
    const client = fakeClient({ onEvent: (l) => { push = l; return () => undefined; } });
    render(<App client={client} />);
    await screen.findByTestId("app");

    act(() => {
      pushUi(push, { id: 1, type: "workflow.created", workflowId: "wf_1", userRequest: { text: "项目起不来了" } });
      pushUi(push, { id: 2, type: "step.dispatched", workflowId: "wf_1", stepId: "st_1", capability: "git.collect_diagnostics", objective: "先收集诊断信息", input: { maxLines: 200 }, requiresConfirmation: false });
      pushUi(push, { id: 3, type: "step.status", workflowId: "wf_1", stepId: "st_1", state: "COMPLETED", evidenceSummary: "git_status: clean" });
      pushUi(push, { id: 4, type: "workflow.terminated", workflowId: "wf_1", terminalState: "COMPLETED", terminalReason: null, recordId: "rec_1" });
    });

    expect(await screen.findByText("先收集诊断信息")).toBeTruthy();
    expect(screen.getByText("完成")).toBeTruthy();
    expect(screen.getByText(/maxLines/)).toBeTruthy();
    expect(screen.getByText(/Record: rec_1/)).toBeTruthy();
  });

  it("answers a confirmation from the card", async () => {
    const answers: unknown[] = [];
    let push!: (e: MainEvent) => void;
    const client = fakeClient({
      onEvent: (l) => { push = l; return () => undefined; },
      answer: async (askId, body) => { answers.push({ askId, body }); },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    act(() => {
      pushUi(push, {
        id: 1,
        type: "ask",
        workflowId: "wf_1",
        ask: { askId: "ask_k", kind: "confirmation", stepId: "st_1", capability: "sim_rig.trigger_reset", objective: "复位测试台", input: {} },
      });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "拒绝" }));
    expect(answers).toEqual([{ askId: "ask_k", body: { kind: "confirmation", decision: "declined" } }]);
  });

  it("answers a manual action from the card", async () => {
    const answers: unknown[] = [];
    let push!: (e: MainEvent) => void;
    const client = fakeClient({
      onEvent: (l) => { push = l; return () => undefined; },
      answer: async (askId, body) => { answers.push({ askId, body }); },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    act(() => {
      pushUi(push, {
        id: 1,
        type: "ask",
        workflowId: "wf_1",
        ask: { askId: "ask_m", kind: "manual_action", stepId: "st_1", capability: "human.manual_action", objective: "换线", instruction: "断电后更换电源线", outcomes: ["succeeded", "failed", "partially", "unknown"] },
      });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "部分成功" }));
    await user.type(screen.getByPlaceholderText(/观察/), "只换了一半");
    await user.click(screen.getByRole("button", { name: /提交/ }));
    expect(answers).toEqual([
      { askId: "ask_m", body: { kind: "manual_action", outcome: "partially", observation: "只换了一半" } },
    ]);
  });

  it("does not submit a manual action without an observation", async () => {
    const answers: unknown[] = [];
    let push!: (e: MainEvent) => void;
    const client = fakeClient({
      onEvent: (l) => { push = l; return () => undefined; },
      answer: async (askId, body) => { answers.push({ askId, body }); },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    act(() => {
      pushUi(push, {
        id: 1,
        type: "ask",
        workflowId: "wf_1",
        ask: { askId: "ask_m", kind: "manual_action", stepId: "st_1", capability: "human.manual_action", objective: "换线", instruction: "断电后更换电源线", outcomes: ["succeeded", "failed", "partially", "unknown"] },
      });
    });
    const submit = await screen.findByRole("button", { name: /提交/ });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(answers).toHaveLength(0);
  });

  it("answers a resource conflict from the card", async () => {
    const answers: unknown[] = [];
    let push!: (e: MainEvent) => void;
    const client = fakeClient({
      onEvent: (l) => { push = l; return () => undefined; },
      answer: async (askId, body) => { answers.push({ askId, body }); },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    act(() => {
      pushUi(push, {
        id: 1,
        type: "ask",
        workflowId: "wf_1",
        ask: { askId: "ask_r", kind: "resource_conflict", stepId: "st_1", capability: "sim_rig.trigger_reset", objective: "复位测试台", message: "测试台正被占用" },
      });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /等待/ }));
    expect(answers).toEqual([{ askId: "ask_r", body: { kind: "resource_conflict", answer: "wait" } }]);
  });

  it("answers a completion from the card", async () => {
    const answers: unknown[] = [];
    let push!: (e: MainEvent) => void;
    const client = fakeClient({
      onEvent: (l) => { push = l; return () => undefined; },
      answer: async (askId, body) => { answers.push({ askId, body }); },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    act(() => {
      pushUi(push, {
        id: 1,
        type: "ask",
        workflowId: "wf_1",
        ask: { askId: "ask_c", kind: "completion", workflowId: "wf_1", summary: "看起来好了", evidenceRefs: [] },
      });
    });
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText(/补充说明/), "我看了下没问题");
    await user.click(screen.getByRole("button", { name: "已解决" }));
    expect(answers).toEqual([
      { askId: "ask_c", body: { kind: "completion", resolution: "solved", feedback: "我看了下没问题" } },
    ]);
  });

  it("lists a past run and shows it reconstructed from its Record", async () => {
    const fetched: string[] = [];
    const pastRecord: UiRecord = {
      record_id: "rec_9",
      workflow_id: "wf_9",
      created_at: 0,
      ended_at: 1000,
      terminal_state: "COMPLETED",
      terminal_reason: null,
      user_request: { text: "旧的一次诊断" },
      summary: {
        problem_short: "旧的一次诊断",
        terminal_state: "COMPLETED",
        result_short: "好了",
        duration_ms: 1000,
      },
      entries: [
        { entry_id: "e1", ts: 1, kind: "step_dispatched", ref: { step_id: "st_1", capability: "git.collect_diagnostics", objective: "查一下日志", input: {} }, narrative: "n" },
        { entry_id: "e2", ts: 2, kind: "step_status", ref: { step_id: "st_1", state: "COMPLETED" }, narrative: "n" },
      ],
      final_result: { resolution_summary: "好了" },
    };
    const client = fakeClient({
      records: async () => ({
        records: [
          {
            recordId: "rec_9",
            workflowId: "wf_9",
            summary: pastRecord.summary,
          },
        ],
        nextCursor: null,
      }),
      record: async (id) => {
        fetched.push(id);
        return pastRecord;
      },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");

    // The list shows the past run, and opening it reconstructs the transcript.
    expect(await screen.findByText("查一下日志")).toBeTruthy();
    expect(screen.getByText(/Record: rec_9/)).toBeTruthy();
    expect(fetched).toEqual(["rec_9"]);
  });

  it("keeps a live run in the list once, even when a Record already exists for it", async () => {
    let push!: (e: MainEvent) => void;
    const client = fakeClient({
      onEvent: (l) => { push = l; return () => undefined; },
      records: async () => ({
        records: [
          {
            recordId: "rec_1",
            workflowId: "wf_1",
            summary: { problem_short: "跑一下", terminal_state: "COMPLETED", result_short: "", duration_ms: 1 },
          },
        ],
        nextCursor: null,
      }),
    });
    render(<App client={client} />);
    await screen.findByTestId("app");

    act(() => {
      pushUi(push, { id: 1, type: "workflow.created", workflowId: "wf_1", userRequest: { text: "跑一下" } });
      pushUi(push, {
        id: 2,
        type: "step.dispatched",
        workflowId: "wf_1",
        stepId: "st_1",
        capability: "git.collect_diagnostics",
        objective: "做",
        input: {},
        requiresConfirmation: false,
      });
    });

    expect(screen.getAllByRole("button", { name: /跑一下/ })).toHaveLength(1);
    expect(screen.getByText("进行中")).toBeTruthy();
    expect((screen.getByPlaceholderText(/请求/) as HTMLInputElement).disabled).toBe(true);
  });

  it("shows an error instead of a blank list when records fail", async () => {
    const client = fakeClient({
      records: async () => {
        throw new Error("bad_token: no session");
      },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/bad_token/)).toBeTruthy();
  });

  it("says there are no conversations yet", async () => {
    const client = fakeClient();
    render(<App client={client} />);
    await screen.findByTestId("app");
    expect(await screen.findByText(/还没有对话/)).toBeTruthy();
  });
});
