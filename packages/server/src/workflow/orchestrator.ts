import {
  validateJsonSchema,
  type JsonSchema,
  type NormalizedCapability,
} from "@adt/shared";
import type { WorkflowEngine } from "./engine";
import type { Planner, PlannerDecision } from "./planner";
import { isActiveStep, isTerminalWorkflow } from "./stateMachine";
import type { StepSnapshot, WorkflowStore } from "./store";

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
 * Decides what happens next for a workflow. It respects One-Step Planning
 * (ADR-002): while a step is active, or once the workflow is terminal, it does
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
    const capabilities = this.deps.capabilitiesOf?.(workflow.sessionId) ?? [];

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
      const dispatched = await this.deps.engine.dispatchStep(workflowId, {
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
      return { dispatched };
    }

    // Reconciliation (WORKFLOW_SPEC.md §4.3): the planner judged an UNKNOWN
    // side-effect step from the evidence gathered afterwards. It is not a new
    // step, so One-Step Planning does not apply; the engine applies the verdict.
    if (decision.kind === "reconcile") {
      await this.deps.engine.reconcileUnknown(
        workflowId,
        decision.stepId,
        decision.outcome,
        decision.evidenceRefs ?? [],
      );
      return {};
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
