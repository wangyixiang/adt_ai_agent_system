import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { startTestServer, TestClient } from "@adt/test-support";
import { createPool } from "../../src/db/pool";

/**
 * The property that links the blob channel to the Record (Review Focus 5):
 * a `content_ref` written into evidence must survive into the Record as-is, and
 * a blob a Record cites must stay fetchable — even after it expires.
 */
describe("a Record's content_ref", () => {
  it("is preserved verbatim and protects the blob from collection", async () => {
    const srv = await startTestServer({
      planner: [
        {
          kind: "step",
          step: {
            objective: "抓取日志",
            capability: "filesystem.read_file",
            sideEffect: false,
            interruptible: true,
          },
        },
        { kind: "completion_candidate", summary: "拿到日志了", evidenceRefs: [] },
      ],
    });
    const c = await TestClient.connect(srv.url);
    await c.hello({ username: "alice", secret: "pw-alice" });

    // Upload the log through the real channel: allocate over the protocol, then
    // send the bytes to the signed URL.
    const bytes = Buffer.from("can trace line 1\nline 2\n");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const allocation = await c.sendRaw({
      ...c.base("blob.allocate_request"),
      payload: {
        direction: "upload",
        name: "can_trace.log",
        media_type: "text/plain",
        size: bytes.length,
        sha256,
      },
    });
    const payload = allocation.payload as { content_ref: string; url: string };
    const uploaded = await fetch(payload.url, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: bytes,
    });
    expect(uploaded.status).toBe(201);

    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: {
        client_request_id: "req_blob_ref",
        user_request: { text: "x", attachments: [], context: {} },
      },
    });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;
    const dispatch = await c.next();
    const stepId = (dispatch.payload as { step_id: string }).step_id;

    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: stepId, status: "RUNNING" },
    });
    // The evidence cites the blob instead of inlining the log.
    const candidate = await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: stepId,
        status: "COMPLETED",
        evidence: {
          source: "capability",
          type: "file_content",
          result: {
            content_ref: payload.content_ref,
            media_type: "text/plain",
            size: bytes.length,
            sha256,
            name: "can_trace.log",
          },
        },
      },
    });
    expect(candidate.type).toBe("workflow.completion_candidate");

    const terminated = await c.sendRaw({
      ...c.base("workflow.completion_response"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, resolution: "solved" },
    });
    const recordId = (terminated.payload as { record_id: string }).record_id;

    const recordEnv = await c.sendRaw({
      ...c.base("record.get_request"),
      payload: { record_id: recordId },
    });
    const record = (recordEnv.payload as {
      record: { entries: Array<{ kind: string; ref: Record<string, unknown> }> };
    }).record;
    const evidence = record.entries.find((entry) => entry.kind === "evidence_received")!;
    expect((evidence.ref.evidence as { result: unknown }).result).toMatchObject({
      content_ref: payload.content_ref,
      sha256,
      size: bytes.length,
    });

    // The Record now protects the blob: expire it, sweep, and it is still there.
    // A control blob (expired, unreferenced) proves the sweep really ran.
    await srv.blobs.repository.create({
      contentRef: "blob_control",
      ownerUserId: c.userId,
      direction: "upload",
      name: null,
      mediaType: "text/plain",
      size: 1,
      sha256: "f".repeat(64),
      createdAt: 1,
      expiresAt: 1,
      committedAt: 1,
    });
    const pool = createPool(
      process.env.TEST_DATABASE_URL ?? "postgres://adt:adt@localhost:55432/adt_test",
    );
    await pool.query("UPDATE blobs SET expires_at = 1 WHERE content_ref = $1", [payload.content_ref]);

    expect(await srv.blobs.lifecycle!.sweep()).toEqual(["blob_control"]);
    expect(await srv.blobs.repository.get(payload.content_ref)).not.toBeNull();

    // And it can still be fetched, which is the whole point of the reference.
    const download = await c.sendRaw({
      ...c.base("blob.allocate_request"),
      payload: { direction: "download", content_ref: payload.content_ref },
    });
    const back = await fetch((download.payload as { url: string }).url);
    expect(back.status).toBe(200);
    expect(Buffer.from(await back.arrayBuffer()).equals(bytes)).toBe(true);

    await pool.end();
    await c.close();
    await srv.close();
  });
});
