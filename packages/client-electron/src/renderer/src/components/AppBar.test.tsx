// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppBar } from "./AppBar";

describe("the app bar", () => {
  it("says 已连接 and shows the user when connected", () => {
    render(<AppBar connection="connected" userId="usr_1" onOpenSettings={() => {}} />);
    expect(screen.getByText("已连接")).toBeTruthy();
    expect(screen.getByText("usr_1")).toBeTruthy();
  });

  it("says 已断开 when disconnected", () => {
    render(<AppBar connection="disconnected" userId={null} onOpenSettings={() => {}} />);
    expect(screen.getByText("已断开")).toBeTruthy();
  });

  it("says 正在重连… when reconnecting", () => {
    render(<AppBar connection="reconnecting" userId="usr_1" onOpenSettings={() => {}} />);
    expect(screen.getByText("正在重连…")).toBeTruthy();
  });

  it("opens settings from the app bar", async () => {
    const onOpenSettings = vi.fn();
    render(<AppBar connection="connected" userId="usr_1" onOpenSettings={onOpenSettings} />);
    await userEvent.click(screen.getByRole("button", { name: "设置" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
