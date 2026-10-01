import { describe, it, expect } from "vitest";

import type { BridgeDeps } from "./bridge";
import { createBridge } from "./bridge";
import type { UiSnapshot } from "../../shared/contract";

const emptySnapshot: UiSnapshot = {
  connection: "disconnected",
  userId: null,
  capabilities: [],
  workflows: [],
};

function deps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    snapshot: () => emptySnapshot,
    login: async () => undefined,
    submit: async () => "wf_1",
    answer: () => undefined,
    records: async () => ({ records: [], nextCursor: null }),
    record: async () => {
      throw new Error("record is not used in this test");
    },
    cancel: async () => undefined,
    report: async () => ({ ok: true, markdown: "" }),
    emit: () => undefined,
    ...overrides,
  };
}

describe("the main bridge", () => {
  it("answers a snapshot request with the current snapshot", async () => {
    const bridge = createBridge(deps());
    expect(await bridge.handle({ kind: "snapshot" })).toEqual(emptySnapshot);
  });

  it("routes a submit and returns the workflow id", async () => {
    const seen: string[] = [];
    const bridge = createBridge(
      deps({
        submit: async (text) => {
          seen.push(text);
          return "wf_9";
        },
      }),
    );
    expect(await bridge.handle({ kind: "submit", text: "服务异常" })).toBe("wf_9");
    expect(seen).toEqual(["服务异常"]);
  });

  it("routes an answer to the host", async () => {
    const seen: unknown[] = [];
    const bridge = createBridge(
      deps({
        answer: (askId, answer) => {
          seen.push({ askId, answer });
        },
      }),
    );
    await bridge.handle({
      kind: "answer",
      askId: "ask_1",
      answer: { kind: "confirmation", decision: "declined" },
    });
    expect(seen).toEqual([
      { askId: "ask_1", answer: { kind: "confirmation", decision: "declined" } },
    ]);
  });

  it("routes a cancel to the session", async () => {
    const seen: string[] = [];
    const bridge = createBridge(
      deps({
        cancel: async (workflowId) => {
          seen.push(workflowId);
        },
      }),
    );
    await bridge.handle({ kind: "cancel", workflowId: "wf_1" });
    expect(seen).toEqual(["wf_1"]);
  });

  it("routes a report request to the session", async () => {
    const seen: Array<[string, string | undefined]> = [];
    const bridge = createBridge(
      deps({
        report: async (recordId, detailLevel) => {
          seen.push([recordId, detailLevel]);
          return { ok: true, markdown: "# r" };
        },
      }),
    );
    expect(await bridge.handle({ kind: "report", recordId: "rec_1", detailLevel: "summary" })).toEqual({
      ok: true,
      markdown: "# r",
    });
    expect(seen).toEqual([["rec_1", "summary"]]);
  });
});
