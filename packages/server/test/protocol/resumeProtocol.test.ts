import { describe, it, expect } from "vitest";
import { startTestServer, TestClient, type TestServer } from "@adt/test-support";

const readStep = {
  kind: "step" as const,
  step: {
    objective: "read",
    capability: "git.collect_diagnostics",
    sideEffect: false,
    interruptible: true,
  },
};

async function runningSession(srv: TestServer) {
  const c = await TestClient.connect(srv.url);
  const welcome = await c.hello({ username: "alice", secret: "pw-alice" });
  const sessionId = (welcome.payload as { session_id: string }).session_id;
  const request = {
    ...c.base("workflow.request"),
    payload: {
      client_request_id: "req_1",
      user_request: { text: "x", attachments: [], context: {} },
    },
  };
  const created = await c.sendRaw(request);
  const workflowId = (created.payload as { workflow_id: string }).workflow_id;
  const dispatch = await c.next(); // step.dispatch
  return {
    c,
    sessionId,
    workflowId,
    request,
    stepId: (dispatch.payload as { step_id: string }).step_id,
  };
}

describe("session.resume / workflow.state_sync", () => {
  it("resumes a disconnected session and syncs the pending step", async () => {
    const srv = await startTestServer({ planner: [readStep] });
    const { c, sessionId, workflowId, stepId } = await runningSession(srv);
    await c.close();

    const resumed = await TestClient.connect(srv.url);
    const sync = await resumed.resume(sessionId, { username: "alice", secret: "pw-alice" });

    expect(sync.type).toBe("workflow.state_sync");
    expect(sync.in_reply_to).not.toBeNull();
    expect((sync.payload as { resumed: boolean }).resumed).toBe(true);
    const entry = (sync.payload as { workflows: any[] }).workflows.find(
      (w) => w.workflow_id === workflowId,
    );
    expect(entry.workflow_status).toBe("RUNNING");
    expect(entry.pending_step.step_id).toBe(stepId);
    expect(entry.pending_step.capability).toBe("git.collect_diagnostics");
    expect(entry.record_id).toBeNull();

    // The resumed session keeps working (PENDING must pass through RUNNING first).
    resumed.send({
      ...resumed.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    const candidate = await resumed.sendRaw({
      ...resumed.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "COMPLETED",
        evidence: { source: "capability", type: "git_status", result: {} },
      },
    });
    expect(candidate.type).toBe("workflow.completion_candidate");
    await resumed.close();
    await srv.close();
  });

  it("ignores a message_id already seen before the reconnect", async () => {
    const srv = await startTestServer({ planner: [readStep] });
    const { c, sessionId, request } = await runningSession(srv);
    await c.close();

    const resumed = await TestClient.connect(srv.url);
    await resumed.resume(sessionId, { username: "alice", secret: "pw-alice" });
    resumed.send(request); // exact retransmission of the pre-disconnect message
    await new Promise((r) => setTimeout(r, 50));

    expect(await srv.workflows(sessionId)).toHaveLength(1);
    await resumed.close();
    await srv.close();
  });

  it("replies session_expired and closes for an unknown session", async () => {
    const srv = await startTestServer({ planner: [] });
    const c = await TestClient.connect(srv.url);
    const err = await c.resume("sess_nope", { username: "alice", secret: "pw-alice" });
    expect(err.type).toBe("protocol.error");
    expect((err.payload as { code: string }).code).toBe("session_expired");
    expect(await c.waitClose()).toBe(true);
    await srv.close();
  });

  it("rejects resume with bad credentials", async () => {
    const srv = await startTestServer({ planner: [readStep] });
    const { c, sessionId } = await runningSession(srv);
    await c.close();

    const other = await TestClient.connect(srv.url);
    const err = await other.resume(sessionId, { username: "alice", secret: "wrong" });
    expect((err.payload as { code: string }).code).toBe("auth_failed");
    expect(await other.waitClose()).toBe(true);
    await srv.close();
  });

  it("does not let another user resume someone else's session", async () => {
    const srv = await startTestServer({ planner: [readStep] });
    const { c, sessionId } = await runningSession(srv);
    await c.close();

    const bob = await TestClient.connect(srv.url);
    const err = await bob.resume(sessionId, { username: "bob", secret: "pw-bob" });
    expect((err.payload as { code: string }).code).toBe("auth_failed");
    expect(await bob.waitClose()).toBe(true);
    await srv.close();
  });

  it("reports a workflow that terminated while the client was offline", async () => {
    const srv = await startTestServer({ planner: [readStep] });
    const { c, sessionId, workflowId } = await runningSession(srv);
    await c.close();
    await srv.engine.reclaimOrphan(workflowId); // termination that happened while offline

    const resumed = await TestClient.connect(srv.url);
    const sync = await resumed.resume(sessionId, {
      username: "alice",
      secret: "pw-alice",
      knownWorkflows: [workflowId],
    });
    const entry = (sync.payload as { workflows: any[] }).workflows.find(
      (w) => w.workflow_id === workflowId,
    );
    expect(entry.workflow_status).toBe("FAILED");
    expect(entry.record_id).toMatch(/^rec_/);
    expect(entry.record_persistence_failed).toBe(false);
    await resumed.close();
    await srv.close();
  });
});
