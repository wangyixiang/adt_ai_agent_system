// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Settings } from "./Settings";

describe("settings", () => {
  it("saves the server address, and the workspace when given", async () => {
    const saved: Array<[string, string]> = [];
    render(
      <Settings
        initial={{ serverUrl: "ws://old/ws", workspaceRoot: "" }}
        onSave={(serverUrl, workspaceRoot) => saved.push([serverUrl, workspaceRoot])}
      />,
    );
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/Server 地址/));
    await user.type(screen.getByLabelText(/Server 地址/), "ws://new/ws");
    await user.type(screen.getByLabelText(/工作区/), "C:/proj");
    await user.click(screen.getByRole("button", { name: /保存/ }));
    expect(saved).toEqual([["ws://new/ws", "C:/proj"]]);
  });

  it("will not save an empty address (the workspace is optional)", async () => {
    const saved: unknown[] = [];
    render(
      <Settings initial={{ serverUrl: "", workspaceRoot: "" }} onSave={(a, b) => saved.push([a, b])} />,
    );
    expect((screen.getByRole("button", { name: /保存/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(saved).toHaveLength(0);
  });

  it("offers a cancel only when one is given", () => {
    const { rerender } = render(
      <Settings initial={{ serverUrl: "", workspaceRoot: "" }} onSave={() => undefined} />,
    );
    expect(screen.queryByRole("button", { name: /取消|返回/ })).toBeNull();
    rerender(
      <Settings
        initial={{ serverUrl: "ws://x/ws", workspaceRoot: "" }}
        onSave={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: /取消|返回/ })).toBeTruthy();
  });

  it("refuses a non-ws address", () => {
    render(<Settings initial={{ serverUrl: "http://x", workspaceRoot: "" }} onSave={() => undefined} />);
    expect((screen.getByRole("button", { name: /保存/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("shows a save error", () => {
    render(
      <Settings
        initial={{ serverUrl: "ws://x/ws", workspaceRoot: "" }}
        onSave={() => undefined}
        error="写入失败：EACCES"
      />,
    );
    expect(screen.getByText(/EACCES/)).toBeTruthy();
  });
});
