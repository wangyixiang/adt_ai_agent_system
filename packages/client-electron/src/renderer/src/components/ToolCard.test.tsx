// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TranscriptItem } from "../transcript";
import { ToolCard } from "./ToolCard";

const item: Extract<TranscriptItem, { kind: "tool" }> = {
  key: "tool:wf_1:st_1",
  kind: "tool",
  workflowId: "wf_1",
  stepId: "st_1",
  capability: "git.collect_diagnostics",
  objective: "先收集诊断信息",
  input: { maxLines: 200 },
  state: "COMPLETED",
  requiresConfirmation: false,
  evidenceSummary: "git_status: clean",
  evidenceBlob: null,
  text: "完成",
};

describe("the tool row", () => {
  it("shows the capability, state and objective, but not the input or the evidence", () => {
    render(<ToolCard item={item} onLocate={() => {}} />);
    expect(screen.getByText("git.collect_diagnostics")).toBeTruthy();
    expect(screen.getByText("完成")).toBeTruthy();
    expect(screen.getByText("先收集诊断信息")).toBeTruthy();
    expect(screen.queryByText(/maxLines/)).toBeNull();
    expect(screen.queryByText(/git_status/)).toBeNull();
  });

  it("locates the step in the workbench when clicked", async () => {
    const located = vi.fn();
    render(<ToolCard item={item} onLocate={located} />);
    await userEvent.click(screen.getByText("git.collect_diagnostics"));
    expect(located).toHaveBeenCalledWith("st_1");
  });
});
