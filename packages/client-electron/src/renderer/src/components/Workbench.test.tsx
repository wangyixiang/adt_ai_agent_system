// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TranscriptItem } from "../transcript";
import { Workbench, type WorkbenchProps } from "./Workbench";

const tool: Extract<TranscriptItem, { kind: "tool" }> = {
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
  evidenceBlob: null,
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
  onPreviewBlob: () => undefined,
  onSaveBlob: () => undefined,
  focusedStepId: null,
  onLocate: () => undefined,
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
    expect(screen.queryByText(/看起来好了/)).toBeNull();
    expect(screen.getByText("待你决定")).toBeTruthy();
  });

  it("shows the completion decision once it is made", () => {
    const answered: TranscriptItem = {
      key: "ask:wf_1:ask_c",
      kind: "ask",
      workflowId: "wf_1",
      askId: "ask_c",
      ask: { askId: "ask_c", kind: "completion", workflowId: "wf_1", summary: "s", evidenceRefs: ["st_1"] },
      askKind: "completion",
      answered: true,
      stepId: null,
      text: "认为已解决",
    };
    show({ items: [tool, answered] });
    expect(screen.getByText("认为已解决")).toBeTruthy();
    expect(screen.queryByText("待你决定")).toBeNull();
  });

  it("does not offer a locate button for a ref that matches no step", () => {
    const candidate: TranscriptItem = {
      key: "ask:wf_1:ask_c",
      kind: "ask",
      workflowId: "wf_1",
      askId: "ask_c",
      ask: { askId: "ask_c", kind: "completion", workflowId: "wf_1", summary: "s", evidenceRefs: ["ghost"] },
      askKind: "completion",
      answered: false,
      stepId: null,
      text: "t",
    };
    show({ items: [tool, candidate] });
    expect(screen.queryByRole("button", { name: "ghost" })).toBeNull();
    expect(screen.getByText("ghost")).toBeTruthy();
  });

  it("locates the step behind a completion ref", async () => {
    const located: string[] = [];
    const candidate: TranscriptItem = {
      key: "ask:wf_1:ask_c",
      kind: "ask",
      workflowId: "wf_1",
      askId: "ask_c",
      ask: { askId: "ask_c", kind: "completion", workflowId: "wf_1", summary: "s", evidenceRefs: ["st_1"] },
      askKind: "completion",
      answered: false,
      stepId: null,
      text: "t",
    };
    show({ items: [tool, candidate], onLocate: (id) => located.push(id) });
    await userEvent.click(screen.getByRole("button", { name: "st_1" }));
    expect(located).toEqual(["st_1"]);
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

  it("previews a step's evidence blob", async () => {
    const previewed: string[] = [];
    const withBlob: Extract<TranscriptItem, { kind: "tool" }> = {
      ...tool,
      evidenceBlob: { content_ref: "blob_x", media_type: "text/plain", size: 3 },
    };
    show({ items: [withBlob], onPreviewBlob: (contentRef) => previewed.push(contentRef) });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /预览证据/ }));
    expect(previewed).toEqual(["blob_x"]);
  });

  it("shows a step's input and that it needs confirmation", () => {
    const withInput: Extract<TranscriptItem, { kind: "tool" }> = {
      ...tool,
      input: { maxLines: 200 },
      requiresConfirmation: true,
    };
    show({ items: [withInput] });
    expect(screen.getByText(/maxLines/)).toBeTruthy();
    expect(screen.getByText("需要人工确认")).toBeTruthy();
  });

  it("does not render the request's attachments (they belong to the thread)", () => {
    const request: TranscriptItem = {
      key: "user:wf_1",
      kind: "user",
      workflowId: "wf_1",
      text: "看附件",
      attachments: [
        { name: "note.txt", media_type: "text/plain", size: 2, sha256: "a", mode: "inline", data_base64: "aGk=" },
      ],
    };
    show({ items: [request, tool] });
    expect(screen.queryByText("note.txt")).toBeNull();
  });

  it("does not crash when asked to focus a step it does not have", () => {
    show({ items: [tool], focusedStepId: "ghost" });
    expect(screen.getByText("git.collect_diagnostics")).toBeTruthy();
  });

  it("scrolls the focused node once per locate, not on every render", () => {
    const scroll = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scroll;
    const { rerender } = render(<Workbench {...base} focusedStepId="st_1" />);
    const afterMount = scroll.mock.calls.length;
    expect(afterMount).toBeGreaterThan(0);
    rerender(<Workbench {...base} focusedStepId="st_1" />);
    expect(scroll.mock.calls.length).toBe(afterMount);
  });
});
