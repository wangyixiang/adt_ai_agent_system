import type { WorkflowEngine } from "./engine";
import type { Planner } from "./planner";
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
}

/**
 * Decides what happens next for a workflow. It respects One-Step Planning
 * (ADR-002): while a step is active, or once the workflow is terminal, it
 * does nothing and never consults the planner.
 */
export class WorkflowOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async advance(workflowId: string): Promise<AdvanceResult> {
    const workflow = await this.deps.engine.get(workflowId);
    if (!workflow || isTerminalWorkflow(workflow.state)) return {};

    const steps = await this.deps.store.listSteps(workflowId);
    if (steps.some((step) => isActiveStep(step.state))) return {};

    const events = await this.deps.store.listEvents(workflowId);
    const decision = await this.deps.planner.proposeNext({ workflow, steps, events });

    if (decision.kind === "step") {
      const dispatched = await this.deps.engine.dispatchStep(workflowId, decision.step);
      return { dispatched };
    }

    // A completion candidate is a proposal; the protocol layer sends it and
    // records the event. State is untouched here.
    return {
      completionCandidate: {
        summary: decision.summary,
        evidenceRefs: decision.evidenceRefs,
      },
    };
  }
}
