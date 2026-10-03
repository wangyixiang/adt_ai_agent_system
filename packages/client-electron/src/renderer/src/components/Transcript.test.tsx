// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TranscriptItem } from "../transcript";
import { Transcript } from "./Transcript";

const request = (): TranscriptItem => ({
  key: "user:wf_1",
  kind: "user",
  workflowId: "wf_1",
  text: "看附件",
  attachments: [
    { name: "note.txt", media_type: "text/plain", size: 2, sha256: "a", mode: "inline", data_base64: "aGk=" },
    { name: "big.log", media_type: "text/plain", size: 999999, sha256: "b", mode: "blob", content_ref: "blob_x" },
  ],
});

const props = { onAnswer: () => {}, onPreviewBlob: () => {}, onSaveBlob: () => {}, onLocate: () => {} };

describe("the transcript's user bubble", () => {
  it("shows the request's attachments", () => {
    render(<Transcript items={[request()]} {...props} />);
    expect(screen.getByText("note.txt")).toBeTruthy();
    expect(screen.getByText("big.log")).toBeTruthy();
  });

  it("previews and saves a blob attachment, and offers nothing for an inline one", async () => {
    const previewed = vi.fn();
    const saved = vi.fn();
    render(
      <Transcript
        items={[request()]}
        onAnswer={() => {}}
        onPreviewBlob={previewed}
        onSaveBlob={saved}
        onLocate={() => {}}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "预览" }));
    await user.click(screen.getByRole("button", { name: "另存" }));
    expect(previewed).toHaveBeenCalledWith("blob_x", "text/plain");
    expect(saved).toHaveBeenCalledWith("blob_x", "text/plain", "big.log");
    expect(screen.getAllByRole("button", { name: "预览" })).toHaveLength(1);
  });
});
