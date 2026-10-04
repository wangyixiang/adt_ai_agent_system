// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReportViewer } from "./ReportViewer";

describe("the report viewer", () => {
  it("shows the markdown and wires copy / save / close", async () => {
    const calls: string[] = [];
    render(
      <ReportViewer
        markdown={"# 结论\n好了"}
        onCopy={() => calls.push("copy")}
        onSave={() => calls.push("save")}
        onClose={() => calls.push("close")}
      />,
    );
    expect(screen.getByText(/结论/)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "复制" }));
    await user.click(screen.getByRole("button", { name: /另存为/ }));
    await user.click(screen.getByRole("button", { name: "关闭" }));
    expect(calls).toEqual(["copy", "save", "close"]);
  });

  it("shows an error instead of any body when the report failed", () => {
    render(
      <ReportViewer
        markdown={null}
        error="生成失败：insufficient_content"
        onCopy={() => undefined}
        onSave={() => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/insufficient_content/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
    expect(screen.queryByRole("button", { name: /另存为/ })).toBeNull();
  });

  it("closes on Escape and focuses the close button", async () => {
    const onClose = vi.fn();
    render(<ReportViewer markdown="# r" onCopy={() => {}} onSave={() => {}} onClose={onClose} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭" }));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
