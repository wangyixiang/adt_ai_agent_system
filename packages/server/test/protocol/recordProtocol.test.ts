import { describe, it, expect } from "vitest";
import { startTestServer, TestClient, type TestServer } from "@adt/test-support";

const script = [
  {
    kind: "step" as const,
    step: {
      objective: "read",
      capability: "git.collect_diagnostics",
      sideEffect: false,
      interruptible: true,
    },
  },
  { kind: "completion_candidate" as const, summary: "看起来好了", evidenceRefs: [] },
];

async function completedWorkflow(): Promise<{ srv: TestServer; c: TestClient; recordId: string }> {
  const srv = await startTestServer({ planner: [...script] });
  const c = await TestClient.connect(srv.url);
  await c.hello({ username: "alice", secret: "pw-alice" });

  const created = await c.sendRaw({
    ...c.base("workflow.request"),
    payload: {
      client_request_id: "req_1",
      user_request: { text: "项目起不来了", attachments: [], context: {} },
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
  return { srv, c, recordId: (terminated.payload as { record_id: string }).record_id };
}

describe("record and report protocol", () => {
  it("lists and fetches the caller's own record", async () => {
    const { srv, c, recordId } = await completedWorkflow();

    const list = await c.sendRaw({
      ...c.base("record.list_request"),
      payload: {
        filters: { time_range: null, keyword: null, terminal_state: null },
        cursor: null,
        page_size: 20,
      },
    });
    expect(list.type).toBe("record.list_response");
    expect((list.payload as { records: Array<{ record_id: string }> }).records.map((r) => r.record_id)).toEqual([
      recordId,
    ]);

    const got = await c.sendRaw({
      ...c.base("record.get_request"),
      payload: { record_id: recordId },
    });
    expect(got.type).toBe("record.get_response");
    expect((got.payload as { record: { owner_user_id: string } }).record.owner_user_id).toBe(c.userId);

    await c.close();
    await srv.close();
  });

  it("hides another user's record behind unknown_record", async () => {
    const { srv, c, recordId } = await completedWorkflow();

    const other = await TestClient.connect(srv.url);
    await other.hello({ username: "bob", secret: "pw-bob" });

    const err = await other.sendRaw({
      ...other.base("record.get_request"),
      payload: { record_id: recordId },
    });
    expect((err.payload as { code: string }).code).toBe("unknown_record");
    expect(JSON.stringify(err.payload)).not.toContain("owner_user_id");

    await c.close();
    await other.close();
    await srv.close();
  });

  it("generates a full markdown report and rejects an invalid detail level", async () => {
    const { srv, c, recordId } = await completedWorkflow();

    const ok = await c.sendRaw({
      ...c.base("report.generate_request"),
      payload: { record_id: recordId, options: { detail_level: "full" } },
    });
    expect(ok.type).toBe("report.generate_result");
    expect((ok.payload as { status: string }).status).toBe("ok");
    expect((ok.payload as { report: { format: string } }).report.format).toBe("markdown");
    expect((ok.payload as { report: { content: string } }).report.content).toContain("# 诊断报告");

    const bad = await c.sendRaw({
      ...c.base("report.generate_request"),
      payload: { record_id: recordId, options: { detail_level: "verbose" } },
    });
    expect((bad.payload as { status: string }).status).toBe("failed");
    expect((bad.payload as { error_code: string }).error_code).toBe("invalid_option");

    await c.close();
    await srv.close();
  });

  it("answers unknown_record for a missing record id", async () => {
    const srv = await startTestServer({ planner: [] });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const err = await c.sendRaw({
      ...c.base("record.get_request"),
      payload: { record_id: "rec_nope" },
    });
    expect((err.payload as { code: string }).code).toBe("unknown_record");

    await c.close();
    await srv.close();
  });
});
