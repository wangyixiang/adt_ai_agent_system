import { describe, it, expect } from "vitest";
import { OpenAiCompatibleProvider } from "../../src/llm/openaiCompatible";

describe("OpenAiCompatibleProvider", () => {
  it("maps the request to OpenAI tool-calling and parses the tool call", async () => {
    let body: unknown;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                tool_calls: [
                  { function: { name: "propose_step", arguments: '{"action":"completion_candidate"}' } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.example/v1",
      apiKey: "k",
      model: "m",
      fetch: fakeFetch,
    });
    const res = await provider.complete({
      messages: [{ role: "system", content: "s" }],
      tools: [{ name: "propose_step", description: "d", parameters: { type: "object" } }],
      toolChoice: "propose_step",
    });

    expect((body as { model: string }).model).toBe("m");
    expect((body as { tool_choice: unknown }).tool_choice).toEqual({
      type: "function",
      function: { name: "propose_step" },
    });
    expect(res.toolCalls).toEqual([
      { name: "propose_step", arguments: { action: "completion_candidate" } },
    ]);
  });

  it("throws on a non-2xx response", async () => {
    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.example/v1",
      apiKey: "k",
      model: "m",
      // The retry policy has its own tests; here we only care that a 5xx ends in
      // an error, not how long the backoff takes.
      sleep: async () => undefined,
      fetch: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    await expect(provider.complete({ messages: [], tools: [], toolChoice: "t" })).rejects.toThrow();
  });

  it("aborts a hanging request via the configured timeout", async () => {
    const hangingFetch = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          // What `AbortSignal.timeout` produces in real life.
          reject(Object.assign(new Error("The operation was aborted due to timeout"), {
            name: "TimeoutError",
          }));
        });
      })) as unknown as typeof fetch;

    const provider = new OpenAiCompatibleProvider({
      baseUrl: "https://api.example/v1",
      apiKey: "k",
      model: "m",
      fetch: hangingFetch,
      timeoutMs: 20,
    });
    await expect(provider.complete({ messages: [], tools: [], toolChoice: "t" })).rejects.toThrow();
  });
});
