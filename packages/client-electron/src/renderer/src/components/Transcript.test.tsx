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

const props = {
  onAnswer: () => {},
  onPreviewBlob: () => {},
  onSaveBlob: () => {},
  onLocate: () => {},
  readOnly: false,
};

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
        readOnly={false}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "预览" }));
    await user.click(screen.getByRole("button", { name: "另存" }));
    expect(previewed).toHaveBeenCalledWith("blob_x", "text/plain");
    expect(saved).toHaveBeenCalledWith("blob_x", "text/plain", "big.log");
    expect(screen.getAllByRole("button", { name: "预览" })).toHaveLength(1);
  });

  it("hides the decision controls in a read-only (past) transcript", () => {
    const completion: TranscriptItem = {
      key: "ask:wf_1:ask_c",
      kind: "ask",
      workflowId: "wf_1",
      askId: "ask_c",
      ask: { askId: "ask_c", kind: "completion", workflowId: "wf_1", summary: "看起来好了", evidenceRefs: [] },
      askKind: "completion",
      answered: false,
      stepId: null,
      text: "有一个完成候选在等你判断",
    };
    render(<Transcript items={[completion]} {...props} readOnly />);
    expect(screen.getByText("看起来好了")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "已解决" })).toBeNull();
  });
});
