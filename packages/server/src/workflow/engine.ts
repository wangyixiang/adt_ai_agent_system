import { randomUUID } from "node:crypto";
import { isActiveStep, isTerminalStep, isTerminalWorkflow } from "./stateMachine";
import { decideCancel } from "./cancel";
import type { ActiveStepState } from "./types";
import {
  breachedGuardrail,
  DEFAULT_GUARDRAILS,
  type GuardrailConfig,
  type GuardrailReason,
} from "./guardrails";
import { reviseCriteria, type CompletionCriteria } from "./criteria";
import type {
  StepSnapshot,
  WorkflowEvent,
  WorkflowEventKind,
  WorkflowSnapshot,
  WorkflowStore,
} from "./store";
import type { TerminalWorkflowState } from "./types";

export class GuardrailError extends Error {
  readonly reason: GuardrailReason;

  constructor(reason: GuardrailReason, message?: string) {
    super(message ?? `guardrail breach: ${reason}`);
    this.name = "GuardrailError";
    this.reason = reason;
  }
}

export interface NewStep {
  objective: string;
  capability: string;
  sideEffect: boolean;
  interruptible: boolean;
  idempotencyKey?: string | null;
}

export type StepStatusUpdate =
  | { state: "RUNNING" }
  | { state: "WAITING"; waitClass: "human" | "execution" }
  | { state: "COMPLETED" }
  | { state: "FAILED" }
  | { state: "REJECTED" }
  | { state: "UNKNOWN" };

export interface EngineDeps {
  store: WorkflowStore;
  guardrails?: GuardrailConfig;
  now?: () => number;
  onTerminated?: (workflow: WorkflowSnapshot) => Promise<void> | void;
}

const newWorkflowId = () => `wf_${randomUUID()}`;
const newStepId = () => `step_${randomUUID()}`;
const newEventId = () => `ev_${randomUUID()}`;

export class WorkflowEngine {
  private readonly store: WorkflowStore;
  private readonly guardrails: GuardrailConfig;
  private readonly now: () => number;
  private readonly onTerminated?: EngineDeps["onTerminated"];

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.guardrails = deps.guardrails ?? DEFAULT_GUARDRAILS;
    this.now = deps.now ?? (() => performance.now());
    this.onTerminated = deps.onTerminated;
  }

  private event(workflowId: string, kind: WorkflowEventKind, payload: unknown): WorkflowEvent {
    return { id: newEventId(), workflowId, kind, ts: this.now(), payload };
  }

  private async requireWorkflow(workflowId: string): Promise<WorkflowSnapshot> {
    const workflow = await this.store.getWorkflow(workflowId);
    if (!workflow) throw new Error(`unknown workflow ${workflowId}`);
    return workflow;
  }

  private async terminate(
    workflow: WorkflowSnapshot,
    state: TerminalWorkflowState,
    reason: string | null,
  ): Promise<WorkflowSnapshot> {
    const ended: WorkflowSnapshot = {
      ...workflow,
      state,
      terminalReason: reason,
      endedAt: this.now(),
    };
    await this.store.saveWorkflow(
      ended,
      this.event(workflow.id, "workflow_terminated", { state, reason }),
    );
    await this.onTerminated?.(ended);
    return ended;
  }

  async create(
    userId: string,
    sessionId: string,
    request: { text: string },
    criteria: CompletionCriteria,
  ): Promise<WorkflowSnapshot> {
    const workflow: WorkflowSnapshot = {
      id: newWorkflowId(),
      userId,
      sessionId,
      state: "CREATED",
      terminalReason: null,
      criteria,
      createdAt: this.now(),
      endedAt: null,
      notSolvedRounds: 0,
    };
    await this.store.createWorkflow(
      workflow,
      this.event(workflow.id, "workflow_created", { request }),
    );
    return workflow;
  }

  async get(workflowId: string): Promise<WorkflowSnapshot | null> {
    return this.store.getWorkflow(workflowId);
  }

  async getStep(stepId: string): Promise<StepSnapshot | null> {
    return this.store.getStep(stepId);
  }

  async reviseCriteria(
    workflowId: string,
    next: Omit<CompletionCriteria, "revision">,
  ): Promise<WorkflowSnapshot> {
    const workflow = await this.requireWorkflow(workflowId);
    const updated: WorkflowSnapshot = {
      ...workflow,
      criteria: reviseCriteria(workflow.criteria, next),
    };
    await this.store.saveWorkflow(
      updated,
      this.event(workflowId, "criteria_revised", { criteria: updated.criteria }),
    );
    return updated;
  }

  async dispatchStep(workflowId: string, step: NewStep): Promise<StepSnapshot> {
    const workflow = await this.requireWorkflow(workflowId);
    if (isTerminalWorkflow(workflow.state)) {
      throw new GuardrailError("step_limit", "workflow is already terminal");
    }

    const existing = await this.store.listSteps(workflowId);
    const breach = breachedGuardrail(
      {
        stepCount: existing.length + 1,
        consecutiveRetries: 0,
        notSolvedRounds: workflow.notSolvedRounds,
        elapsedMs: this.now() - workflow.createdAt,
      },
      this.guardrails,
    );

    if (breach) {
      await this.store.saveWorkflow(
        workflow,
        this.event(workflowId, "guardrail_triggered", { reason: breach }),
      );
      await this.terminate(workflow, "FAILED", breach);
      throw new GuardrailError(breach);
    }

    let current = workflow;
    if (workflow.state === "CREATED") {
      current = { ...workflow, state: "RUNNING" };
      await this.store.saveWorkflow(
        current,
        this.event(workflowId, "step_dispatched", { starting: true }),
      );
    }

    const snapshot: StepSnapshot = {
      id: newStepId(),
      workflowId,
      state: "PENDING",
      objective: step.objective,
      capability: step.capability,
      sideEffect: step.sideEffect,
      interruptible: step.interruptible,
      idempotencyKey: step.idempotencyKey ?? null,
      attempt: 1,
      waitClass: null,
    };
    await this.store.createStep(
      snapshot,
      this.event(workflowId, "step_dispatched", { stepId: snapshot.id, capability: snapshot.capability }),
    );
    return snapshot;
  }

  async applyStepStatus(
    workflowId: string,
    stepId: string,
    update: StepStatusUpdate,
  ): Promise<WorkflowSnapshot> {
    const workflow = await this.requireWorkflow(workflowId);
    const step = await this.store.getStep(stepId);
    if (!step || step.workflowId !== workflowId) {
      throw new Error(`unknown step ${stepId}`);
    }

    // Terminal steps are immutable; UNKNOWN is reconciled separately (Task 6).
    if (isTerminalStep(step.state)) return workflow;

    const next: StepSnapshot = {
      ...step,
      state: update.state,
      waitClass: update.state === "WAITING" ? update.waitClass : step.waitClass,
    };
    await this.store.saveStep(
      next,
      this.event(workflowId, "step_status", { stepId, state: next.state }),
    );

    // A queued cancel converges the moment its non-interruptible step ends —
    // on ANY terminal outcome, including UNKNOWN (WORKFLOW_SPEC.md §2.1).
    if (workflow.state === "CANCELLING" && isTerminalStep(next.state)) {
      return this.terminate(workflow, "CANCELLED", workflow.terminalReason);
    }

    return (await this.store.getWorkflow(workflowId))!;
  }

  async cancel(workflowId: string, reason = "user_cancelled"): Promise<WorkflowSnapshot> {
    const workflow = await this.requireWorkflow(workflowId);
    if (isTerminalWorkflow(workflow.state)) return workflow;

    const steps = await this.store.listSteps(workflowId);
    const active = steps.find((step) => isActiveStep(step.state));
    const decision = decideCancel({
      activeStep: active
        ? {
            state: active.state as ActiveStepState,
            interruptible: active.interruptible,
            waitClass: active.waitClass,
          }
        : null,
    });

    await this.store.saveWorkflow(
      workflow,
      this.event(workflowId, "cancel_requested", { reason }),
    );

    if (decision === "IMMEDIATE") return this.terminate(workflow, "CANCELLED", reason);

    const queued: WorkflowSnapshot = {
      ...workflow,
      state: "CANCELLING",
      // Remembered so convergence keeps the engineer's original intent.
      terminalReason: reason,
    };
    await this.store.saveWorkflow(
      queued,
      this.event(workflowId, "cancel_requested", { reason, queued: true }),
    );
    return queued;
  }

  async reconcileUnknown(
    workflowId: string,
    stepId: string,
    outcome: "COMPLETED" | "FAILED",
  ): Promise<WorkflowSnapshot> {
    const workflow = await this.requireWorkflow(workflowId);
    if (isTerminalWorkflow(workflow.state)) throw new Error("workflow is terminal");

    const step = await this.store.getStep(stepId);
    if (!step || step.workflowId !== workflowId) throw new Error(`unknown step ${stepId}`);
    if (step.state !== "UNKNOWN") throw new Error("step is not UNKNOWN");

    await this.store.saveStep(
      { ...step, state: outcome },
      this.event(workflowId, "step_status", { stepId, state: outcome, reconciled: true }),
    );
    return (await this.store.getWorkflow(workflowId))!;
  }

  async confirmCompletion(
    workflowId: string,
    resolution: "solved" | "not_solved",
    feedback?: string,
  ): Promise<WorkflowSnapshot> {
    const workflow = await this.requireWorkflow(workflowId);
    if (isTerminalWorkflow(workflow.state)) return workflow;

    if (resolution === "solved") {
      await this.store.saveWorkflow(
        workflow,
        this.event(workflowId, "completion_response", { resolution, feedback }),
      );
      return this.terminate(workflow, "COMPLETED", null);
    }

    const rounds = workflow.notSolvedRounds + 1;
    const updated: WorkflowSnapshot = {
      ...workflow,
      // "not solved" means keep diagnosing (WORKFLOW_SPEC.md §9).
      state: "RUNNING",
      notSolvedRounds: rounds,
    };
    await this.store.saveWorkflow(
      updated,
      this.event(workflowId, "completion_response", { resolution, feedback }),
    );

    const breach = breachedGuardrail(
      { stepCount: 0, consecutiveRetries: 0, notSolvedRounds: rounds, elapsedMs: 0 },
      this.guardrails,
    );
    if (breach) return this.terminate(updated, "FAILED", breach);
    return updated;
  }
}
