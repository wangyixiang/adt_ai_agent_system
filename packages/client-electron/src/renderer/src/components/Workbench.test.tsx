// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TranscriptItem } from "../transcript";
import { Workbench, type WorkbenchProps } from "./Workbench";

const tool: TranscriptItem = {
  key: "tool:wf_1:st_1",
  kind: "tool",
  workflowId: "wf_1",
  stepId: "st_1",
  capability: "git.collect_diagnostics",
  objective: "先收集诊断信息",
  input: {},
  state: "COMPLETED",
  requiresConfirmation: false,
  evidenceSummary: "git_status: clean",
  text: "完成",
};

const summary: TranscriptItem = {
  key: "summary:wf_1",
  kind: "summary",
  workflowId: "wf_1",
  terminalState: "COMPLETED",
  terminalReason: null,
  recordId: "rec_1",
  text: "工作流已终止：COMPLETED",
};

const base: WorkbenchProps = {
  items: [tool, summary] as TranscriptItem[],
  cancelling: false,
  canCancel: false,
  onCancel: () => undefined,
  recordId: null as string | null,
  reportReady: false,
  onGenerateReport: () => undefined,
  onExport: () => undefined,
};
const show = (over: Partial<WorkbenchProps> = {}) => render(<Workbench {...base} {...over} />);

describe("the workbench", () => {
  it("shows an empty state when there is nothing to show", () => {
    show({ items: [] });
    expect(screen.getByText(/还没有可看的工作台内容/)).toBeTruthy();
  });

  it("shows the steps and the conclusion", () => {
    show();
    expect(screen.getByText("git.collect_diagnostics")).toBeTruthy();
    expect(screen.getByText("先收集诊断信息")).toBeTruthy();
    expect(screen.getByText(/Record: rec_1/)).toBeTruthy();
  });

  it("confirms before cancelling, and cancels at most once", async () => {
    const cancelled: string[] = [];
    show({
      items: [tool],
      canCancel: true,
      onCancel: (id) => {
        cancelled.push(id);
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "确定取消" }));
    expect(cancelled).toEqual(["wf_1"]);
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("does not offer cancel for a past run", () => {
    show();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("shows CANCELLING and hides the button while it converges", () => {
    show({ items: [tool], cancelling: true, canCancel: true });
    expect(screen.getByText(/正在取消/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("restores the cancel button when the request fails", async () => {
    show({
      items: [tool],
      canCancel: true,
      onCancel: async () => {
        throw new Error("cancel failed");
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "确定取消" }));
    expect(await screen.findByRole("button", { name: "取消" })).toBeTruthy();
  });

  it("shows the completion candidate and a step's decision", () => {
    const candidate: TranscriptItem = {
      key: "ask:wf_1:ask_c",
      kind: "ask",
      workflowId: "wf_1",
      askId: "ask_c",
      ask: { askId: "ask_c", kind: "completion", workflowId: "wf_1", summary: "看起来好了", evidenceRefs: ["st_1"] },
      askKind: "completion",
      answered: false,
      stepId: null,
      text: "有一个完成候选在等你判断",
    };
    const decision: TranscriptItem = {
      key: "ask:wf_1:a1",
      kind: "ask",
      workflowId: "wf_1",
      askId: "a1",
      ask: null,
      askKind: "confirmation",
      answered: true,
      stepId: "st_1",
      text: "已确认",
    };
    show({ items: [tool, decision, candidate] });
    expect(screen.getByText("已确认")).toBeTruthy();
    expect(screen.getByText(/看起来好了/)).toBeTruthy();
  });

  it("offers report and export once a Record exists", async () => {
    const generated: string[] = [];
    const exported: string[] = [];
    show({
      recordId: "rec_1",
      reportReady: false,
      onGenerateReport: (level) => generated.push(level),
      onExport: (object) => exported.push(object),
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /生成报告/ }));
    expect(generated).toEqual(["full"]);
    await user.click(screen.getByRole("button", { name: /导出/ }));
    expect(exported).toEqual(["record"]);
  });

  it("hides report and export while the run is still going", () => {
    show({ items: [tool], canCancel: true, recordId: null });
    expect(screen.queryByRole("button", { name: /生成报告/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /导出/ })).toBeNull();
  });

  it("explains why Report export is unavailable before a report exists", () => {
    show({ recordId: "rec_1", reportReady: false });
    expect(screen.getByText(/生成一次报告后/)).toBeTruthy();
  });
});
