import { describe, it, expect } from "vitest";
import { startTestServer, TestClient, ScriptedLlmProvider } from "@adt/test-support";

const llm = () =>
  new ScriptedLlmProvider([
    {
      toolCalls: [
        { name: "set_completion_criteria", arguments: { mode: "open", description: "问题消失" } },
      ],
    },
    {
      toolCalls: [
        {
          name: "propose_step",
          arguments: {
            action: "step",
            step: {
              objective: "查看 git 状态",
              capability: "git.collect_diagnostics",
              input: { project_path: "/a" },
            },
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          name: "propose_step",
          arguments: {
            action: "completion_candidate",
            completion: { summary: "分支正常，问题应已消除", evidence_refs: [] },
          },
        },
      ],
    },
  ]);

describe("read-only closed loop (fake LLM)", () => {
  it("runs request → read step → completion → record → report", async () => {
    const srv = await startTestServer({ llm: llm() });
    const c = await TestClient.connect(srv.url);
    await c.hello({
      username: "alice",
      secret: "pw-alice",
      capabilities: [
        {
          name: "git.collect_diagnostics",
          side_effect: false,
          interruptible: true,
          input_schema: {
            type: "object",
            required: ["project_path"],
            properties: { project_path: { type: "string" } },
          },
          output_schema: {
            type: "object",
            required: ["branch"],
            properties: { branch: { type: "string" } },
          },
        },
      ],
    });

    const created = await c.sendRaw({
      ...c.base("workflow.request"),
      payload: {
        client_request_id: "req_1",
        user_request: { text: "项目起不来了", attachments: [], context: {} },
      },
    });
    const workflowId = (created.payload as { workflow_id: string }).workflow_id;

    const dispatch = await c.next();
    expect((dispatch.payload as any).capability).toBe("git.collect_diagnostics");
    expect((dispatch.payload as any).input).toEqual({ project_path: "/a" });

    await c.send({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, step_id: (dispatch.payload as any).step_id, status: "RUNNING" },
    });
    const candidate = await c.sendRaw({
      ...c.base("step.status"),
      workflow_id: workflowId,
      payload: {
        workflow_id: workflowId,
        step_id: (dispatch.payload as any).step_id,
        status: "COMPLETED",
        evidence: { source: "capability", type: "git_status", result: { branch: "main" } },
      },
    });
    expect(candidate.type).toBe("workflow.completion_candidate");

    const terminated = await c.sendRaw({
      ...c.base("workflow.completion_response"),
      workflow_id: workflowId,
      payload: { workflow_id: workflowId, resolution: "solved" },
    });
    expect((terminated.payload as any).terminal_state).toBe("COMPLETED");
    const recordId = (terminated.payload as any).record_id as string;

    const report = await c.sendRaw({
      ...c.base("report.generate_request"),
      payload: { record_id: recordId, options: {} },
    });
    expect((report.payload as any).status).toBe("ok");

    await c.close();
    await srv.close();
  });
});
