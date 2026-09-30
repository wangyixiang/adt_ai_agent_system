import { describe, it, expect } from "vitest";
import { startTestServer, TestClient, ScriptedLlmProvider } from "@adt/test-support";

describe("planner failure", () => {
  it("fails as planner_error and stays idempotent on replay", async () => {
    // No scripted responses: the provider throws on the first planner call.
    const srv = await startTestServer({ llm: new ScriptedLlmProvider([]) });
    const c = await TestClient.connect(srv.url);
    const welcome = await c.hello({ username: "alice", secret: "pw-alice" });
    const sessionId = (welcome.payload as { session_id: string }).session_id;
    const payload = {
      client_request_id: "req_1",
      user_request: { text: "x", attachments: [], context: {} },
    };

    const created = await c.sendRaw({ ...c.base("workflow.request"), payload });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;

    // initialCriteria throws (fallback criteria), then proposeNext throws.
    const terminated = await c.next();
    expect(terminated.type).toBe("workflow.terminated");
    expect((terminated.payload as { terminal_state: string }).terminal_state).toBe("FAILED");
    expect((terminated.payload as { terminal_reason: string }).terminal_reason).toBe(
      "planner_error",
    );

    // A replay is deduplicated: still exactly one workflow for the session.
    const replay = await c.sendRaw({ ...c.base("workflow.request"), payload });
    expect((replay.payload as { workflow_id: string }).workflow_id).toBe(workflowId);
    expect(await srv.workflows(sessionId)).toHaveLength(1);

    await c.close();
    await srv.close();
  });
});
