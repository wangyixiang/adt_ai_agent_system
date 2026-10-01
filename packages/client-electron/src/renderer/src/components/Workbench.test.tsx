// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TranscriptItem } from "../transcript";
import { Workbench } from "./Workbench";

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

describe("the workbench", () => {
  it("shows an empty state when there is nothing to show", () => {
    render(<Workbench items={[]} cancelling={false} canCancel={false} onCancel={() => undefined} />);
    expect(screen.getByText(/还没有可看的工作台内容/)).toBeTruthy();
  });

  it("shows the steps and the conclusion", () => {
    render(
      <Workbench items={[tool, summary]} cancelling={false} canCancel={false} onCancel={() => undefined} />,
    );
    expect(screen.getByText("git.collect_diagnostics")).toBeTruthy();
    expect(screen.getByText("先收集诊断信息")).toBeTruthy();
    expect(screen.getByText(/Record: rec_1/)).toBeTruthy();
  });

  it("confirms before cancelling, and cancels at most once", async () => {
    const cancelled: string[] = [];
    render(
      <Workbench
        items={[tool]}
        cancelling={false}
        canCancel
        onCancel={(id) => {
          cancelled.push(id);
        }}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "确定取消" }));
    expect(cancelled).toEqual(["wf_1"]);
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("does not offer cancel for a past run", () => {
    render(
      <Workbench items={[tool, summary]} cancelling={false} canCancel={false} onCancel={() => undefined} />,
    );
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("shows CANCELLING and hides the button while it converges", () => {
    render(<Workbench items={[tool]} cancelling canCancel onCancel={() => undefined} />);
    expect(screen.getByText(/正在取消/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
  });

  it("restores the cancel button when the request fails", async () => {
    render(
      <Workbench
        items={[tool]}
        cancelling={false}
        canCancel
        onCancel={async () => {
          throw new Error("cancel failed");
        }}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(screen.getByRole("button", { name: "确定取消" }));
    expect(await screen.findByRole("button", { name: "取消" })).toBeTruthy();
  });
});
