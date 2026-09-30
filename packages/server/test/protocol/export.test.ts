import { describe, it, expect } from "vitest";
import { startTestServer, TestClient, type TestServer } from "@adt/test-support";
import type { DepositPayload } from "../../src/kb/deposit";
import type { DepositOutcome, KnowledgeDepositor } from "../../src/kb/depositor";

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
  options: { knowledgeDepositor?: KnowledgeDepositor | null } = {},
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

/** Records what it was handed and answers with a fixed outcome. */
function spyDepositor(outcome: DepositOutcome = { status: "ok" }) {
  const seen: DepositPayload[] = [];
  const depositor: KnowledgeDepositor = {
    deposit: async (payload: DepositPayload): Promise<DepositOutcome> => {
      seen.push(payload);
      return outcome;
    },
  };
  return { seen, depositor };
}

const exportRequest = (c: TestClient, recordId: string, object?: unknown) => ({
  ...c.base("record.export_request"),
  payload: {
    record_id: recordId,
    ...(object === undefined ? {} : { object }),
    target: "knowledge_base",
  },
});

describe("record.export_request", () => {
  it("deposits the whole record and reports ok", async () => {
    const { seen, depositor } = spyDepositor();
    const { srv, c, recordId } = await completedWorkflow({ knowledgeDepositor: depositor });

    const result = await c.sendRaw(exportRequest(c, recordId, "record"));
    expect(result.type).toBe("record.export_result");
    expect(result.payload).toMatchObject({
      record_id: recordId,
      object: "record",
      status: "ok",
      error_code: null,
      message: null,
    });

    expect(seen).toHaveLength(1);
    const payload = seen[0]!;
    expect(payload.object).toBe("record");
    expect(payload.deposit_id).toMatch(/^dep_[0-9a-f]{64}$/);
    expect(payload.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The record is deposited as the finished document, entries and all.
    expect(JSON.stringify(payload.content)).toContain(recordId);
    // ADR-005 §3: `spec_versions` travels with a record deposit — and is copied
    // from the record, not invented.
    const got = await c.sendRaw({
      ...c.base("record.get_request"),
      payload: { record_id: recordId },
    });
    expect(payload.spec_versions).toEqual(
      (got.payload as { record: { spec_versions: Record<string, string> } }).record.spec_versions,
    );

    await c.close();
    await srv.close();
  });

  it("defaults a missing object to the record (PROTOCOL_SPEC.md §10.3)", async () => {
    const { seen, depositor } = spyDepositor();
    const { srv, c, recordId } = await completedWorkflow({ knowledgeDepositor: depositor });

    const result = await c.sendRaw(exportRequest(c, recordId));
    expect((result.payload as { status: string }).status).toBe("ok");
    expect(seen[0]!.object).toBe("record");

    await c.close();
    await srv.close();
  });

  it("deposits only the report when asked for a report", async () => {
    const { seen, depositor } = spyDepositor();
    const { srv, c, recordId } = await completedWorkflow({ knowledgeDepositor: depositor });

    const result = await c.sendRaw(exportRequest(c, recordId, "report"));
    expect((result.payload as { status: string }).status).toBe("ok");

    const payload = seen[0]!;
    expect(payload.object).toBe("report");
    expect(payload.content).toMatchObject({ format: "markdown" });
    expect((payload.content as { content: string }).content).toContain("# 诊断报告");
    // Choosing a report must not leak the raw record alongside it.
    expect(JSON.stringify(payload)).not.toContain("\"entries\"");

    await c.close();
    await srv.close();
  });

  it("rejects an unknown object without calling the depositor", async () => {
    const { seen, depositor } = spyDepositor();
    const { srv, c, recordId } = await completedWorkflow({ knowledgeDepositor: depositor });

    const result = await c.sendRaw(exportRequest(c, recordId, "nonsense"));
    expect(result.payload).toMatchObject({ status: "failed", error_code: "invalid_object" });
    expect(seen).toHaveLength(0);

    await c.close();
    await srv.close();
  });

  it("answers export_unavailable when no depositor is configured", async () => {
    const { srv, c, recordId } = await completedWorkflow();

    const result = await c.sendRaw(exportRequest(c, recordId, "record"));
    expect(result.payload).toMatchObject({ status: "failed", error_code: "export_unavailable" });

    await c.close();
    await srv.close();
  });

  it("passes the depositor's failure through unchanged", async () => {
    const { depositor } = spyDepositor({
      status: "failed",
      error_code: "export_failed",
      message: "KB endpoint responded 422: bad format",
    });
    const { srv, c, recordId } = await completedWorkflow({ knowledgeDepositor: depositor });

    const result = await c.sendRaw(exportRequest(c, recordId, "record"));
    expect(result.payload).toMatchObject({
      status: "failed",
      error_code: "export_failed",
      message: "KB endpoint responded 422: bad format",
    });

    await c.close();
    await srv.close();
  });

  it("hides a missing or foreign record behind unknown_record", async () => {
    const { srv, c, recordId } = await completedWorkflow({ knowledgeDepositor: spyDepositor().depositor });

    const missing = await c.sendRaw(exportRequest(c, "rec_nope", "record"));
    expect((missing.payload as { code: string }).code).toBe("unknown_record");

    const other = await TestClient.connect(srv.url);
    await other.hello({ username: "bob", secret: "pw-bob" });
    const foreign = await other.sendRaw(exportRequest(other, recordId, "record"));
    expect((foreign.payload as { code: string }).code).toBe("unknown_record");

    await c.close();
    await other.close();
    await srv.close();
  });

  it("leaves the record untouched (RECORD_SPEC.md principle 7)", async () => {
    const { depositor } = spyDepositor();
    const { srv, c, recordId } = await completedWorkflow({ knowledgeDepositor: depositor });

    const before = await c.sendRaw({ ...c.base("record.get_request"), payload: { record_id: recordId } });
    const exported = await c.sendRaw(exportRequest(c, recordId, "record"));
    expect((exported.payload as { status: string }).status).toBe("ok");
    const after = await c.sendRaw({ ...c.base("record.get_request"), payload: { record_id: recordId } });

    expect(after.payload).toEqual(before.payload);

    await c.close();
    await srv.close();
  });
});
