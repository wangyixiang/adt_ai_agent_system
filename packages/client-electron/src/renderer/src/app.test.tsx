// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, act, waitFor, within } from "@testing-library/react";
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
    cancel: async () => undefined,
    report: async () => ({ ok: true, markdown: "" }),
    export: async () => ({ ok: true, errorCode: null, message: null }),
    saveText: async () => ({ saved: true, path: "x.md" }),
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

    const thread = within(screen.getByRole("main"));
    expect(await thread.findByText("先收集诊断信息")).toBeTruthy();
    expect(thread.getByText("完成")).toBeTruthy();
    expect(thread.getByText(/maxLines/)).toBeTruthy();
    expect(thread.getByText(/Record: rec_1/)).toBeTruthy();
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
    let push!: (e: MainEvent) => void;
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
      onEvent: (l) => { push = l; return () => undefined; },
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
    const thread = within(screen.getByRole("main"));
    expect(await thread.findByText("查一下日志")).toBeTruthy();
    expect(thread.getByText(/Record: rec_9/)).toBeTruthy();
    expect(fetched).toEqual(["rec_9"]);

    // A re-render must not refetch the same (immutable) Record.
    act(() => {
      pushUi(push, { id: 99, type: "notice", level: "info", message: "ping" });
    });
    expect(fetched).toEqual(["rec_9"]);
  });

  it("follows a newly submitted run even when a past record is in view", async () => {
    let push!: (e: MainEvent) => void;
    const past: UiRecord = {
      record_id: "rec_9",
      workflow_id: "wf_9",
      created_at: 0,
      ended_at: 1,
      terminal_state: "COMPLETED",
      terminal_reason: null,
      user_request: { text: "旧" },
      summary: { problem_short: "旧", terminal_state: "COMPLETED", result_short: "", duration_ms: 1 },
      entries: [],
      final_result: {},
    };
    const client = fakeClient({
      onEvent: (l) => { push = l; return () => undefined; },
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: past.summary }],
        nextCursor: null,
      }),
      record: async () => past,
      submit: async () => "wf_new",
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    expect(await screen.findByText("往期记录")).toBeTruthy();

    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/请求/), "新的问题");
    await user.click(screen.getByRole("button", { name: "发送" }));
    act(() => {
      pushUi(push, { id: 1, type: "workflow.created", workflowId: "wf_new", userRequest: { text: "新的问题" } });
    });

    // The pane follows the new (live) run, not the past record.
    await waitFor(() => expect(screen.queryByText("往期记录")).toBeNull());
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
    expect(within(screen.getByRole("navigation")).getByText("进行中")).toBeTruthy();
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

  it("cancels the selected live run from the workbench", async () => {
    const cancelled: string[] = [];
    let push!: (e: MainEvent) => void;
    const client = fakeClient({
      onEvent: (l) => {
        push = l;
        return () => undefined;
      },
      cancel: async (workflowId) => {
        cancelled.push(workflowId);
      },
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
    const user = userEvent.setup();
    const wb = within(screen.getByTestId("workbench"));
    await user.click(wb.getByRole("button", { name: "取消" }));
    await user.click(wb.getByRole("button", { name: "确定取消" }));
    expect(cancelled).toEqual(["wf_1"]);
  });

  it("shows a past run's workbench without a cancel button", async () => {
    const past: UiRecord = {
      record_id: "rec_9",
      workflow_id: "wf_9",
      created_at: 0,
      ended_at: 1,
      terminal_state: "COMPLETED",
      terminal_reason: null,
      user_request: { text: "旧" },
      summary: { problem_short: "旧", terminal_state: "COMPLETED", result_short: "", duration_ms: 1 },
      entries: [
        { entry_id: "e1", ts: 1, kind: "step_dispatched", ref: { step_id: "st_1", capability: "git.collect_diagnostics", objective: "查日志", input: {} }, narrative: "n" },
        { entry_id: "e2", ts: 2, kind: "step_status", ref: { step_id: "st_1", state: "COMPLETED" }, narrative: "n" },
      ],
      final_result: {},
    };
    const client = fakeClient({
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: past.summary }],
        nextCursor: null,
      }),
      record: async () => past,
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const wb = within(await screen.findByTestId("workbench"));
    expect(wb.getByText("查日志")).toBeTruthy();
    expect(wb.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("offers cancel again for a later run after one was cancelled", async () => {
    const cancelled: string[] = [];
    let push!: (e: MainEvent) => void;
    const client = fakeClient({
      onEvent: (l) => {
        push = l;
        return () => undefined;
      },
      cancel: async (workflowId) => {
        cancelled.push(workflowId);
      },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    act(() => {
      pushUi(push, { id: 1, type: "workflow.created", workflowId: "wf_1", userRequest: { text: "第一条" } });
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
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId("workbench")).getByRole("button", { name: "取消" }));
    await user.click(within(screen.getByTestId("workbench")).getByRole("button", { name: "确定取消" }));
    expect(cancelled).toEqual(["wf_1"]);

    act(() => {
      pushUi(push, { id: 3, type: "workflow.terminated", workflowId: "wf_1", terminalState: "CANCELLED", terminalReason: null, recordId: null });
      pushUi(push, { id: 4, type: "workflow.created", workflowId: "wf_2", userRequest: { text: "第二条" } });
      pushUi(push, {
        id: 5,
        type: "step.dispatched",
        workflowId: "wf_2",
        stepId: "st_2",
        capability: "git.collect_diagnostics",
        objective: "做2",
        input: {},
        requiresConfirmation: false,
      });
    });

    const wb = within(await screen.findByTestId("workbench"));
    expect(await wb.findByRole("button", { name: "取消" })).toBeTruthy();
  });
});
