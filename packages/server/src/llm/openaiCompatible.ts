import type { LlmProvider, LlmRequest, LlmResponse } from "./provider";

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Request timeout in ms (default 30s); a hung provider must not wedge a session. */
  timeoutMs?: number;
  /**
   * Retries for *transient* failures (429, 5xx, network). Default 2, so a blip
   * costs one extra round trip instead of a dead workflow.
   *
   * Worst case is `timeoutMs × (maxRetries + 1)` plus the backoff sum: each
   * attempt gets its own timeout window. Our *own* timeout is not retried, so a
   * hung provider costs a single window.
   */
  maxRetries?: number;
  /** Backoff base in ms (default 500), doubled per attempt. */
  retryBaseMs?: number;
  /** Injectable for tests, so a retry does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 500;

/** A transient status is worth another attempt; a 4xx is a verdict, not a hiccup. */
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/**
 * Our own timeout is not a transient failure: the request already waited the
 * full `timeoutMs`, so retrying would triple the worst-case wait for a request
 * that is hanging rather than blipping.
 */
const isOwnTimeout = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
};

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
  /** Exposed for tests and diagnostics; see `OpenAiCompatibleOptions.maxRetries`. */
  readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OpenAiCompatibleOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.maxRetries = Math.max(0, opts.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryBaseMs = opts.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const body = JSON.stringify({
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
    });

    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        // Only the transport call is inside this try: an unparseable or
        // malformed *answer* is a different kind of failure (below), and must
        // not be retried.
        response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.opts.apiKey}`,
          },
          signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
          body,
        });
      } catch (error) {
        if (!isOwnTimeout(error) && attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw error;
      }

      if (!response.ok) {
        if (isRetryableStatus(response.status) && attempt < this.maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw new Error(`LLM HTTP ${response.status}`);
      }

      // Past this point every failure is deterministic (the model said
      // something unusable), so it is reported as-is.
      return this.toResponse((await response.json()) as ToolCallsBody);
    }
  }

  private backoff(attempt: number): Promise<void> {
    return this.sleep(this.retryBaseMs * 2 ** attempt);
  }

  private toResponse(data: ToolCallsBody): LlmResponse {
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
  return {
    provider: new OpenAiCompatibleProvider({
      baseUrl,
      apiKey,
      model,
      maxRetries: parseRetries(env.LLM_MAX_RETRIES),
    }),
    model,
  };
}

/**
 * A missing or unusable value falls back to the default rather than silently
 * disabling retries: `Number("")` is `0`, which would read as "retry nothing".
 */
function parseRetries(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_MAX_RETRIES;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_RETRIES;
}
