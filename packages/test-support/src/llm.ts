import type { LlmProvider, LlmRequest, LlmResponse } from "@adt/server";

/**
 * Deterministic test provider: returns queued responses in order and records
 * every request so tests can assert on the prompt and tool schema.
 */
export class ScriptedLlmProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  private readonly responses: LlmResponse[];

  constructor(responses: LlmResponse[]) {
    this.responses = [...responses];
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (!next) throw new Error("ScriptedLlmProvider: no scripted response left");
    return next;
  }
}
