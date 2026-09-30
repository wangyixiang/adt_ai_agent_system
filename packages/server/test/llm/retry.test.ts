import { describe, it, expect } from "vitest";
import { OpenAiCompatibleProvider } from "../../src/llm/openaiCompatible";
import type { LlmRequest } from "../../src/llm/provider";

const ok = (): Response =>
  new Response(
    JSON.stringify({
      choices: [
        { message: { tool_calls: [{ function: { name: "propose_step", arguments: "{}" } }] } },
      ],
    }),
    { status: 200 },
  );

function providerWith(responses: Array<Response | Error>, over: Record<string, unknown> = {}) {
  let attempts = 0;
  const sleeps: number[] = [];
  const provider = new OpenAiCompatibleProvider({
    baseUrl: "http://llm.test/v1",
    apiKey: "k",
    model: "m",
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    fetch: (async () => {
      const next = responses[Math.min(attempts, responses.length - 1)]!;
      attempts++;
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch,
    ...over,
  });
  return { provider, attempts: () => attempts, sleeps };
}

const request: LlmRequest = {
  messages: [{ role: "user", content: "decide" }],
  tools: [],
  toolChoice: "propose_step",
};

describe("LlmProvider retry", () => {
  it("retries a 429 and a 5xx with exponential backoff", async () => {
    const h = providerWith([
      new Response("slow down", { status: 429 }),
      new Response("boom", { status: 503 }),
      ok(),
    ]);

    await h.provider.complete(request);

    expect(h.attempts()).toBe(3);
    expect(h.sleeps).toEqual([500, 1000]);
  });

  it("retries a network failure", async () => {
    const h = providerWith([new TypeError("fetch failed"), ok()]);

    await h.provider.complete(request);

    expect(h.attempts()).toBe(2);
  });

  it("does not retry a 4xx that is not 429", async () => {
    const h = providerWith([new Response("bad request", { status: 400 })]);

    await expect(h.provider.complete(request)).rejects.toThrow(/LLM HTTP 400/);
    // Retrying a rejected request would just be rejected again.
    expect(h.attempts()).toBe(1);
  });

  it("does not retry a malformed tool call", async () => {
    const malformed = new Response(
      JSON.stringify({
        choices: [
          { message: { tool_calls: [{ function: { name: "propose_step", arguments: "not json" } }] } },
        ],
      }),
      { status: 200 },
    );
    const h = providerWith([malformed, ok()]);

    await expect(h.provider.complete(request)).rejects.toThrow(/not valid JSON/);
    // A model-semantics error is deterministic: repeating it only costs money.
    expect(h.attempts()).toBe(1);
  });

  it("gives up after the configured attempts", async () => {
    const h = providerWith([new Response("boom", { status: 500 })], { maxRetries: 2 });

    await expect(h.provider.complete(request)).rejects.toThrow(/LLM HTTP 500/);
    expect(h.attempts()).toBe(3);
  });

  it("does not retry at all when retries are disabled", async () => {
    const h = providerWith([new Response("boom", { status: 500 })], { maxRetries: 0 });

    await expect(h.provider.complete(request)).rejects.toThrow(/LLM HTTP 500/);
    expect(h.attempts()).toBe(1);
  });

  it("does not retry its own timeout", async () => {
    // An aborted request already waited the full timeout: retrying it would
    // triple the worst case without evidence that it helps (ADR-004 §2: a hung
    // provider must not wedge a session for minutes).
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const h = providerWith([timeout, ok()]);

    await expect(h.provider.complete(request)).rejects.toThrow(/timeout/);
    expect(h.attempts()).toBe(1);
    expect(h.sleeps).toEqual([]);
  });
});
