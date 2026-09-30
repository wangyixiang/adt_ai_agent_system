import { describe, it, expect } from "vitest";
import { llmProviderFromEnv } from "../../src/llm/openaiCompatible";

describe.skipIf(!process.env.LLM_API_KEY)("real LLM provider", () => {
  it("responds with a tool call for the planner", async () => {
    const cfg = llmProviderFromEnv(process.env)!;
    const res = await cfg.provider.complete({
      messages: [
        {
          role: "user",
          content: "Return the tool call set_completion_criteria with description 'ok'.",
        },
      ],
      tools: [
        {
          name: "set_completion_criteria",
          description: "set criteria",
          parameters: {
            type: "object",
            required: ["description"],
            properties: { description: { type: "string" } },
          },
        },
      ],
      toolChoice: "set_completion_criteria",
    });
    expect(res.toolCalls[0]!.name).toBe("set_completion_criteria");
  }, 30000);
});
