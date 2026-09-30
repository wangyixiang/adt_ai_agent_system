import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

const readStep = {
  kind: "step" as const,
  step: {
    objective: "read",
    capability: "git.collect_diagnostics",
    sideEffect: false,
    interruptible: true,
    input: { project_path: "/a" },
  },
};

async function running(srv: Awaited<ReturnType<typeof startTestServer>>, outputType?: string) {
  const c = await TestClient.connect(srv.url);
  await c.hello({
    username: "alice",
    secret: "pw-alice",
    capabilities: [
      {
        name: "git.collect_diagnostics",
        side_effect: false,
        interruptible: true,
        ...(outputType === undefined ? {} : { output_type: outputType }),
        output_schema: {
          type: "object",
          required: ["branch"],
          properties: { branch: { type: "string" } },
        },
      },
    ],
  });
  const created = await c.sendRaw({
    ...c.base("workflow.request"),
    payload: {
      client_request_id: "req_1",
      user_request: { text: "x", attachments: [], context: {} },
    },
  });
  const workflowId = (created.payload as { workflow_id: string }).workflow_id;
  const dispatch = await c.next();
  return { c, workflowId, stepId: (dispatch.payload as { step_id: string }).step_id };
}

describe("evidence output validation", () => {
  it("records FAILED(invalid_output) when result does not match the schema", async () => {
    const srv = await startTestServer({
      planner: [readStep, { kind: "completion_candidate", summary: "done", evidenceRefs: [] }],
    });
    const { c, workflowId, stepId } = await running(srv);
    await c.send({
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
        evidence: { source: "capability", type: "git_status", result: { branch: 7 } },
      },
    });
    // The invalid evidence is rejected as a FAILED step; planning continues.
    expect(candidate.type).toBe("workflow.completion_candidate");
    const step = await srv.engine.getStep(stepId);
    expect(step!.state).toBe("FAILED");
    await c.close();
    await srv.close();
  });

  it("accepts evidence that matches the schema", async () => {
    const srv = await startTestServer({
      planner: [readStep, { kind: "completion_candidate", summary: "done", evidenceRefs: [] }],
    });
    const { c, workflowId, stepId } = await running(srv);
    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "COMPLETED",
        evidence: { source: "capability", type: "git_status", result: { branch: "main" } },
      },
    });
    expect((await srv.engine.getStep(stepId))!.state).toBe("COMPLETED");
    await c.close();
    await srv.close();
  });

  it("records FAILED(invalid_output) when evidence carries no result", async () => {
    const srv = await startTestServer({
      planner: [readStep, { kind: "completion_candidate", summary: "done", evidenceRefs: [] }],
    });
    const { c, workflowId, stepId } = await running(srv);
    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "COMPLETED",
        evidence: { source: "capability", type: "git_status" },
      },
    });
    expect((await srv.engine.getStep(stepId))!.state).toBe("FAILED");
    await c.close();
    await srv.close();
  });

  it("validates against the schema declared at dispatch even after a later capability.sync", async () => {
    const srv = await startTestServer({
      planner: [readStep, { kind: "completion_candidate", summary: "done", evidenceRefs: [] }],
    });
    const { c, workflowId, stepId } = await running(srv);

    // The client re-declares the capability without its output schema before
    // completing the step (CAPABILITY_SPEC.md §4: in-flight steps are unaffected).
    c.sync({
      mode: "full",
      revision: 1,
      added: [{ name: "git.collect_diagnostics", side_effect: false, interruptible: true }],
      removed: [],
    });

    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "COMPLETED",
        evidence: { source: "capability", type: "git_status", result: { branch: 7 } },
      },
    });
    expect((await srv.engine.getStep(stepId))!.state).toBe("FAILED");
    await c.close();
    await srv.close();
  });

  it("records FAILED(invalid_output) when the evidence is not the promised output type", async () => {
    const srv = await startTestServer({
      planner: [readStep, { kind: "completion_candidate", summary: "done", evidenceRefs: [] }],
    });
    const { c, workflowId, stepId } = await running(srv, "git_status");
    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "COMPLETED",
        // The shape is fine (`branch` is a string), so only the declared
        // output type can be what rejects it.
        evidence: { source: "capability", type: "docker_info", result: { branch: "main" } },
      },
    });

    expect((await srv.engine.getStep(stepId))!.state).toBe("FAILED");
    await c.close();
    await srv.close();
  });

  it("records FAILED(invalid_output) when a step promises output but returns none", async () => {
    const srv = await startTestServer({
      planner: [readStep, { kind: "completion_candidate", summary: "done", evidenceRefs: [] }],
    });
    const { c, workflowId, stepId } = await running(srv, "git_status");
    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "COMPLETED" },
    });

    expect((await srv.engine.getStep(stepId))!.state).toBe("FAILED");
    await c.close();
    await srv.close();
  });

  it("does not block a capability that declares no output type (§5.4)", async () => {
    const srv = await startTestServer({
      planner: [readStep, { kind: "completion_candidate", summary: "done", evidenceRefs: [] }],
    });
    const { c, workflowId, stepId } = await running(srv);
    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "COMPLETED",
        evidence: { source: "capability", type: "whatever", result: { branch: "main" } },
      },
    });

    expect((await srv.engine.getStep(stepId))!.state).toBe("COMPLETED");
    await c.close();
    await srv.close();
  });
});
