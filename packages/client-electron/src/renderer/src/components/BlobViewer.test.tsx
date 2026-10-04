// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BlobViewer } from "./BlobViewer";

describe("the blob viewer", () => {
  it("renders text, image and binary, and closes", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <BlobViewer preview={{ kind: "text", mediaType: "text/plain", text: "hi" }} onClose={onClose} />,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("hi")).toBeTruthy();

    rerender(
      <BlobViewer
        preview={{ kind: "image", mediaType: "image/png", dataUrl: "data:image/png;base64,AA" }}
        onClose={onClose}
      />,
    );
    expect(screen.getByRole("img")).toBeTruthy();

    rerender(
      <BlobViewer
        preview={{ kind: "binary", mediaType: "application/octet-stream", size: 9 }}
        onClose={onClose}
      />,
    );
    expect(screen.getByText(/二进制内容/)).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
