import { describe, it, expect } from "vitest";
import { startTestServer } from "@adt/test-support";

import type { MainEvent } from "../../shared/contract";
import { createSession, type Session } from "./session";

const resetStep = {
  kind: "step" as const,
  step: {
    objective: "复位测试台",
    capability: "sim_rig.trigger_reset",
    sideEffect: true,
    interruptible: false,
  },
};
const readStep = {
  kind: "step" as const,
  step: {
    objective: "读一下状态",
    capability: "sim_rig.query_state",
    sideEffect: false,
    interruptible: true,
  },
};
const manualStep = {
  kind: "step" as const,
  step: {
    objective: "让工程师手动换电源线",
    capability: "human.manual_action",
    sideEffect: false,
    interruptible: true,
    input: { instruction: "断电后更换电源线，然后上电" },
  },
};
const done = { kind: "completion_candidate" as const, summary: "看起来好了", evidenceRefs: [] };

interface Fixture {
  session: Session;
  events: MainEvent[];
  close(): Promise<void>;
}

async function fixture(planner: unknown[]): Promise<Fixture> {
  const srv = await startTestServer({ planner: planner as never });
  const events: MainEvent[] = [];
  const session = createSession({
    serverUrl: srv.url,
    workspaceRoot: process.cwd(),
    clientInfo: { name: "session-int-test", platform: "test" },
    ledgerPath: ":memory:",
    sessionPath: ":memory:",
    emit: (event) => void events.push(event),
  });
  await session.login("alice", "pw-alice");
  return {
    session,
    events,
    close: async () => {
      await session.close();
      await srv.close();
    },
  };
}

async function waitFor(
  f: Fixture,
  predicate: (s: ReturnType<Session["snapshot"]>) => boolean,
  what: string,
): Promise<ReturnType<Session["snapshot"]>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = f.session.snapshot();
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const uiTypes = (f: Fixture): string[] =>
  f.events.flatMap((e) => (e.type === "ui" ? [e.event.type] : []));

async function waitForSession(
  session: Session,
  predicate: (s: ReturnType<Session["snapshot"]>) => boolean,
  what: string,
): Promise<ReturnType<Session["snapshot"]>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = session.snapshot();
    if (predicate(current)) return current;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("the in-process session", () => {
  it("a confirmed side effect runs, then the run finishes", async () => {
    const f = await fixture([resetStep, done]);
    try {
      expect(await f.session.submit("服务异常")).toMatch(/^wf_/);

      const asked = await waitFor(
        f,
        (s) => s.workflows[0]?.pendingAsk?.kind === "confirmation",
        "the confirmation",
      );
      const askId = asked.workflows[0]!.pendingAsk!.askId;
      f.session.answer(askId, { kind: "confirmation", decision: "confirmed" });

      const ran = await waitFor(f, (s) => s.workflows[0]?.steps[0]?.state === "COMPLETED", "the step to run");
      expect(ran.workflows[0]!.steps[0]!.evidenceSummary).toBeTruthy();

      const completion = await waitFor(f, (s) => s.workflows[0]?.pendingAsk?.kind === "completion", "the completion");
      f.session.answer(completion.workflows[0]!.pendingAsk!.askId, { kind: "completion", resolution: "solved" });

      const settled = await waitFor(f, (s) => s.workflows[0]?.terminalState !== null, "the end");
      expect(settled.workflows[0]!.recordId).toMatch(/^rec_/);
      expect(settled.workflows[0]!.userRequest.text).toBe("服务异常");

      const types = uiTypes(f);
      expect(types).toContain("workflow.created");
      expect(types).toContain("step.dispatched");
      expect(types).toContain("ask");
      expect(types).toContain("workflow.terminated");
    } finally {
      await f.close();
    }
  });

  it("a declined side effect is rejected, never executed", async () => {
    const f = await fixture([resetStep, done]);
    try {
      await f.session.submit("服务异常");
      const asked = await waitFor(f, (s) => s.workflows[0]?.pendingAsk?.kind === "confirmation", "the confirmation");
      f.session.answer(asked.workflows[0]!.pendingAsk!.askId, { kind: "confirmation", decision: "declined" });

      const rejected = await waitFor(f, (s) => s.workflows[0]?.steps[0]?.state === "REJECTED", "the rejection");
      expect(rejected.workflows[0]!.steps[0]!.evidenceSummary).toBeNull();
    } finally {
      await f.close();
    }
  });

  it("carries the manual action's feedback back as evidence", async () => {
    const f = await fixture([manualStep, done]);
    try {
      await f.session.submit("换根线");
      const asked = await waitFor(f, (s) => s.workflows[0]?.pendingAsk?.kind === "manual_action", "the manual action");
      const ask = asked.workflows[0]!.pendingAsk!;
      expect(ask).toMatchObject({ kind: "manual_action", instruction: "断电后更换电源线，然后上电" });

      f.session.answer(ask.askId, {
        kind: "manual_action",
        outcome: "succeeded",
        observation: "换好了，指示灯恢复正常",
      });
      const ran = await waitFor(f, (s) => s.workflows[0]?.steps[0]?.state === "COMPLETED", "the step to complete");
      expect(ran.workflows[0]!.steps[0]!.evidenceSummary).toContain("换好了，指示灯恢复正常");
    } finally {
      await f.close();
    }
  });

  it("refuses a malformed answer and leaves the question open", async () => {
    const f = await fixture([manualStep, done]);
    try {
      await f.session.submit("换根线");
      const asked = await waitFor(f, (s) => s.workflows[0]?.pendingAsk?.kind === "manual_action", "the manual action");
      const askId = asked.workflows[0]!.pendingAsk!.askId;

      expect(() => f.session.answer(askId, { kind: "manual_action", outcome: "done", observation: "x" })).toThrow(
        /malformed_payload/,
      );
      // Still waiting for a real answer.
      expect(f.session.snapshot().workflows[0]!.pendingAskId).toBe(askId);

      f.session.answer(askId, { kind: "manual_action", outcome: "succeeded", observation: "好了" });
      await waitFor(f, (s) => s.workflows[0]?.steps[0]?.state === "COMPLETED", "the step to complete");
    } finally {
      await f.close();
    }
  });

  it("answers each askId at most once", async () => {
    const f = await fixture([resetStep, done]);
    try {
      await f.session.submit("服务异常");
      const asked = await waitFor(f, (s) => s.workflows[0]?.pendingAsk?.kind === "confirmation", "the confirmation");
      const askId = asked.workflows[0]!.pendingAsk!.askId;
      f.session.answer(askId, { kind: "confirmation", decision: "confirmed" });
      expect(() => f.session.answer(askId, { kind: "confirmation", decision: "declined" })).toThrow(
        /ask_already_answered/,
      );
    } finally {
      await f.close();
    }
  });

  it("refuses an unknown askId", async () => {
    const f = await fixture([resetStep, done]);
    try {
      expect(() => f.session.answer("ask_nope", { kind: "confirmation", decision: "confirmed" })).toThrow(
        /unknown_ask/,
      );
    } finally {
      await f.close();
    }
  });

  it("a failing UI push does not break the run (the onStepStatus hook is guarded)", async () => {
    const srv = await startTestServer({ planner: [readStep, done] as never });
    const session = createSession({
      serverUrl: srv.url,
      workspaceRoot: process.cwd(),
      clientInfo: { name: "session-int-test", platform: "test" },
      ledgerPath: ":memory:",
      sessionPath: ":memory:",
      // A closed window would make the push throw; the run must survive it.
      emit: (event) => {
        if (event.type === "ui" && event.event.type === "step.status") {
          throw new Error("push failed");
        }
      },
    });
    await session.login("alice", "pw-alice");
    try {
      await session.submit("读一下状态");
      const completion = await waitForSession(
        session,
        (s) => s.workflows[0]?.pendingAsk?.kind === "completion",
        "the completion",
      );
      session.answer(completion.workflows[0]!.pendingAsk!.askId, {
        kind: "completion",
        resolution: "solved",
      });
      const settled = await waitForSession(session, (s) => s.workflows[0]?.terminalState !== null, "the end");
      expect(settled.workflows[0]!.terminalState).toBe("COMPLETED");
    } finally {
      await session.close();
      await srv.close();
    }
  });

  it("lists terminals past runs and returns one Record by id", async () => {
    const f = await fixture([resetStep, done]);
    try {
      await f.session.submit("服务异常");
      const asked = await waitFor(f, (s) => s.workflows[0]?.pendingAsk?.kind === "confirmation", "the confirmation");
      f.session.answer(asked.workflows[0]!.pendingAsk!.askId, { kind: "confirmation", decision: "confirmed" });
      const completion = await waitFor(f, (s) => s.workflows[0]?.pendingAsk?.kind === "completion", "the completion");
      f.session.answer(completion.workflows[0]!.pendingAsk!.askId, { kind: "completion", resolution: "solved" });
      const settled = await waitFor(f, (s) => s.workflows[0]?.terminalState !== null, "the end");
      const workflowId = settled.workflows[0]!.workflowId;
      const recordId = settled.workflows[0]!.recordId!;

      const list = await f.session.records();
      const entry = list.records.find((record) => record.workflowId === workflowId);
      expect(entry).toBeDefined();
      expect(entry!.recordId).toBe(recordId);
      expect(entry!.summary.terminal_state).toBe("COMPLETED");

      const detail = await f.session.record(recordId);
      expect(detail.terminal_state).toBe("COMPLETED");
      expect(detail.workflow_id).toBe(workflowId);
      // T1's addition: a past run's step states are recorded, not inferred.
      expect(detail.entries.some((e) => e.kind === "step_status")).toBe(true);

      await expect(f.session.record("rec_nope")).rejects.toThrow(/unknown_record/);
    } finally {
      await f.close();
    }
  });

  it("refuses record queries before login", async () => {
    const srv = await startTestServer({ planner: [readStep, done] as never });
    const session = createSession({
      serverUrl: srv.url,
      workspaceRoot: process.cwd(),
      clientInfo: { name: "session-int-test", platform: "test" },
      ledgerPath: ":memory:",
      sessionPath: ":memory:",
      emit: () => undefined,
    });
    try {
      await expect(session.records()).rejects.toThrow(/not_logged_in/);
      await expect(session.record("rec_x")).rejects.toThrow(/not_logged_in/);
    } finally {
      await session.close();
      await srv.close();
    }
  });

  it("cancels a run that is waiting for the human, and it terminates as CANCELLED", async () => {
    const f = await fixture([manualStep, done]);
    try {
      const workflowId = await f.session.submit("换根线");
      await waitFor(f, (s) => s.workflows[0]?.pendingAsk?.kind === "manual_action", "the manual action");

      await f.session.cancel(workflowId);

      const settled = await waitFor(f, (s) => s.workflows[0]?.terminalState !== null, "the end");
      expect(settled.workflows[0]!.terminalState).toBe("CANCELLED");
      expect(settled.workflows[0]!.cancelling).toBe(false);
      expect(settled.workflows[0]!.pendingAskId).toBeNull();
      expect(uiTypes(f)).toContain("workflow.terminated");
    } finally {
      await f.close();
    }
  });

  it("refuses to cancel before login", async () => {
    const srv = await startTestServer({ planner: [readStep, done] as never });
    const session = createSession({
      serverUrl: srv.url,
      workspaceRoot: process.cwd(),
      clientInfo: { name: "session-int-test", platform: "test" },
      ledgerPath: ":memory:",
      sessionPath: ":memory:",
      emit: () => undefined,
    });
    try {
      await expect(session.cancel("wf_x")).rejects.toThrow(/not_logged_in/);
    } finally {
      await session.close();
      await srv.close();
    }
  });

  it("generates a Report from a finished Record, and refuses an unknown one", async () => {
    const f = await fixture([readStep, done]);
    try {
      await f.session.submit("读一下状态");
      const completion = await waitFor(f, (s) => s.workflows[0]?.pendingAsk?.kind === "completion", "the completion");
      f.session.answer(completion.workflows[0]!.pendingAsk!.askId, { kind: "completion", resolution: "solved" });
      const settled = await waitFor(f, (s) => s.workflows[0]?.terminalState !== null, "the end");
      const recordId = settled.workflows[0]!.recordId!;

      const report = await f.session.report(recordId);
      expect(report.ok).toBe(true);
      if (report.ok) expect(report.markdown.length).toBeGreaterThan(0);

      // Generating does not create a second Record (FR-19).
      const list = await f.session.records();
      expect(list.records.filter((r) => r.recordId === recordId)).toHaveLength(1);

      await expect(f.session.report("rec_nope")).rejects.toThrow(/unknown_record/);
    } finally {
      await f.close();
    }
  });
});
