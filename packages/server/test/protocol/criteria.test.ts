import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";
import type { Planner } from "@adt/server";

const planner: Planner = {
  initialCriteria: async () => ({ mode: "open", revision: 0, description: "现象不再出现" }),
  proposeNext: async (input) =>
    input.workflow.criteria.revision === 0
      ? {
          kind: "completion_candidate",
          summary: "看起来好了",
          evidenceRefs: [],
          criteria: { mode: "open", description: "现象不再出现" },
        }
      : { kind: "completion_candidate", summary: "好了", evidenceRefs: [] },
};

describe("planner criteria", () => {
  it("creates the workflow with the planner's criteria and revises on demand", async () => {
    const srv = await startTestServer({ plannerImpl: planner });
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
    await c.next(); // completion candidate
    const wf = (await srv.engine.get(workflowId))!;
    expect(wf.criteria.revision).toBe(1);
    await c.close();
    await srv.close();
  });
});
