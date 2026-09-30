import {
  HUMAN_MANUAL_ACTION,
  HUMAN_MANUAL_ACTION_CAPABILITY,
  validateJsonSchema,
  type JsonSchema,
  type NormalizedCapability,
} from "@adt/shared";
import { WorkflowBlockedError, type WorkflowEngine } from "./engine";
import type { Planner, PlannerDecision } from "./planner";
import { isActiveStep, isTerminalWorkflow } from "./stateMachine";
import type { StepSnapshot, WorkflowEvent, WorkflowStore } from "./store";

export type { Planner, PlannerDecision, PlannerInput } from "./planner";

export interface AdvanceResult {
  dispatched?: StepSnapshot;
  completionCandidate?: { summary: string; evidenceRefs: string[] };
}

export interface OrchestratorDeps {
  engine: WorkflowEngine;
  store: WorkflowStore;
  planner: Planner;
  /**
   * The owning session's declared Capabilities, used both to plan and to
   * validate the produced step input (CAPABILITY_SPEC.md §5.2).
   */
  capabilitiesOf?: (sessionId: string) => NormalizedCapability[];
  /** Fallback step_timeout for capabilities that declare no timeout_hint. */
  defaultStepTimeoutMs?: number;
}

/** WORKFLOW_SPEC.md §13: a step that never reports back is bounded anyway. */
const DEFAULT_STEP_TIMEOUT_MS = 60_000;

/**
 * Validates a planner-produced step input against the Capability's input
 * schema. Returns an error string, or null when the input is acceptable.
 * An absent capability or a missing schema does not block
 * (CAPABILITY_SPEC.md §5.4) — it warns. A capability the client never declared
 * is caught by the client's own `REJECTED(capability_unavailable)`.
 */
export function validateStepInput(
  capabilities: NormalizedCapability[],
  capability: string,
  input: unknown,
): string | null {
  const found = capabilities.find((candidate) => candidate.name === capability);
  if (!found || !found.input_schema) {
    console.warn(`[orchestrator] no input_schema for ${capability}; skipping validation`);
    return null;
  }

  const result = validateJsonSchema(found.input_schema as JsonSchema, input);
  return result.valid ? null : result.errors.join("; ");
}

/**
 * A provider that cannot get the resource reports `REJECTED(reject_reason.code =
 * "resource_conflict")` after asking the engineer, and the verdict is final:
 * the workflow ends instead of re-planning around it (WORKFLOW_SPEC.md §4.4 —
 * the Server does not arbitrate resources). The reason only exists in the event
 * log, because steps do not persist their reject reason.
 */
export function hasResourceConflict(events: WorkflowEvent[]): boolean {
  return events.some((event) => {
    if (event.kind !== "step_status") return false;
    const payload = (event.payload ?? {}) as { state?: unknown; rejectReason?: unknown };
    const code = (payload.rejectReason as { code?: unknown } | undefined)?.code;
    return payload.state === "REJECTED" && code === "resource_conflict";
  });
}

/**
 * Decides what happens next for a workflow. It respects One-Step Planning * (ADR-002): while a step is active, or once the workflow is terminal, it does
 * nothing and never consults the planner. Planner failures and schema-invalid
 * planner output are turned into deterministic failures — never a stall.
 */
export class WorkflowOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async advance(workflowId: string): Promise<AdvanceResult> {
    const workflow = await this.deps.engine.get(workflowId);
    if (!workflow || isTerminalWorkflow(workflow.state)) return {};

    const steps = await this.deps.store.listSteps(workflowId);
    if (steps.some((step) => isActiveStep(step.state))) return {};

    const events = await this.deps.store.listEvents(workflowId);

    // A provider that cannot get the resource reports it honestly, and the
    // planner must not quietly route around it by proposing something else
    // (WORKFLOW_SPEC.md §4.4 — the Server does not arbitrate resources). Cancel
    // intent still wins: engine.fail converges a CANCELLING workflow to
    // CANCELLED.
    if (hasResourceConflict(events)) {
      console.warn(`[orchestrator] a provider reported a resource conflict; ending ${workflowId}`);
      await this.deps.engine.fail(workflowId, "resource_conflict");
      return {};
    }

    const declared = this.deps.capabilitiesOf?.(workflow.sessionId) ?? [];

    // The reserved advisory capability is implicitly supported by every Client
    // and is never declared in a Manifest (CAPABILITY_SPEC.md §6), so the
    // Server is the one that makes it choosable — otherwise nothing would ever
    // propose the "please do this by hand" path.
    const offered = declared.some((capability) => capability.name === HUMAN_MANUAL_ACTION)
      ? declared
      : [...declared, HUMAN_MANUAL_ACTION_CAPABILITY];

    // WORKFLOW_SPEC.md §4.3 side-effect blocking: while a side effect is
    // unreconciled, the planner is not even offered a side-effecting
    // capability. The engine enforces the same rule, so a planner that somehow
    // still asks for one is caught rather than obeyed.
    const unresolved = steps.some((step) => step.state === "UNKNOWN");
    const capabilities = unresolved
      ? offered.filter((capability) => !capability.side_effect)
      : offered;

    let decision: PlannerDecision;
    try {
      decision = await this.deps.planner.proposeNext({ workflow, steps, events, capabilities });
    } catch (error) {
      console.error(`[orchestrator] planner failed for ${workflowId}:`, error);
      await this.deps.engine.fail(workflowId, "planner_error");
      return {};
    }

    if (decision.kind === "step") {
      if (decision.criteria) {
        await this.deps.engine.reviseCriteria(workflowId, decision.criteria);
      }
      const invalid = validateStepInput(
        capabilities,
        decision.step.capability,
        decision.step.input ?? {},
      );
      if (invalid) {
        console.warn(`[orchestrator] invalid step input for ${workflowId}: ${invalid}`);
        await this.deps.engine.fail(workflowId, "invalid_input");
        return {};
      }

      const capability = capabilities.find((candidate) => candidate.name === decision.step.capability);
      let dispatched: StepSnapshot;
      try {
        dispatched = await this.deps.engine.dispatchStep(workflowId, {
          ...decision.step,
          // Frozen at dispatch so a later capability.sync cannot move the goalposts
          // for an in-flight step (CAPABILITY_SPEC.md §4.1).
          outputSchema: (capability?.output_schema as Record<string, unknown> | undefined) ?? null,
          // Same reasoning for the deadline: the monitor must not consult the
          // live registry while a step is in flight (PROTOCOL_SPEC.md §9).
          timeoutMs:
            decision.step.timeoutMs ??
            capability?.timeout_hint ??
            this.deps.defaultStepTimeoutMs ??
            DEFAULT_STEP_TIMEOUT_MS,
        });
      } catch (error) {
        // A planner that proposes a side effect while one is unresolved is a
        // planner error, not a reason to hang: fail deterministically (the
        // existing contract for unusable planner output) rather than stall.
        //
        // The UNKNOWN can also appear WHILE the planner is deciding (the step
        // timeout monitor runs concurrently), in which case the proposal was
        // legitimate and the advance that created the UNKNOWN owns the next
        // move — failing the workflow there would be wrong.
        if (error instanceof WorkflowBlockedError) {
          console.warn(`[orchestrator] ${error.message} (workflow ${workflowId})`);
          if (unresolved) await this.deps.engine.fail(workflowId, "planner_error");
          return {};
        }
        throw error;
      }
      return { dispatched };
    }

    // Reconciliation (WORKFLOW_SPEC.md §4.3): the planner judged an UNKNOWN
    // side-effect step from the evidence gathered afterwards. It is not a new
    // step, so One-Step Planning does not apply; the engine applies the verdict
    // and the ordinary loop continues — otherwise a reconciled workflow would
    // sit with no active step and no next proposal (stalled until some client
    // message). Recursion is bounded: each reconcile consumes one UNKNOWN step,
    // and reconciling a step that is not UNKNOWN throws.
    if (decision.kind === "reconcile") {
      // Whether the planner was entitled to settle this step at all is decided
      // from the snapshot it was given, not from the state at throw time.
      const askedForUnknown = steps.some(
        (step) => step.id === decision.stepId && step.state === "UNKNOWN",
      );
      try {
        await this.deps.engine.reconcileUnknown(
          workflowId,
          decision.stepId,
          decision.outcome,
          decision.evidenceRefs,
        );
      } catch (error) {
        if (!askedForUnknown) {
          // The verdict targets a step that was never UNKNOWN: a planner error.
          console.warn(`[orchestrator] ${(error as Error).message} (workflow ${workflowId})`);
          await this.deps.engine.fail(workflowId, "planner_error");
          return {};
        }
        // The planner was entitled to settle it, so the only way this throws is
        // a concurrent advance getting there first (the timeout monitor and a
        // client message can both drive one workflow). The winner already
        // carried the workflow on; the loser must not terminate it.
        console.warn(
          `[orchestrator] reconciliation raced with a concurrent advance for ${workflowId}; already settled`,
        );
        return {};
      }
      return this.advance(workflowId);
    }

    // A completion candidate is a proposal; the protocol layer records the
    // event and sends it. State is untouched here.
    if (decision.criteria) {
      await this.deps.engine.reviseCriteria(workflowId, decision.criteria);
    }
    return {
      completionCandidate: {
        summary: decision.summary,
        evidenceRefs: decision.evidenceRefs,
      },
    };
  }
}
