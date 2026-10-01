// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { IncomingAttachment } from "../../../shared/contract";
import { Composer } from "./Composer";

describe("the composer", () => {
  it("submits the text together with the chosen attachment", async () => {
    const submitted: Array<{ text: string; attachments: IncomingAttachment[] }> = [];
    render(<Composer disabled={false} onSubmit={(text, attachments) => {
        submitted.push({ text, attachments });
      }} />);
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText("添加附件"), new File(["hi"], "note.txt", { type: "text/plain" }));
    await user.type(screen.getByPlaceholderText(/请求/), "看附件");
    await user.click(screen.getByRole("button", { name: "发送" }));

    expect(submitted).toHaveLength(1);
    expect(submitted[0]!.text).toBe("看附件");
    expect(submitted[0]!.attachments[0]).toMatchObject({ name: "note.txt", mediaType: "text/plain" });
  });

  it("adds pasted text as an attachment, and can remove it", async () => {
    const submitted: Array<{ text: string; attachments: IncomingAttachment[] }> = [];
    render(<Composer disabled={false} onSubmit={(text, attachments) => {
        submitted.push({ text, attachments });
      }} />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/粘贴/), "日志片段");
    await user.click(screen.getByRole("button", { name: "添加文本" }));
    expect(screen.getByText("pasted.txt")).toBeTruthy();

    await user.type(screen.getByPlaceholderText(/请求/), "看");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(submitted[0]!.attachments[0]!.name).toBe("pasted.txt");
  });

  it("keeps the draft when the submit fails", async () => {
    render(
      <Composer
        disabled={false}
        onSubmit={async () => {
          throw new Error("too_many");
        }}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(/请求/), "看附件");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await waitFor(() => {
      expect((screen.getByPlaceholderText(/请求/) as HTMLInputElement).value).toBe("看附件");
    });
  });
});
