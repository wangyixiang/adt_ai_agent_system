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
    blobPreview: async () => ({ kind: "binary", mediaType: "application/octet-stream", size: 0 }),
    blobSave: async () => ({ saved: true, path: "x.bin" }),
    configGet: async () => ({ serverUrl: "ws://127.0.0.1:8080/ws", workspaceRoot: "", configured: true }),
    configSet: async (serverUrl, workspaceRoot) => ({
      serverUrl,
      workspaceRoot: workspaceRoot ?? "",
      configured: true,
    }),
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

function pastRecord(recordId: string, workflowId: string, problem: string): UiRecord {
  return {
    record_id: recordId,
    workflow_id: workflowId,
    created_at: 0,
    ended_at: 1,
    terminal_state: "COMPLETED",
    terminal_reason: null,
    user_request: { text: problem },
    summary: { problem_short: problem, terminal_state: "COMPLETED", result_short: "", duration_ms: 1 },
    entries: [],
    final_result: {},
  };
}

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
    expect(within(screen.getByTestId("workbench")).getByText(/Record: rec_1/)).toBeTruthy();

    // The thread's step row points at the workbench node (spec §6.3).
    const user = userEvent.setup();
    await user.click(thread.getByText("git.collect_diagnostics"));
    expect(screen.getByTestId("workbench").querySelector('[data-focused="true"]')).toBeTruthy();
  });

  it("keeps the Record id out of the thread (the workbench owns it)", async () => {
    let push!: (e: MainEvent) => void;
    const client = fakeClient({ onEvent: (l) => { push = l; return () => undefined; } });
    render(<App client={client} />);
    await screen.findByTestId("app");
    act(() => {
      pushUi(push, { id: 1, type: "workflow.created", workflowId: "wf_1", userRequest: { text: "x" } });
      pushUi(push, { id: 2, type: "workflow.terminated", workflowId: "wf_1", terminalState: "COMPLETED", terminalReason: null, recordId: "rec_1" });
    });
    const thread = within(screen.getByRole("main"));
    expect(await thread.findByText(/工作流已终止/)).toBeTruthy();
    expect(thread.queryByText(/Record: rec_1/)).toBeNull();
    expect(within(screen.getByTestId("workbench")).getByText(/Record: rec_1/)).toBeTruthy();
  });

  it("shows a step's objective once, even while its ask is open", async () => {
    let push!: (e: MainEvent) => void;
    const client = fakeClient({ onEvent: (l) => { push = l; return () => undefined; } });
    render(<App client={client} />);
    await screen.findByTestId("app");

    act(() => {
      pushUi(push, { id: 1, type: "step.dispatched", workflowId: "wf_1", stepId: "st_1", capability: "sim_rig.trigger_reset", objective: "复位测试台", input: {}, requiresConfirmation: true });
      pushUi(push, { id: 2, type: "ask", workflowId: "wf_1", ask: { askId: "ask_k", kind: "confirmation", stepId: "st_1", capability: "sim_rig.trigger_reset", objective: "复位测试台", input: {} } });
    });

    const thread = within(screen.getByRole("main"));
    await thread.findByText("复位测试台");
    expect(thread.getAllByText("复位测试台")).toHaveLength(1);
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
    expect(within(screen.getByTestId("workbench")).getByText(/Record: rec_9/)).toBeTruthy();
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

  it("generates a report and shows it in the viewer", async () => {
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
    const asked: Array<[string, string | undefined]> = [];
    const client = fakeClient({
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: past.summary }],
        nextCursor: null,
      }),
      record: async () => past,
      report: async (recordId, detailLevel) => {
        asked.push([recordId, detailLevel]);
        return { ok: true, markdown: "# 结论\n好了" };
      },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /生成报告/ }));
    const viewer = await screen.findByTestId("report-viewer");
    expect(within(viewer).getByText(/结论/)).toBeTruthy();
    expect(asked).toEqual([["rec_9", "full"]]);
  });

  it("shows the export result honestly (received, not indexed)", async () => {
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
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: past.summary }],
        nextCursor: null,
      }),
      record: async () => past,
      export: async () => ({ ok: true, errorCode: null, message: null }),
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /导出/ }));
    expect(await screen.findByText(/端点已接收/)).toBeTruthy();
    expect(screen.getByText(/不表示已被收录|收录/)).toBeTruthy();
  });

  it("shows the report error instead of a body when generation fails", async () => {
    const client = fakeClient({
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: pastRecord("rec_9", "wf_9", "第九").summary }],
        nextCursor: null,
      }),
      record: async () => pastRecord("rec_9", "wf_9", "第九"),
      report: async () => ({ ok: false, errorCode: "insufficient_content", message: "record too thin" }),
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /生成报告/ }));
    const viewer = await screen.findByTestId("report-viewer");
    expect(within(viewer).getByRole("alert")).toBeTruthy();
    expect(within(viewer).getByText(/insufficient_content/)).toBeTruthy();
    expect(within(viewer).queryByRole("button", { name: "复制" })).toBeNull();
  });

  it("does not claim success when the save is cancelled", async () => {
    const client = fakeClient({
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: pastRecord("rec_9", "wf_9", "第九").summary }],
        nextCursor: null,
      }),
      record: async () => pastRecord("rec_9", "wf_9", "第九"),
      report: async () => ({ ok: true, markdown: "# 结论" }),
      saveText: async () => ({ saved: false }),
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /生成报告/ }));
    const viewer = await screen.findByTestId("report-viewer");
    await user.click(within(viewer).getByRole("button", { name: /另存为/ }));
    expect(screen.queryByText(/已保存报告/)).toBeNull();
  });

  it("confirms a successful save, naming the file after the Record", async () => {
    const saved: string[] = [];
    const client = fakeClient({
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: pastRecord("rec_9", "wf_9", "第九").summary }],
        nextCursor: null,
      }),
      record: async () => pastRecord("rec_9", "wf_9", "第九"),
      report: async () => ({ ok: true, markdown: "# 结论" }),
      saveText: async (name) => {
        saved.push(name);
        return { saved: true, path: "/tmp/report.md" };
      },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /生成报告/ }));
    const viewer = await screen.findByTestId("report-viewer");
    await user.click(within(viewer).getByRole("button", { name: /另存为/ }));
    expect(await screen.findByText(/已保存报告/)).toBeTruthy();
    expect(saved).toEqual(["report-rec_9.md"]);
  });

  it("says the KB endpoint is unconfigured, distinctly", async () => {
    const client = fakeClient({
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: pastRecord("rec_9", "wf_9", "第九").summary }],
        nextCursor: null,
      }),
      record: async () => pastRecord("rec_9", "wf_9", "第九"),
      export: async () => ({ ok: false, errorCode: "export_unavailable", message: null }),
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /导出到知识库/ }));
    expect(await screen.findByText(/未配置 KB 端点/)).toBeTruthy();
  });

  it("can export the generated Report", async () => {
    const asked: Array<[string, string]> = [];
    const client = fakeClient({
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: pastRecord("rec_9", "wf_9", "第九").summary }],
        nextCursor: null,
      }),
      record: async () => pastRecord("rec_9", "wf_9", "第九"),
      report: async () => ({ ok: true, markdown: "# 结论" }),
      export: async (recordId, object) => {
        asked.push([recordId, object]);
        return { ok: true, errorCode: null, message: null };
      },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /生成报告/ }));
    await user.click(within(screen.getByTestId("report-viewer")).getByRole("button", { name: "关闭" }));
    await user.selectOptions(screen.getByLabelText("导出"), "report");
    await user.click(screen.getByRole("button", { name: /导出到知识库/ }));
    expect(asked).toEqual([["rec_9", "report"]]);
  });

  it("does not let an export notice follow you to another conversation", async () => {
    const nine = pastRecord("rec_9", "wf_9", "第九");
    const eight = pastRecord("rec_8", "wf_8", "第八");
    const client = fakeClient({
      records: async () => ({
        records: [
          { recordId: "rec_9", workflowId: "wf_9", summary: nine.summary },
          { recordId: "rec_8", workflowId: "wf_8", summary: eight.summary },
        ],
        nextCursor: null,
      }),
      record: async (id) => (id === "rec_9" ? nine : eight),
      export: async () => ({ ok: true, errorCode: null, message: null }),
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /导出到知识库/ }));
    expect(await screen.findByText(/端点已接收/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /第八/ }));
    await waitFor(() => expect(screen.queryByText(/端点已接收/)).toBeNull());
  });

  it("submits the composer's attachment with the request", async () => {
    const seen: Array<{ text: string; attachments: Array<{ name: string }> }> = [];
    const client = fakeClient({
      submit: async (text, attachments) => {
        seen.push({ text, attachments });
        return "wf_1";
      },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("添加附件"), new File(["hi"], "note.txt", { type: "text/plain" }));
    await user.type(screen.getByPlaceholderText(/请求/), "看附件");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.attachments[0]).toMatchObject({ name: "note.txt" });
  });

  it("sends the manual action's note as details", async () => {
    const answers: unknown[] = [];
    let push!: (e: MainEvent) => void;
    const client = fakeClient({
      onEvent: (l) => {
        push = l;
        return () => undefined;
      },
      answer: async (askId, body) => {
        answers.push({ askId, body });
      },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    act(() => {
      pushUi(push, {
        id: 1,
        type: "ask",
        workflowId: "wf_1",
        ask: {
          askId: "ask_m",
          kind: "manual_action",
          stepId: "st_1",
          capability: "human.manual_action",
          objective: "换线",
          instruction: "断电后更换电源线",
          outcomes: ["succeeded", "failed", "partially", "unknown"],
        },
      });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "已成功" }));
    await user.type(screen.getByPlaceholderText(/观察/), "换好了");
    await user.type(screen.getByPlaceholderText(/补充说明/), "换了根新线");
    await user.click(screen.getByRole("button", { name: /提交/ }));
    expect(answers).toEqual([
      {
        askId: "ask_m",
        body: {
          kind: "manual_action",
          outcome: "succeeded",
          observation: "换好了",
          details: { note: "换了根新线" },
        },
      },
    ]);
  });

  it("previews an evidence blob from a past run", async () => {
    const past: UiRecord = {
      ...pastRecord("rec_9", "wf_9", "第九"),
      entries: [
        { entry_id: "e1", ts: 1, kind: "step_dispatched", ref: { step_id: "st_1", capability: "c", objective: "o", input: {} }, narrative: "n" },
        { entry_id: "e2", ts: 2, kind: "evidence_received", ref: { step_id: "st_1", evidence: { type: "log", result: { content_ref: "blob_x", media_type: "text/plain", size: 5 } } }, narrative: "n" },
      ],
    };
    const seen: string[] = [];
    const client = fakeClient({
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: past.summary }],
        nextCursor: null,
      }),
      record: async () => past,
      blobPreview: async (contentRef) => {
        seen.push(contentRef);
        return { kind: "text", mediaType: "text/plain", text: "log line" };
      },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /预览证据/ }));
    const viewer = await screen.findByTestId("blob-viewer");
    expect(within(viewer).getByText("log line")).toBeTruthy();
    expect(seen).toEqual(["blob_x"]);
  });

  it("keeps the composer's draft when the submit is rejected", async () => {
    const client = fakeClient({
      submit: async () => {
        throw new Error("too_many: 最多 10 个附件");
      },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/请求/), "看附件");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect((screen.getByPlaceholderText(/请求/) as HTMLInputElement).value).toBe("看附件");
    });
    expect(await screen.findByText(/too_many/)).toBeTruthy();
  });

  it("carries a manual action's attachment in details", async () => {
    const answers: unknown[] = [];
    let push!: (e: MainEvent) => void;
    const client = fakeClient({
      onEvent: (l) => {
        push = l;
        return () => undefined;
      },
      answer: async (askId, body) => {
        answers.push({ askId, body });
      },
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    act(() => {
      pushUi(push, {
        id: 1,
        type: "ask",
        workflowId: "wf_1",
        ask: {
          askId: "ask_m",
          kind: "manual_action",
          stepId: "st_1",
          capability: "human.manual_action",
          objective: "换线",
          instruction: "断电后更换电源线",
          outcomes: ["succeeded", "failed", "partially", "unknown"],
        },
      });
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("radio", { name: "已成功" }));
    await user.type(screen.getByPlaceholderText(/观察/), "换好了");
    await user.upload(screen.getByLabelText("添加证据附件"), new File(["hi"], "ev.txt", { type: "text/plain" }));
    await user.click(screen.getByRole("button", { name: /提交/ }));

    const body = (answers[0] as { body: { details?: { attachments?: unknown[] } } }).body;
    expect(body.details?.attachments).toHaveLength(1);
  });

  it("offers report and export as soon as a run terminates, before the list refetches", async () => {
    let push!: (e: MainEvent) => void;
    const client = fakeClient({
      onEvent: (l) => {
        push = l;
        return () => undefined;
      },
      records: async () => ({ records: [], nextCursor: null }),
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    act(() => {
      pushUi(push, { id: 1, type: "workflow.created", workflowId: "wf_1", userRequest: { text: "跑一下" } });
      pushUi(push, { id: 2, type: "step.dispatched", workflowId: "wf_1", stepId: "st_1", capability: "c", objective: "做", input: {}, requiresConfirmation: false });
      pushUi(push, { id: 3, type: "workflow.terminated", workflowId: "wf_1", terminalState: "COMPLETED", terminalReason: null, recordId: "rec_x" });
    });
    const wb = within(await screen.findByTestId("workbench"));
    expect(await wb.findByRole("button", { name: /生成报告/ })).toBeTruthy();
  });

  it("confirms a copy of the report", async () => {
    const client = fakeClient({
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: pastRecord("rec_9", "wf_9", "第九").summary }],
        nextCursor: null,
      }),
      record: async () => pastRecord("rec_9", "wf_9", "第九"),
      report: async () => ({ ok: true, markdown: "# 结论" }),
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /生成报告/ }));
    const viewer = await screen.findByTestId("report-viewer");
    await user.click(within(viewer).getByRole("button", { name: "复制" }));
    expect(await screen.findByText(/已复制报告/)).toBeTruthy();
  });

  it("surfaces an export failure with its code", async () => {
    const client = fakeClient({
      records: async () => ({
        records: [{ recordId: "rec_9", workflowId: "wf_9", summary: pastRecord("rec_9", "wf_9", "第九").summary }],
        nextCursor: null,
      }),
      record: async () => pastRecord("rec_9", "wf_9", "第九"),
      export: async () => ({ ok: false, errorCode: "export_failed", message: "boom" }),
    });
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /导出到知识库/ }));
    expect(await screen.findByText(/export_failed/)).toBeTruthy();
  });

  it("shows the settings page on first run instead of the login page", async () => {
    const client = fakeClient({
      configGet: async () => ({ serverUrl: "ws://127.0.0.1:8080/ws", workspaceRoot: "", configured: false }),
    });
    render(<App client={client} />);
    expect(await screen.findByTestId("settings")).toBeTruthy();
    expect(screen.queryByLabelText("用户名")).toBeNull();
  });

  it("saves from the settings page and then shows the login", async () => {
    const saved: string[] = [];
    const client = fakeClient({
      snapshot: async () => disconnected,
      configGet: async () => ({ serverUrl: "", workspaceRoot: "", configured: false }),
      configSet: async (serverUrl) => {
        saved.push(serverUrl);
        return { serverUrl, workspaceRoot: "", configured: true };
      },
    });
    render(<App client={client} />);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Server 地址/), "ws://127.0.0.1:8080/ws");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(await screen.findByLabelText("用户名")).toBeTruthy();
    expect(saved).toEqual(["ws://127.0.0.1:8080/ws"]);
  });

  it("reopens the settings from the app", async () => {
    const client = fakeClient();
    render(<App client={client} />);
    await screen.findByTestId("app");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "设置" }));
    expect(await screen.findByTestId("settings")).toBeTruthy();
  });

  it("says so when the config cannot be loaded, instead of spinning forever", async () => {
    const client = fakeClient({
      configGet: async () => {
        throw new Error("config unreadable");
      },
    });
    render(<App client={client} />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/config unreadable/)).toBeTruthy();
    expect(screen.queryByTestId("app-bar")).toBeNull();
    expect(screen.queryByTestId("settings")).toBeNull();
  });

  it("shows the app bar and opens settings from it", async () => {
    const client = fakeClient();
    render(<App client={client} />);
    const bar = await screen.findByTestId("app-bar");
    expect(within(bar).getByText("已连接")).toBeTruthy();
    const user = userEvent.setup();
    await user.click(within(bar).getByRole("button", { name: "设置" }));
    expect(await screen.findByTestId("settings")).toBeTruthy();
  });

  it("has exactly one settings button, one connection label, and a three-pane body", async () => {
    const client = fakeClient();
    render(<App client={client} />);
    await screen.findByTestId("app-bar");
    expect(screen.getAllByRole("button", { name: "设置" })).toHaveLength(1);
    // Connection has a single home: the app bar (spec §6.3).
    expect(screen.getAllByText("已连接")).toHaveLength(1);
    expect(screen.getByTestId("conversation-list")).toBeTruthy();
    // The list is a pane even when empty: its geometry must not collapse.
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(screen.getByRole("main")).toBeTruthy();
    expect(screen.getByTestId("workbench")).toBeTruthy();
  });

  it("does not render the app bar before sign-in", async () => {
    const client = fakeClient({ snapshot: async () => disconnected });
    render(<App client={client} />);
    expect(await screen.findByLabelText("用户名")).toBeTruthy();
    expect(screen.queryByTestId("app-bar")).toBeNull();
  });
});
