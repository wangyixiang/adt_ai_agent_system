/**
 * The LLM seam (ADR-004 §2): "Provider abstraction + MVP cloud API". The
 * planner speaks this interface; tests use a scripted provider, production
 * uses the OpenAI-compatible one. No other module talks to a model directly.
 */

export interface LlmTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools: LlmTool[];
  /** The single tool the model must call (structured output). */
  toolChoice: string;
  temperature?: number;
}

export interface LlmToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LlmResponse {
  toolCalls: LlmToolCall[];
}

export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
}
