import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

describe("workflow protocol", () => {
  it("creates a workflow, dispatches the first step and reaches COMPLETED with a record", async () => {
    const srv = await startTestServer({
      planner: [
        {
          kind: "step",
          step: {
            objective: "read",
            capability: "git.collect_diagnostics",
            sideEffect: false,
            interruptible: true,
          },
        },
        { kind: "completion_candidate", summary: "看起来好了", evidenceRefs: [] },
      ],
    });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: {
        client_request_id: "req_1",
        user_request: { text: "项目起不来了", attachments: [], context: {} },
      },
    });
    expect(created.type).toBe("workflow.created");
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;

    const dispatch = await c.next();
    expect(dispatch.type).toBe("step.dispatch");
    expect((dispatch.payload as { capability: string }).capability).toBe(
      "git.collect_diagnostics",
    );
    const stepId = (dispatch.payload as { step_id: string }).step_id;

    // RUNNING produces no reply (the step is still active — One-Step Planning).
    c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });

    const candidate = await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "COMPLETED",
        evidence: { source: "capability", type: "git_status", result: {} },
      },
    });
    expect(candidate.type).toBe("workflow.completion_candidate");

    const terminated = await c.sendRaw({
      ...c.base("workflow.completion_response"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, resolution: "solved" },
    });
    expect(terminated.type).toBe("workflow.terminated");
    expect((terminated.payload as { terminal_state: string }).terminal_state).toBe("COMPLETED");
    expect((terminated.payload as { record_id: string }).record_id).toMatch(/^rec_/);
    expect(
      (terminated.payload as { record_persistence_failed: boolean }).record_persistence_failed,
    ).toBe(false);

    await c.close();
    await srv.close();
  });

  it("acks a cancel and terminates without a record when persistence fails", async () => {
    const srv = await startTestServer({ planner: [], failRecordPersistence: true });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: {
        client_request_id: "req_1",
        user_request: { text: "x", attachments: [], context: {} },
      },
    });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;
    await c.next(); // drain the completion_candidate

    const ack = await c.sendRaw({
      ...c.base("workflow.cancel_request"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, reason: "user_cancelled" },
    });
    expect((ack.payload as { workflow_status: string }).workflow_status).toBe("CANCELLED");

    const terminated = await c.next();
    expect(terminated.type).toBe("workflow.terminated");
    expect((terminated.payload as { record_id: string | null }).record_id).toBeNull();
    expect(
      (terminated.payload as { record_persistence_failed: boolean }).record_persistence_failed,
    ).toBe(true);

    await c.close();
    await srv.close();
  });

  it("refuses to operate another session's workflow", async () => {
    const srv = await startTestServer({ planner: [] });
    const a = await TestClient.connect(srv.url);
    await a.hello({ username: "alice", secret: "pw-alice" });
    const created = await a.sendRaw({
      ...a.base("workflow.request"),
      payload: {
        client_request_id: "req_1",
        user_request: { text: "x", attachments: [], context: {} },
      },
    });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;

    const b = await TestClient.connect(srv.url);
    await b.hello({ username: "alice", secret: "pw-alice" });
    const err = await b.sendRaw({
      ...b.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: "step_x", status: "RUNNING" },
    });

    expect((err.payload as { code: string }).code).toBe("unknown_workflow");

    await a.close();
    await b.close();
    await srv.close();
  });

  it("notifies and persists a record when a guardrail breach terminates the workflow", async () => {
    const srv = await startTestServer({
      guardrails: {
        maxStepsPerWorkflow: 1,
        maxConsecutiveRetriesPerCapability: 2,
        maxNotSolvedRounds: 5,
        timeBudgetMs: null,
      },
      planner: [
        {
          kind: "step",
          step: {
            objective: "a",
            capability: "git.collect_diagnostics",
            sideEffect: false,
            interruptible: true,
          },
        },
        {
          kind: "step",
          step: {
            objective: "b",
            capability: "git.collect_diagnostics",
            sideEffect: false,
            interruptible: true,
          },
        },
      ],
    });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: {
        client_request_id: "req_1",
        user_request: { text: "x", attachments: [], context: {} },
      },
    });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;
    const dispatch = await c.next();
    const stepId = (dispatch.payload as { step_id: string }).step_id;

    c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    // Completing step 1 makes the orchestrator propose step 2, which breaches
    // the step limit — the engine terminates AND throws.
    const terminated = await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "COMPLETED" },
    });

    expect(terminated.type).toBe("workflow.terminated");
    expect((terminated.payload as { terminal_state: string }).terminal_state).toBe("FAILED");
    expect((terminated.payload as { terminal_reason: string }).terminal_reason).toBe("step_limit");
    expect((terminated.payload as { record_id: string }).record_id).toMatch(/^rec_/);

    await c.close();
    await srv.close();
  });

  it("still notifies when record finalization throws", async () => {
    const srv = await startTestServer({ planner: [], throwOnFinalize: true });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });
    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: {
        client_request_id: "req_1",
        user_request: { text: "x", attachments: [], context: {} },
      },
    });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;
    await c.next(); // drain the completion candidate

    const ack = await c.sendRaw({
      ...c.base("workflow.cancel_request"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, reason: "user_cancelled" },
    });
    expect((ack.payload as { workflow_status: string }).workflow_status).toBe("CANCELLED");

    const terminated = await c.next();
    expect(terminated.type).toBe("workflow.terminated");
    expect((terminated.payload as { record_id: string | null }).record_id).toBeNull();
    expect(
      (terminated.payload as { record_persistence_failed: boolean }).record_persistence_failed,
    ).toBe(true);

    await c.close();
    await srv.close();
  });
});
