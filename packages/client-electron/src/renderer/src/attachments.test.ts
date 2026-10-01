import { describe, it, expect } from "vitest";

import { textToIncoming } from "./attachments";

describe("attachment helpers", () => {
  it("turns pasted text into a base64 text attachment", () => {
    expect(textToIncoming("hi")).toEqual({
      name: "pasted.txt",
      mediaType: "text/plain",
      dataBase64: btoa("hi"),
    });
  });
});
