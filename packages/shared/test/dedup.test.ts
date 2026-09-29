import { describe, it, expect } from "vitest";
import { DedupWindow } from "../src";

describe("DedupWindow", () => {
  it("reports first-seen vs duplicate", () => {
    const w = new DedupWindow();
    expect(w.has("msg_1")).toBe(false);
    w.add("msg_1");
    expect(w.has("msg_1")).toBe(true);
  });

  it("clears with the session", () => {
    const w = new DedupWindow();
    w.add("msg_1");
    w.clear();
    expect(w.has("msg_1")).toBe(false);
  });
});
