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

    // WORKFLOW_SPEC.md §2.2 / plan Review Focus #4: reclamation saves the
    // Record too (asynchronously, right after the state transition).
    const recordDeadline = Date.now() + 2000;
    let record = await srv.recordForWorkflow(workflowId);
    while (!record && Date.now() < recordDeadline) {
      await new Promise((r) => setTimeout(r, 20));
      record = await srv.recordForWorkflow(workflowId);
    }
    expect(record).not.toBeNull();
    expect(record!.terminal_state).toBe("FAILED");
    await srv.close();
  });

  it("does not reclaim a workflow when the session revives via a heartbeat", async () => {
    const srv = await startTestServer({
      heartbeatIntervalMs: 30,
      maxMissed: 2,
      sessionTtlMs: 400,
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

    // Heartbeats stop long enough for the monitor to declare the session dead
    // while the socket stays open.
    await new Promise((r) => setTimeout(r, 120));
    expect(srv.deadSessions).toContain(c.sessionId);
    expect(srv.sessions.get(c.sessionId)?.disconnectedAt).not.toBeNull();

    // The client recovers on the SAME socket and keeps heartbeating: its
    // workflows must not be reclaimed when the grace window elapses.
    c.heartbeat();
    await new Promise((r) => setTimeout(r, 30));
    expect(srv.sessions.get(c.sessionId)?.disconnectedAt).toBeNull();

    const beat = setInterval(() => c.heartbeat(), 15);
    await new Promise((r) => setTimeout(r, 500));
    clearInterval(beat);

    expect((await srv.engine.get(workflowId))!.state).toBe("RUNNING");
    await c.close();
    await srv.close();
  });
});
