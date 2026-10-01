import { describe, it, expect } from "vitest";

import type { Ask } from "@adt/shared";

import { createDecisionHost } from "./host";

function harness() {
  const published: Ask[] = [];
  const host = createDecisionHost((ask) => void published.push(ask));
  return { host, last: (): Ask => published[published.length - 1]! };
}

describe("the decision host", () => {
  it("carries the completion feedback out of the answer", async () => {
    const { host, last } = harness();
    const pending = host.completion({ workflowId: "wf", summary: "s", evidenceRefs: [] });
    host.answer(last().askId, {
      kind: "completion",
      resolution: "not_solved",
      feedback: "其实是另一个原因",
    });
    expect(await pending).toEqual({ resolution: "not_solved", feedback: "其实是另一个原因" });
  });

  it("maps a resource conflict to wait / stop", async () => {
    const { host, last } = harness();
    const pending = host.onResourceConflict({
      workflowId: "wf",
      stepId: "st",
      capability: "c",
      objective: "o",
    });
    host.answer(last().askId, { kind: "resource_conflict", answer: "wait" });
    expect(await pending).toBe("wait");
  });

  it("refuses a malformed answer and keeps the question open", () => {
    const { host, last } = harness();
    void host.onConfirmationRequired({
      workflowId: "wf",
      stepId: "st",
      capability: "c",
      objective: "o",
      input: {},
    });
    const askId = last().askId;
    expect(host.answer(askId, { kind: "confirmation", decision: "maybe" })).toMatchObject({
      ok: false,
      code: "malformed_payload",
    });
    expect(host.answer(askId, { kind: "confirmation", decision: "declined" })).toMatchObject({
      ok: true,
    });
  });

  it("answers each askId at most once", () => {
    const { host, last } = harness();
    void host.onConfirmationRequired({ workflowId: "wf", stepId: "st", capability: "c", objective: "o", input: {} });
    const askId = last().askId;
    host.answer(askId, { kind: "confirmation", decision: "confirmed" });
    expect(host.answer(askId, { kind: "confirmation", decision: "declined" })).toMatchObject({
      ok: false,
      code: "ask_already_answered",
    });
  });

  it("does not resolve an abandoned question — no accidental consent", async () => {
    const { host, last } = harness();
    const pending = host.onConfirmationRequired({
      workflowId: "wf",
      stepId: "st",
      capability: "c",
      objective: "o",
      input: {},
    });
    const askId = last().askId;
    host.abandon();

    expect(host.answer(askId, { kind: "confirmation", decision: "confirmed" })).toMatchObject({
      ok: false,
      code: "unknown_ask",
    });

    let resolved = false;
    void pending.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
  });
});
