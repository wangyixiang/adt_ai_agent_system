import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

const readStep = {
  kind: "step" as const,
  step: {
    objective: "read",
    capability: "git.collect_diagnostics",
    sideEffect: false,
    interruptible: true,
  },
};

describe("orphan reclamation wired into the session lifecycle", () => {
  it("fails a workflow as client_unreachable when the session never resumes", async () => {
    const srv = await startTestServer({
      sessionTtlMs: 60,
      reclaimIntervalMs: 20,
      planner: [readStep],
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
    await c.next(); // step.dispatch
    await c.close();

    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (await srv.engine.get(workflowId))?.state !== "FAILED") {
      await new Promise((r) => setTimeout(r, 20));
    }
    const workflow = (await srv.engine.get(workflowId))!;
    expect(workflow.state).toBe("FAILED");
    expect(workflow.terminalReason).toBe("client_unreachable");
    await srv.close();
  });
});
