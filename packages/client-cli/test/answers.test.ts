import { describe, it, expect } from "vitest";
import {
  parseConfirmation,
  parseCommand,
  parseManualFeedback,
  parseResourceConflict,
} from "../src/answers";

describe("parseConfirmation", () => {
  it("accepts only an explicit yes", () => {
    expect(parseConfirmation("y")).toBe(true);
    expect(parseConfirmation(" yes ")).toBe(true);
    expect(parseConfirmation("是")).toBe(true);
  });

  it("treats an explicit no as a no", () => {
    expect(parseConfirmation("n")).toBe(false);
    expect(parseConfirmation("NO")).toBe(false);
  });

  it("refuses to guess anything else", () => {
    // An unparseable answer must not become a yes — nor a silent no.
    for (const line of ["", "maybe", "?", "yolo", "1"]) {
      expect(parseConfirmation(line)).toBeNull();
    }
  });
});

describe("parseResourceConflict", () => {
  it("maps only the two real answers", () => {
    expect(parseResourceConflict("wait")).toBe("wait");
    expect(parseResourceConflict("等")).toBe("wait");
    expect(parseResourceConflict("stop")).toBe("stop");
    expect(parseResourceConflict("停")).toBe("stop");
    expect(parseResourceConflict("whatever")).toBeNull();
  });
});

describe("parseManualFeedback", () => {
  it("reads an outcome and an observation", () => {
    expect(parseManualFeedback("succeeded: 复位后灯变绿")).toEqual({
      outcome: "succeeded",
      observation: "复位后灯变绿",
    });
    expect(parseManualFeedback("FAILED")).toEqual({ outcome: "failed", observation: "" });
    expect(parseManualFeedback(" partially ： 一半 ")).toEqual({
      outcome: "partially",
      observation: "一半",
    });
  });

  it("returns null when there is nothing to report", () => {
    // No answer at all is "no feedback", not a made-up outcome.
    expect(parseManualFeedback("")).toBeNull();
    expect(parseManualFeedback("   ")).toBeNull();
    expect(parseManualFeedback("done")).toBeNull();
  });
});

describe("parseCommand", () => {
  it("parses the read/export/blob commands with their defaults", () => {
    expect(parseCommand(":records")).toEqual({ kind: "records" });
    expect(parseCommand(":show rec_1")).toEqual({ kind: "show", recordId: "rec_1" });
    expect(parseCommand(":report rec_1")).toEqual({
      kind: "report",
      recordId: "rec_1",
      detailLevel: "full",
    });
    expect(parseCommand(":report rec_1 summary")).toEqual({
      kind: "report",
      recordId: "rec_1",
      detailLevel: "summary",
    });
    expect(parseCommand(":export rec_1")).toEqual({
      kind: "export",
      recordId: "rec_1",
      object: "record",
    });
    expect(parseCommand(":export rec_1 report")).toEqual({
      kind: "export",
      recordId: "rec_1",
      object: "report",
    });
    expect(parseCommand(":blob blob_abc out.log")).toEqual({
      kind: "blob",
      contentRef: "blob_abc",
      path: "out.log",
    });
  });

  it("rejects a command missing its argument instead of guessing", () => {
    expect(parseCommand(":show")).toBeNull();
    expect(parseCommand(":blob blob_abc")).toBeNull();
    expect(parseCommand(":report rec_1 verbose")).toBeNull();
    expect(parseCommand(":export rec_1 reportx")).toBeNull();
  });

  it("does not treat an ordinary line as a command", () => {
    expect(parseCommand("hello")).toBeNull();
  });
});
