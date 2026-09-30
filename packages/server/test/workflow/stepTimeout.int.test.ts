import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

describe("step timeout end to end", () => {
  it("fails a read-only step the client acknowledges but never completes", async () => {
    const srv = await startTestServer({
      stepTimeoutMs: 50,
      timeoutSweepIntervalMs: 20,
      planner: [
        {
          kind: "step",
          step: {
            objective: "r",
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
        client_request_id: "req_timeout_1",
        user_request: { text: "x", attachments: [], context: {} },
      },
    });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;

    const dispatch = await c.next();
    const stepId = (dispatch.payload as { step_id: string }).step_id;

    // The client acknowledges execution but never reports an outcome, so only
    // the Server-side monitor can end the step.
    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });

    const deadline = Date.now() + 3000;
    let state = "";
    while (Date.now() < deadline) {
      state = (await srv.engine.getStep(stepId))?.state ?? "";
      if (state === "FAILED") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(state).toBe("FAILED");

    await c.close();
    await srv.close();
  });
});
