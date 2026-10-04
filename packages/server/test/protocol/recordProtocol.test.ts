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

async function completedWorkflow(
  options: { now?: () => number } = {},
): Promise<{ srv: TestServer; c: TestClient; recordId: string }> {
  const srv = await startTestServer({ planner: [...script], ...options });
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
  // Timing-sensitive: the clock is injected (the assertion is deterministic), but
  // the Record round-trips Postgres + a real WebSocket; retry absorbs that under load.
  it("stamps every entry with the same ordering clock", { retry: 2 }, async () => {
    // One clock for the whole log: an entry written by the protocol layer must
    // not land on a different time base than the engine's own events
    // (RECORD_SPEC.md §6.1).
    const { srv, c, recordId } = await completedWorkflow({ now: () => 4242 });

    const got = await c.sendRaw({
      ...c.base("record.get_request"),
      payload: { record_id: recordId },
    });
    const record = (got.payload as { record: { entries: Array<{ kind: string; ts: number }> } })
      .record;

    expect(record.entries.some((entry) => entry.kind === "completion_candidate")).toBe(true);
    expect(record.entries.map((entry) => entry.ts)).toEqual(
      record.entries.map(() => 4242),
    );

    await c.close();
    await srv.close();
  });

  it("filters by wall-clock time range", async () => {    const { srv, c, recordId } = await completedWorkflow();

    const within = new Date().toISOString();
    const listWith = async (from: string, to: string) =>
      c.sendRaw({
        ...c.base("record.list_request"),
        payload: {
          filters: { time_range: { from, to }, keyword: null, terminal_state: null },
          cursor: null,
          page_size: 20,
        },
      });

    // `ended_at` is a wall-clock reading, so a range around "now" contains it.
    const around = await listWith(
      new Date(Date.parse(within) - 3_600_000).toISOString(),
      new Date(Date.parse(within) + 3_600_000).toISOString(),
    );
    expect(
      (around.payload as { records: Array<{ record_id: string }> }).records.map((r) => r.record_id),
    ).toEqual([recordId]);

    // ...and a range long before it does not.
    const longAgo = await listWith("2001-01-01T00:00:00.000Z", "2001-01-02T00:00:00.000Z");
    expect((longAgo.payload as { records: unknown[] }).records).toEqual([]);

    await c.close();
    await srv.close();
  });

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

  it("records the completion candidate that preceded the confirmation", async () => {
    const { srv, c, recordId } = await completedWorkflow();

    const got = await c.sendRaw({
      ...c.base("record.get_request"),
      payload: { record_id: recordId },
    });
    const record = (got.payload as { record: { entries: Array<{ kind: string }> } }).record;
    expect(record.entries.map((e) => e.kind)).toContain("completion_candidate");

    await c.close();
    await srv.close();
  });

  it("rejects an invalid cursor and an unparseable time range", async () => {
    const srv = await startTestServer({ planner: [] });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const badCursor = await c.sendRaw({
      ...c.base("record.list_request"),
      payload: { filters: {}, cursor: "not-a-cursor", page_size: 20 },
    });
    expect((badCursor.payload as { code: string }).code).toBe("malformed_payload");

    const badRange = await c.sendRaw({
      ...c.base("record.list_request"),
      payload: {
        filters: { time_range: { from: "nope", to: "also-nope" } },
        cursor: null,
        page_size: 20,
      },
    });
    expect((badRange.payload as { code: string }).code).toBe("malformed_payload");

    await c.close();
    await srv.close();
  });

  it("carries a step's requires_confirmation into the record", async () => {
    const srv = await startTestServer({
      planner: [
        {
          kind: "step",
          step: {
            objective: "reset",
            capability: "sim_rig.trigger_reset",
            sideEffect: true,
            interruptible: false,
          },
        },
        { kind: "completion_candidate", summary: "done", evidenceRefs: [] },
      ],
    });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: {
        client_request_id: "req_rc",
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
    const candidate = await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "COMPLETED",
        evidence: { source: "capability", type: "reset_ack", result: {} },
      },
    });
    expect(candidate.type).toBe("workflow.completion_candidate");
    const terminated = await c.sendRaw({
      ...c.base("workflow.completion_response"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, resolution: "solved" },
    });
    const recordId = (terminated.payload as { record_id: string }).record_id;

    const got = await c.sendRaw({
      ...c.base("record.get_request"),
      payload: { record_id: recordId },
    });
    const record = (
      got.payload as { record: { entries: Array<{ kind: string; ref: Record<string, unknown> }> } }
    ).record;
    const dispatched = record.entries.find((entry) => entry.kind === "step_dispatched")!;
    expect(dispatched.ref.requires_confirmation).toBe(true);

    await c.close();
    await srv.close();
  });
});
