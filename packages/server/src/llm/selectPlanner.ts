import { LlmPlanner } from "../workflow/llmPlanner";
import { NOOP_PLANNER, type Planner } from "../workflow/planner";
import { llmProviderFromEnv } from "./openaiCompatible";

/**
 * Chooses the production planner: an explicitly supplied planner wins, then an
 * env-configured LLM (ADR-004 §2), then the no-op planner so the server still
 * starts without credentials.
 */
export function selectPlanner(env: NodeJS.ProcessEnv, explicit?: Planner): Planner {
  if (explicit) return explicit;
  const llm = llmProviderFromEnv(env);
  return llm ? new LlmPlanner({ provider: llm.provider }) : NOOP_PLANNER;
}
