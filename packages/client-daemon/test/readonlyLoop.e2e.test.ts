import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer } from "@adt/test-support";
import { ClientDaemon } from "../src/daemon";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "adt-e2e-"));
  await writeFile(join(root, "notes.txt"), "svc is down", "utf8");
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("read-only closed loop over the real daemon", () => {
  it("executes a read step, produces schema-valid evidence and reaches COMPLETED", async () => {
    const srv = await startTestServer({
      planner: [
        {
          kind: "step",
          step: {
            objective: "read notes",
            capability: "filesystem.read_file",
            sideEffect: false,
            interruptible: true,
            input: { path: "notes.txt" },
          },
        },
        { kind: "completion_candidate", summary: "看完了", evidenceRefs: [] },
      ],
    });
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials: { username: "alice", secret: "pw-alice" },
      clientInfo: { name: "daemon-e2e", platform: "test" },
      workspaceRoot: root,
    });
    const c = daemon.connection;

    let workflowId = "";
    let stepId = "";
    c.on("workflow.created", (env) => {
      workflowId = (env.payload as { workflow_id: string }).workflow_id;
    });
    c.on("step.dispatch", (env) => {
      stepId = (env.payload as { step_id: string }).step_id;
    });
    c.on("workflow.completion_candidate", () => {
      c.send("workflow.completion_response", { workflow_id: workflowId, resolution: "solved" });
    });

    // The daemon executes step.dispatch on its own; we observe the server.
    const terminated = await new Promise<Record<string, unknown>>((resolve) => {
      c.on("workflow.terminated", (env) => resolve(env.payload as Record<string, unknown>));
      c.send("workflow.request", {
        client_request_id: "req_e2e",
        user_request: { text: "服务起不来", attachments: [], context: {} },
      });
    });

    // The read step really completed with schema-valid evidence.
    expect((await srv.engine.getStep(stepId))!.state).toBe("COMPLETED");
    expect(terminated.terminal_state).toBe("COMPLETED");
    const recordId = terminated.record_id as string;
    expect(recordId).toMatch(/^rec_/);

    const recordEnv = await new Promise<{ payload: unknown }>((resolve) => {
      c.on("record.get_response", (env) => resolve(env));
      c.send("record.get_request", { record_id: recordId });
    });
    const record = (
      recordEnv.payload as {
        record: { entries: Array<{ kind: string; ref: Record<string, unknown> }> };
      }
    ).record;
    const evidence = record.entries.find((entry) => entry.kind === "evidence_received")!;
    expect(evidence.ref.evidence).toMatchObject({
      source: "capability",
      type: "file_content",
      result: { content: "svc is down" },
    });

    await daemon.close();
    await srv.close();
  });
});
