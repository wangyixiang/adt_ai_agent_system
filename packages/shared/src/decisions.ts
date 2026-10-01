/**
 * The **four human decisions** and the answers they accept (WORKFLOW_SPEC.md
 * §4.2/§4.3/§4.4/§6.1/§7.2). One copy, shared by the app and its host, so no
 * host can get "what a valid answer is" or "what the safe default is" wrong.
 */
import { HUMAN_MANUAL_ACTION_CAPABILITY } from "./protocol/capability";
import { validateJsonSchema, type JsonSchema } from "./schema/validate";

/** The four manual outcomes come from `CAPABILITY_SPEC.md` §6's schema. */
export const MANUAL_OUTCOMES = ["succeeded", "failed", "partially", "unknown"] as const;
export type ManualOutcome = (typeof MANUAL_OUTCOMES)[number];

export type StepState =
  | "PENDING"
  | "RUNNING"
  | "WAITING"
  | "COMPLETED"
  | "FAILED"
  | "REJECTED"
  | "UNKNOWN";

export type TerminalState = "COMPLETED" | "FAILED" | "CANCELLED";

export type AskKind = "confirmation" | "manual_action" | "resource_conflict" | "completion";

/** A question waiting for the human. */
export type Ask =
  | {
      askId: string;
      kind: "confirmation";
      stepId: string;
      capability: string;
      objective: string;
      input: Record<string, unknown>;
    }
  | {
      askId: string;
      kind: "manual_action";
      stepId: string;
      capability: string;
      objective: string;
      instruction: string;
      outcomes: readonly ManualOutcome[];
    }
  | {
      askId: string;
      kind: "resource_conflict";
      stepId: string;
      capability: string;
      objective: string;
      message?: string;
    }
  | {
      askId: string;
      kind: "completion";
      workflowId: string;
      summary: string;
      evidenceRefs: string[];
    };

/** What the human answers with. */
export type Answer =
  | { kind: "confirmation"; decision: "confirmed" | "declined" }
  | {
      kind: "manual_action";
      outcome: ManualOutcome;
      observation: string;
      details?: Record<string, unknown>;
    }
  | { kind: "resource_conflict"; answer: "wait" | "stop" }
  | { kind: "completion"; resolution: "solved" | "not_solved"; feedback?: string };

/**
 * What a host answers when nobody answers. **None of these is "yes"** — the safe
 * direction is always to decline, stop, report nothing, or refuse to call a run
 * solved.
 */
export const SAFE_DEFAULTS = {
  confirmation: false,
  manualFeedback: undefined,
  resourceConflict: "stop",
  completion: "not_solved",
} as const;

/** Free text a person can paste must not become the Record unchecked. */
export const MAX_OBSERVATION_CHARS = 4096;
export const MAX_FEEDBACK_CHARS = 4096;

export type AnswerResult =
  | { ok: true; value: Answer }
  | { ok: false; code: "malformed_payload"; message: string };

const reject = (message: string): AnswerResult => ({ ok: false, code: "malformed_payload", message });

/**
 * The daemon owns what a valid answer is: a body that does not match its kind,
 * an outcome outside the fixed four, or an oversized text is refused — and the
 * question stays open.
 */
export function validateAnswer(kind: AskKind, body: unknown): AnswerResult {
  const value = (body ?? {}) as Record<string, unknown>;
  if (value["kind"] !== kind) return reject(`expected kind ${kind}`);

  switch (kind) {
    case "confirmation": {
      const decision = value["decision"];
      if (decision !== "confirmed" && decision !== "declined") {
        return reject("decision must be confirmed or declined");
      }
      return { ok: true, value: { kind, decision } };
    }

    case "manual_action": {
      // The advisor's report is a *capability output*: validate it against the
      // protocol's own schema (`CAPABILITY_SPEC.md` §6) rather than a second,
      // hand-rolled copy that would drift from it.
      const validated = validateJsonSchema(
        HUMAN_MANUAL_ACTION_CAPABILITY.output_schema as JsonSchema,
        value,
      );
      if (!validated.valid) return reject(validated.errors.join("; "));

      const observation = value["observation"] as string;
      if (observation.length > MAX_OBSERVATION_CHARS) return reject("observation is too long");
      const details = value["details"];
      return {
        ok: true,
        value: {
          kind,
          outcome: value["outcome"] as ManualOutcome,
          observation,
          ...(details === undefined ? {} : { details: details as Record<string, unknown> }),
        },
      };
    }

    case "resource_conflict": {
      const answer = value["answer"];
      if (answer !== "wait" && answer !== "stop") return reject("answer must be wait or stop");
      return { ok: true, value: { kind, answer } };
    }

    case "completion": {
      const resolution = value["resolution"];
      if (resolution !== "solved" && resolution !== "not_solved") {
        return reject("resolution must be solved or not_solved");
      }
      const feedback = value["feedback"];
      if (feedback !== undefined && typeof feedback !== "string") return reject("feedback must be text");
      if (typeof feedback === "string" && feedback.length > MAX_FEEDBACK_CHARS) {
        return reject("feedback is too long");
      }
      return { ok: true, value: { kind, resolution, ...(feedback === undefined ? {} : { feedback }) } };
    }
  }
}
