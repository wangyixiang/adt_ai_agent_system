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

async function running(srv: Awaited<ReturnType<typeof startTestServer>>) {
  const c = await TestClient.connect(srv.url);
  await c.hello({
    username: "alice",
    secret: "pw-alice",
    capabilities: [
      {
        name: "git.collect_diagnostics",
        side_effect: false,
        interruptible: true,
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
});
