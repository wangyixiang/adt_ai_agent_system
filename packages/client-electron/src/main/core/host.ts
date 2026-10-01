import { randomUUID } from "node:crypto";

import { MANUAL_OUTCOMES, validateAnswer, type Answer, type Ask, type AskKind } from "@adt/shared";
import type {
  ConfirmationRequest,
  ManualActionFeedback,
  ResourceConflictRequest,
  UserInputRequest,
} from "@adt/client-daemon";

export type AnswerOutcome =
  | { ok: true; answer: Answer }
  | {
      ok: false;
      code: "unknown_ask" | "ask_already_answered" | "malformed_payload";
      message: string;
    };

/** The fourth decision: the Server proposes "solved?", the human disposes. */
export interface CompletionRequest {
  workflowId: string;
  summary: string;
  evidenceRefs: string[];
}

/**
 * The four human decisions, as the daemon wants them. Each one is published as an
 * `ask` (so the renderer can show a card) and resolves only when `answer` accepts
 * what the human sent. **Nobody answering leaves it pending**, which is the
 * designed behaviour; the daemon's own safe defaults cover the no-host case.
 */
export interface DecisionHost {
  onConfirmationRequired(request: ConfirmationRequest): Promise<boolean>;
  onUserInput(request: UserInputRequest): Promise<ManualActionFeedback | undefined>;
  onResourceConflict(request: ResourceConflictRequest): Promise<"wait" | "stop">;
  completion(request: CompletionRequest): Promise<"solved" | "not_solved">;
  answer(askId: string, body: unknown): AnswerOutcome;
  abandon(): void;
}

export function createDecisionHost(publish: (ask: Ask, workflowId: string) => void): DecisionHost {
  const pending = new Map<string, { kind: AskKind; resolve(answer: Answer): void }>();
  const answered = new Set<string>();
  const ANSWERED_MEMORY = 200;

  const ask = <T>(detail: Ask, workflowId: string, map: (answer: Answer) => T): Promise<T> =>
    new Promise<T>((resolve) => {
      pending.set(detail.askId, { kind: detail.kind, resolve: (answer) => resolve(map(answer)) });
      publish(detail, workflowId);
    });

  return {
    onConfirmationRequired(request) {
      return ask(
        {
          askId: `ask_${randomUUID()}`,
          kind: "confirmation",
          stepId: request.stepId,
          capability: request.capability,
          objective: request.objective,
          input: request.input,
        },
        request.workflowId,
        (answer) => answer.kind === "confirmation" && answer.decision === "confirmed",
      );
    },

    onUserInput(request) {
      const instruction = request.input["instruction"];
      return ask(
        {
          askId: `ask_${randomUUID()}`,
          kind: "manual_action",
          stepId: request.stepId,
          capability: request.capability,
          objective: request.objective,
          instruction: typeof instruction === "string" ? instruction : "",
          outcomes: MANUAL_OUTCOMES,
        },
        request.workflowId,
        (answer): ManualActionFeedback | undefined => {
          if (answer.kind !== "manual_action") return undefined;
          return {
            outcome: answer.outcome,
            observation: answer.observation,
            ...(answer.details === undefined ? {} : { details: answer.details }),
          };
        },
      );
    },

    onResourceConflict(request) {
      return ask<"wait" | "stop">(
        {
          askId: `ask_${randomUUID()}`,
          kind: "resource_conflict",
          stepId: request.stepId,
          capability: request.capability,
          objective: request.objective,
          ...(request.message === undefined ? {} : { message: request.message }),
        },
        request.workflowId,
        (answer) => (answer.kind === "resource_conflict" ? answer.answer : "stop"),
      );
    },

    completion(request) {
      return ask<"solved" | "not_solved">(
        {
          askId: `ask_${randomUUID()}`,
          kind: "completion",
          workflowId: request.workflowId,
          summary: request.summary,
          evidenceRefs: request.evidenceRefs,
        },
        request.workflowId,
        (answer) =>
          answer.kind === "completion" && answer.resolution === "solved" ? "solved" : "not_solved",
      );
    },

    answer(askId, body) {
      const entry = pending.get(askId);
      if (entry === undefined) {
        return answered.has(askId)
          ? { ok: false, code: "ask_already_answered", message: "this question was already answered" }
          : { ok: false, code: "unknown_ask", message: "no such question" };
      }
      const validated = validateAnswer(entry.kind, body);
      if (!validated.ok) return validated;

      pending.delete(askId);
      answered.add(askId);
      if (answered.size > ANSWERED_MEMORY) {
        const [oldest] = answered;
        if (oldest !== undefined) answered.delete(oldest);
      }
      entry.resolve(validated.value);
      return { ok: true, answer: validated.value };
    },

    abandon() {
      pending.clear();
      answered.clear();
    },
  };
}
