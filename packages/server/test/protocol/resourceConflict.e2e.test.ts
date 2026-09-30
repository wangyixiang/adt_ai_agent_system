import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

describe("resource conflict end to end", () => {
  it("waits without timing out, then ends the workflow with the reason on record", async () => {
    const srv = await startTestServer({
      stepTimeoutMs: 50,
      timeoutSweepIntervalMs: 20,
      planner: [
        {
          kind: "step",
          step: {
            objective: "复位测试台",
            capability: "sim_rig.trigger_reset",
            sideEffect: true,
            interruptible: false,
          },
        },
      ],
    });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: {
        client_request_id: "req_conflict",
        user_request: { text: "x", attachments: [], context: {} },
      },
    });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;
    const dispatch = await c.next();
    const stepId = (dispatch.payload as { step_id: string }).step_id;

    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "WAITING",
        wait_reason: { code: "resource_conflict" },
      },
    });

    // Well past the 50ms step timeout: a human wait has no deadline, and this
    // step must not become UNKNOWN for an action that never ran.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await srv.engine.getStep(stepId))!.state).toBe("WAITING");

    const terminated = await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "REJECTED",
        reject_reason: { code: "resource_conflict", message: "测试台正被占用" },
      },
    });

    expect(terminated.type).toBe("workflow.terminated");
    expect(terminated.payload).toMatchObject({
      terminal_state: "FAILED",
      terminal_reason: "resource_conflict",
    });

    const recordEnv = await c.sendRaw({
      ...c.base("record.get_request"),
      payload: { record_id: (terminated.payload as { record_id: string }).record_id },
    });
    const record = (recordEnv.payload as { record: Record<string, unknown> }).record;
    const entries = record.entries as Array<{ kind: string; narrative?: string }>;
    expect(entries.map((entry) => entry.kind)).toContain("step_rejected");
    expect(entries.find((entry) => entry.kind === "step_rejected")!.narrative).toContain(
      "测试台正被占用",
    );

    await c.close();
    await srv.close();
  });
});
