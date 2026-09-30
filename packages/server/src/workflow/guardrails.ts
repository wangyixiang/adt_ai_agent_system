export interface GuardrailConfig {
  maxStepsPerWorkflow: number;
  maxConsecutiveRetriesPerCapability: number;
  maxNotSolvedRounds: number;
  timeBudgetMs: number | null;
}

/** WORKFLOW_SPEC.md §13 defaults. */
export const DEFAULT_GUARDRAILS: GuardrailConfig = {
  maxStepsPerWorkflow: 50,
  maxConsecutiveRetriesPerCapability: 2,
  maxNotSolvedRounds: 5,
  timeBudgetMs: null,
};

export type GuardrailReason =
  | "step_limit"
  | "retry_limit"
  | "user_round_limit"
  | "time_budget";

/** The configured limit behind a breach, for the Record (RECORD_SPEC.md §4). */
export function guardrailThreshold(
  config: GuardrailConfig,
  reason: GuardrailReason,
): number | null {
  switch (reason) {
    case "step_limit":
      return config.maxStepsPerWorkflow;
    case "retry_limit":
      return config.maxConsecutiveRetriesPerCapability;
    case "user_round_limit":
      return config.maxNotSolvedRounds;
    case "time_budget":
      return config.timeBudgetMs;
  }
}

export interface GuardrailInput {
  stepCount: number;
  consecutiveRetries: number;
  notSolvedRounds: number;
  elapsedMs: number;
}

/**
 * Returns the first breached limit (fixed order), or null.
 * Every limit uses a strict `>`: reaching the limit exactly is still allowed.
 */
export function breachedGuardrail(
  input: GuardrailInput,
  config: GuardrailConfig,
): GuardrailReason | null {
  if (input.stepCount > config.maxStepsPerWorkflow) return "step_limit";
  if (input.consecutiveRetries > config.maxConsecutiveRetriesPerCapability) {
    return "retry_limit";
  }
  if (input.notSolvedRounds > config.maxNotSolvedRounds) return "user_round_limit";
  if (config.timeBudgetMs !== null && input.elapsedMs > config.timeBudgetMs) {
    return "time_budget";
  }
  return null;
}
