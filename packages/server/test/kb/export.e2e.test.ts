import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { startTestServer, TestClient, type TestServer } from "@adt/test-support";
import { createHttpDepositor } from "../../src/kb/depositor";
import type { KbConfig } from "../../src/kb/config";

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
  knowledgeDepositor: ReturnType<typeof createHttpDepositor>,
): Promise<{ srv: TestServer; c: TestClient; recordId: string }> {
  const srv = await startTestServer({ planner: [...script], knowledgeDepositor });
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

interface Received {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A real HTTP endpoint that answers each POST with the next scripted status. */
async function fakeKnowledgeBase(statuses: number[]) {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      const status = statuses[Math.min(received.length - 1, statuses.length - 1)] ?? 200;
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(status >= 400 ? "rejected" : "accepted");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;

  return {
    received,
    url: `http://127.0.0.1:${port}/deposit`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function configFor(url: string): KbConfig {
  return {
    endpointUrl: url,
    authHeader: "Authorization",
    authScheme: "Bearer",
    token: "e2e-secret",
    timeoutMs: 2000,
    maxRetries: 2,
    // Kept small so a retry does not slow the suite down.
    retryBaseMs: 10,
  };
}

describe("KB export over real HTTP", () => {
  it("posts the deposit with the configured auth and reports ok", async () => {
    const kb = await fakeKnowledgeBase([202]);
    const { srv, c, recordId } = await completedWorkflow(createHttpDepositor(configFor(kb.url)));

    const result = await c.sendRaw({
      ...c.base("record.export_request"),
      payload: { record_id: recordId, object: "record", target: "knowledge_base" },
    });
    expect(result.payload).toMatchObject({ status: "ok", error_code: null, message: null });

    expect(kb.received).toHaveLength(1);
    expect(kb.received[0]!.headers.authorization).toBe("Bearer e2e-secret");
    const deposited = JSON.parse(kb.received[0]!.body) as Record<string, unknown>;
    expect(deposited).toMatchObject({
      deposit_version: "1",
      source: "adt_ai_agent_system",
      record_id: recordId,
      object: "record",
    });
    expect(deposited.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(deposited.deposit_id).toMatch(/^dep_[0-9a-f]{64}$/);

    await c.close();
    await srv.close();
    await kb.close();
  });

  it("treats a 4xx as a verdict and does not retry it", async () => {
    const kb = await fakeKnowledgeBase([422]);
    const { srv, c, recordId } = await completedWorkflow(createHttpDepositor(configFor(kb.url)));

    const result = await c.sendRaw({
      ...c.base("record.export_request"),
      payload: { record_id: recordId, object: "record", target: "knowledge_base" },
    });
    expect(result.payload).toMatchObject({ status: "failed", error_code: "export_failed" });
    expect((result.payload as { message: string }).message).toContain("422");
    expect(kb.received).toHaveLength(1);

    await c.close();
    await srv.close();
    await kb.close();
  });

  it("retries a 503 and succeeds on the second attempt", async () => {
    const kb = await fakeKnowledgeBase([503, 200]);
    const { srv, c, recordId } = await completedWorkflow(createHttpDepositor(configFor(kb.url)));

    const result = await c.sendRaw({
      ...c.base("record.export_request"),
      payload: { record_id: recordId, object: "record", target: "knowledge_base" },
    });
    expect(result.payload).toMatchObject({ status: "ok" });
    expect(kb.received).toHaveLength(2);

    await c.close();
    await srv.close();
    await kb.close();
  });

  it("retries a real timeout and then gives up", async () => {
    // A socket that accepts the connection and never answers: the unit tests
    // only ever saw a synthetic TimeoutError, so this is the first proof that
    // `AbortSignal.timeout` actually unwedges a real request.
    let requests = 0;
    const hung = createServer(() => {
      // Never respond.
    });
    hung.on("request", () => {
      requests++;
    });
    hung.listen(0, "127.0.0.1");
    await once(hung, "listening");
    const port = (hung.address() as AddressInfo).port;

    const { srv, c, recordId } = await completedWorkflow(
      createHttpDepositor({ ...configFor(`http://127.0.0.1:${port}/deposit`), timeoutMs: 50, maxRetries: 1 }),
    );

    const result = await c.sendRaw({
      ...c.base("record.export_request"),
      payload: { record_id: recordId, object: "record", target: "knowledge_base" },
    });
    expect(result.payload).toMatchObject({ status: "failed", error_code: "export_failed" });
    expect((result.payload as { message: string }).message).toContain("unreachable");
    // maxRetries 1 ⇒ two real attempts, i.e. the timeout really was retried.
    expect(requests).toBe(2);

    await c.close();
    await srv.close();
    hung.closeAllConnections();
    await new Promise<void>((resolve) => hung.close(() => resolve()));
  });
});
