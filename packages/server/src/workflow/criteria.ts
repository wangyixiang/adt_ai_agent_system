/** Request-level completion criteria (WORKFLOW_SPEC.md §8.1). */
export interface CompletionCriteria {
  mode: "formal" | "open";
  assertions?: string[];
  description?: string;
  revision: number;
}

/** Every revision is recorded (WORKFLOW_SPEC.md §8.1). */
export function reviseCriteria(
  current: CompletionCriteria,
  next: Omit<CompletionCriteria, "revision">,
): CompletionCriteria {
  return { ...next, revision: current.revision + 1 };
}
