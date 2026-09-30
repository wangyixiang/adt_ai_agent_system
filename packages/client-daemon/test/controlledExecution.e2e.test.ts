import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";
import type { Planner, PlannerDecision } from "@adt/server";
import { ClientDaemon } from "../src/daemon";
import { defaultRegistry } from "../src/capability/defaultRegistry";
import { mvpSpec } from "../src/capability/descriptors";
import type { CapabilityRegistry } from "../src/capability/registry";
import { openLedger } from "../src/ledger";

const resetStep = {
  objective: "复位测试台",
  capability: "sim_rig.trigger_reset",
  sideEffect: true,
  interruptible: false,
};
const readStep = {
  objective: "查看复位后的状态",
  capability: "sim_rig.query_state",
  sideEffect: false,
  interruptible: true,
};

const request = {
  client_request_id: "req_1",
  user_request: { text: "服务异常", attachments: [], context: {} },
};

/** A registry whose simulated reset never answers, so only the timer can end it. */
function hangingRegistry(): CapabilityRegistry {
  const registry = defaultRegistry();
  registry.register({
    spec: { ...mvpSpec("sim_rig.trigger_reset"), timeout_hint: 50 },
    execute: () => new Promise<never>(() => undefined),
  });
  return registry;
}

function scriptedPlanner(script: PlannerDecision[]): Planner {
  const queue = [...script];
  return {
    initialCriteria: async () => ({ mode: "open", revision: 0 }),
    proposeNext: async () =>
      queue.shift() ?? { kind: "completion_candidate", summary: "", evidenceRefs: [] },
  };
}

/** Proposes the hanging reset, reconciles it once UNKNOWN, then completes. */
function reconcilingPlanner(): Planner {
  return {
    initialCriteria: async () => ({ mode: "open", revision: 0 }),
    proposeNext: async ({ steps }) => {
      const unknown = steps.find((step) => step.state === "UNKNOWN");
      if (unknown) {
        return {
          kind: "reconcile",
          stepId: unknown.id,
          outcome: "COMPLETED",
          evidenceRefs: [unknown.id],
        };
      }
      if (steps.length === 0) return { kind: "step", step: resetStep };
      return { kind: "completion_candidate", summary: "对账完成", evidenceRefs: [] };
    },
  };
}

interface RecordView {
  final_result: { resolution: string };
  entries: Array<{ kind: string; ref: Record<string, unknown> }>;
}

async function readRecord(
  connection: ClientDaemon["connection"],
  recordId: string,
): Promise<RecordView> {
  const env = await new Promise<{ payload: unknown }>((resolve) => {
    connection.on("record.get_response", (received) => resolve(received));
    connection.send("record.get_request", { record_id: recordId });
  });
  return (env.payload as { record: RecordView }).record;
}

/** Answers every completion candidate with "solved", so the workflow terminates. */
function autoSolve(connection: ClientDaemon["connection"], workflowId: () => string): void {
  connection.on("workflow.completion_candidate", () => {
    connection.send("workflow.completion_response", {
      workflow_id: workflowId(),
      resolution: "solved",
    });
  });
}

const credentials = { username: "alice", secret: "pw-alice" };
const clientInfo = { name: "controlled-e2e", platform: "test" };

describe("controlled execution end to end", () => {
  it("executes a confirmed side-effect action, records it and remembers the key", async () => {
    const srv = await startTestServer({
      planner: [
        { kind: "step", step: resetStep },
        { kind: "completion_candidate", summary: "完成", evidenceRefs: [] },
      ],
    });
    const ledger = openLedger(":memory:");
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      ledger,
      onConfirmationRequired: async () => true,
    });
    const c = daemon.connection;

    let workflowId = "";
    let stepId = "";
    c.on("workflow.created", (env) => {
      workflowId = (env.payload as { workflow_id: string }).workflow_id;
    });
    c.on("step.dispatch", (env) => {
      stepId = (env.payload as { step_id: string }).step_id;
    });
    autoSolve(c, () => workflowId);

    const terminated = await new Promise<Record<string, unknown>>((resolve) => {
      c.on("workflow.terminated", (env) => resolve(env.payload as Record<string, unknown>));
      c.send("workflow.request", request);
    });

    const step = (await srv.engine.getStep(stepId))!;
    expect(step.state).toBe("COMPLETED");
    expect(terminated.terminal_state).toBe("COMPLETED");

    // The key the Server minted is what the ledger remembers, so a resume
    // re-dispatch of this step cannot repeat the reset.
    expect(step.idempotencyKey).toMatch(/^idem_/);
    expect(ledger.get(step.idempotencyKey!)).toEqual({
      state: "done",
      type: "reset_ack",
      result: { reset_ack: true },
    });

    const record = await readRecord(c, terminated.record_id as string);
    expect(record.final_result.resolution).toBe("controlled_execution");
    expect(record.entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["step_dispatched", "evidence_received"]),
    );

    await daemon.close();
    await srv.close();
  });

  it("re-plans after the engineer declines the side effect", async () => {
    const srv = await startTestServer({
      plannerImpl: scriptedPlanner([
        { kind: "step", step: resetStep },
        { kind: "step", step: readStep },
        { kind: "completion_candidate", summary: "完成", evidenceRefs: [] },
      ]),
    });
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      ledger: openLedger(":memory:"),
      // The engineer says no to the reset.
      onConfirmationRequired: async () => false,
    });
    const c = daemon.connection;

    let workflowId = "";
    const dispatched: string[] = [];
    c.on("workflow.created", (env) => {
      workflowId = (env.payload as { workflow_id: string }).workflow_id;
    });
    c.on("step.dispatch", (env) => {
      dispatched.push((env.payload as { capability: string }).capability);
    });
    autoSolve(c, () => workflowId);

    const terminated = await new Promise<Record<string, unknown>>((resolve) => {
      c.on("workflow.terminated", (env) => resolve(env.payload as Record<string, unknown>));
      c.send("workflow.request", request);
    });

    expect(terminated.terminal_state).toBe("COMPLETED");
    expect(dispatched).toEqual(["sim_rig.trigger_reset", "sim_rig.query_state"]);

    // The declined reset is recorded as rejected, and never ran: no evidence.
    const record = await readRecord(c, terminated.record_id as string);
    const rejected = record.entries.find((entry) => entry.kind === "user_confirmation")!;
    expect(rejected.ref).toMatchObject({ step_id: expect.stringMatching(/^step_/), decision: "declined" });

    await daemon.close();
    await srv.close();
  });

  it("reconciles a side effect that timed out into an outcome", async () => {
    const srv = await startTestServer({
      stepTimeoutMs: 50,
      stepTimeoutGraceMs: 0,
      timeoutSweepIntervalMs: 20,
      plannerImpl: reconcilingPlanner(),
    });
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      registry: hangingRegistry(),
      ledger: openLedger(":memory:"),
      onConfirmationRequired: async () => true,
    });
    const c = daemon.connection;

    let workflowId = "";
    let stepId = "";
    c.on("workflow.created", (env) => {
      workflowId = (env.payload as { workflow_id: string }).workflow_id;
    });
    c.on("step.dispatch", (env) => {
      stepId = (env.payload as { step_id: string }).step_id;
    });
    autoSolve(c, () => workflowId);

    const terminated = await new Promise<Record<string, unknown>>((resolve) => {
      c.on("workflow.terminated", (env) => resolve(env.payload as Record<string, unknown>));
      c.send("workflow.request", request);
    });

    expect(terminated.terminal_state).toBe("COMPLETED");
    // UNKNOWN only ever leaves through reconciliation (WORKFLOW_SPEC.md §4.3).
    expect((await srv.engine.getStep(stepId))!.state).toBe("COMPLETED");

    const record = await readRecord(c, terminated.record_id as string);
    const kinds = record.entries.map((entry) => entry.kind);
    expect(kinds).toContain("step_outcome_unknown");
    expect(kinds).toContain("reconciliation_resolved");
    const resolved = record.entries.find((entry) => entry.kind === "reconciliation_resolved")!;
    expect(resolved.ref.resolved_to).toBe("COMPLETED");
    expect(resolved.ref.evidence_refs).toEqual([stepId]);

    await daemon.close();
    await srv.close();
  });

  it("runs the advisory path end to end: instruction in, engineer report out", async () => {
    const srv = await startTestServer({
      planner: [
        {
          kind: "step",
          step: {
            objective: "让工程师手动换电源线",
            capability: "human.manual_action",
            sideEffect: false,
            interruptible: true,
            input: { instruction: "断电后更换电源线，然后上电" },
          },
        },
        { kind: "completion_candidate", summary: "完成", evidenceRefs: [] },
      ],
    });

    const asked: string[] = [];
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      ledger: openLedger(":memory:"),
      onUserInput: async (request) => {
        asked.push(request.capability);
        return { outcome: "succeeded", observation: "换好了，指示灯恢复正常" };
      },
    });
    const c = daemon.connection;

    let workflowId = "";
    c.on("workflow.created", (env) => {
      workflowId = (env.payload as { workflow_id: string }).workflow_id;
    });
    autoSolve(c, () => workflowId);

    const terminated = await new Promise<Record<string, unknown>>((resolve) => {
      c.on("workflow.terminated", (env) => resolve(env.payload as Record<string, unknown>));
      c.send("workflow.request", request);
    });

    expect(terminated.terminal_state).toBe("COMPLETED");
    expect(asked).toEqual(["human.manual_action"]);

    // The engineer's report is the evidence, recorded as a user_input entry.
    const record = await readRecord(c, terminated.record_id as string);
    const userInput = record.entries.find((entry) => entry.kind === "user_input")!;
    expect(userInput.ref.content).toEqual({
      outcome: "succeeded",
      observation: "换好了，指示灯恢复正常",
    });

    await daemon.close();
    await srv.close();
  });

  it("re-dispatches a pending step under the same idempotency key on resume", async () => {    const srv = await startTestServer({ planner: [{ kind: "step", step: resetStep }] });
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      registry: hangingRegistry(),
      ledger: openLedger(":memory:"),
      onConfirmationRequired: async () => true,
    });
    const c = daemon.connection;

    let workflowId = "";
    let firstKey: string | null = null;
    c.on("workflow.created", (env) => {
      workflowId = (env.payload as { workflow_id: string }).workflow_id;
    });
    c.on("step.dispatch", (env) => {
      firstKey = (env.payload as { idempotency_key: string | null }).idempotency_key;
    });
    c.send("workflow.request", request);

    // Wait for the dispatch, then drop the connection without finishing the step.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && firstKey === null) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(firstKey).toMatch(/^idem_/);
    const sessionId = c.sessionId;
    await daemon.close();

    const resumed = await TestClient.connect(srv.url);
    const sync = await resumed.resume(sessionId, {
      username: "alice",
      secret: "pw-alice",
      knownWorkflows: [workflowId],
    });
    const workflows = (
      sync.payload as { workflows: Array<{ pending_step: { idempotency_key: string } | null }> }
    ).workflows;

    // Same step, same key: this is what makes the client ledger effective.
    expect(workflows[0]!.pending_step!.idempotency_key).toBe(firstKey);

    await resumed.close();
    await srv.close();
  });
});
