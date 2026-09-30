import type { LlmProvider, LlmRequest, LlmResponse } from "./provider";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Request timeout in ms (default 30s); a hung provider must not wedge a session. */
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

interface ToolCallsBody {
  choices?: Array<{
    message?: {
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

/**
 * OpenAI-compatible Chat Completions with function calling. Works with OpenAI,
 * Azure OpenAI, and compatible gateways (including DeepSeek's OpenAI-compatible
 * endpoint). Structured output is required, so the model must call one tool.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      body: JSON.stringify({
        model: this.opts.model,
        messages: request.messages,
        tools: request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })),
        tool_choice: { type: "function", function: { name: request.toolChoice } },
        temperature: request.temperature,
      }),
    });

    if (!response.ok) throw new Error(`LLM HTTP ${response.status}`);

    const data = (await response.json()) as ToolCallsBody;
    const calls = data.choices?.[0]?.message?.tool_calls ?? [];

    return {
      toolCalls: calls.map((call) => {
        const name = call.function?.name;
        if (typeof name !== "string") throw new Error("LLM tool call without a name");

        const raw = call.function?.arguments ?? "{}";
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error("LLM tool call arguments are not valid JSON");
        }
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error("LLM tool call arguments are not an object");
        }
        return { name, arguments: parsed as Record<string, unknown> };
      }),
    };
  }
}

/**
 * Builds the production provider from the environment (ADR-004 §2).
 * Returns null when no API key is configured, so the server can fall back to
 * the no-op planner instead of failing at startup.
 */
export function llmProviderFromEnv(
  env: NodeJS.ProcessEnv,
): { provider: LlmProvider; model: string } | null {
  const apiKey = env.LLM_API_KEY;
  if (!apiKey) return null;

  const model = env.LLM_MODEL ?? "deepseek-v4.1-flash";
  const baseUrl = env.LLM_BASE_URL ?? "https://api.deepseek.com/v1";
  return { provider: new OpenAiCompatibleProvider({ baseUrl, apiKey, model }), model };
}
