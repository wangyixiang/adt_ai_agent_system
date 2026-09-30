import { describe, it, expect } from "vitest";
import { llmProviderFromEnv, OpenAiCompatibleProvider } from "../../src/llm/openaiCompatible";

const retriesFrom = (env: NodeJS.ProcessEnv): number =>
  (llmProviderFromEnv(env)!.provider as OpenAiCompatibleProvider).maxRetries;

describe("llmProviderFromEnv", () => {
  it("is disabled without an API key", () => {
    expect(llmProviderFromEnv({})).toBeNull();
  });

  it("defaults to two retries", () => {
    expect(retriesFrom({ LLM_API_KEY: "k" })).toBe(2);
  });

  it("honours an explicit count, including zero", () => {
    expect(retriesFrom({ LLM_API_KEY: "k", LLM_MAX_RETRIES: "0" })).toBe(0);
    expect(retriesFrom({ LLM_API_KEY: "k", LLM_MAX_RETRIES: "5" })).toBe(5);
  });

  it("falls back to the default for an empty or unusable value", () => {
    // `Number("")` is 0, which would silently read as "retry nothing".
    expect(retriesFrom({ LLM_API_KEY: "k", LLM_MAX_RETRIES: "" })).toBe(2);
    expect(retriesFrom({ LLM_API_KEY: "k", LLM_MAX_RETRIES: "abc" })).toBe(2);
    expect(retriesFrom({ LLM_API_KEY: "k", LLM_MAX_RETRIES: "-1" })).toBe(2);
    expect(retriesFrom({ LLM_API_KEY: "k", LLM_MAX_RETRIES: "2.5" })).toBe(2);
  });
});
