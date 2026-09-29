import { randomUUID } from "node:crypto";
import {
  canTransitionStep,
  isActiveStep,
  isTerminalStep,
  isTerminalWorkflow,
} from "./stateMachine";
import { convergesCancelling, decideCancel } from "./cancel";
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
import type { ActiveStepState, TerminalWorkflowState } from "./types";

/** A guardrail limit was reached; the workflow is now FAILED. */
export class GuardrailError extends Error {
  readonly reason: GuardrailReason;

  constructor(reason: GuardrailReason, message?: string) {
    super(message ?? `guardrail breach: ${reason}`);
    this.name = "GuardrailError";
    this.reason = reason;
  }
}

/** The workflow is already in a terminal state; it accepts no new steps. */
export class WorkflowTerminalError extends Error {
  readonly state: TerminalWorkflowState;

  constructor(state: TerminalWorkflowState) {
    super(`workflow is already terminal: ${state}`);
    this.name = "WorkflowTerminalError";
    this.state = state;
  }
}

/** A step is still active; One-Step Planning allows only one at a time (ADR-002). */
export class WorkflowBusyError extends Error {
  readonly activeStepId: string;

  constructor(activeStepId: string) {
    super(`workflow already has an active step: ${activeStepId}`);
    this.name = "WorkflowBusyError";
    this.activeStepId = activeStepId;
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
  | { state: "COMPLETED"; evidence?: unknown }
  | { state: "FAILED"; evidence?: unknown }
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
  /** Per-workflow serialization: all mutations of one workflow run in order. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.guardrails = deps.guardrails ?? DEFAULT_GUARDRAILS;
    this.now = deps.now ?? (() => performance.now());
    this.onTerminated = deps.onTerminated;
  }

  /**
   * Runs `fn` after any in-flight operation for the same workflow. This is
   * what makes the guardrail check and the state machine race-free without a
   * database lock (ADR-001: the engine is the deterministic authority).
   */
  private withWorkflowLock<T>(workflowId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(workflowId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const guard = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(workflowId, guard);
    void guard.then(() => {
      if (this.locks.get(workflowId) === guard) this.locks.delete(workflowId);
    });
    return run;
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
    extraEvents: WorkflowEvent[] = [],
    step?: StepSnapshot,
  ): Promise<WorkflowSnapshot> {
    const ended: WorkflowSnapshot = {
      ...workflow,
      state,
      terminalReason: reason,
      endedAt: this.now(),
    };
    const events = [
      ...extraEvents,
      this.event(workflow.id, "workflow_terminated", { state, reason }),
    ];

    // Step + workflow + all events land in one transaction when a step is
    // involved, so a crash can never strand the workflow in CANCELLING.
    if (step) {
      await this.store.saveStepAndWorkflow(step, ended, events);
    } else {
      await this.store.saveWorkflowWithEvents(ended, events);
    }

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
    return this.withWorkflowLock(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      const updated: WorkflowSnapshot = {
        ...workflow,
        criteria: reviseCriteria(workflow.criteria, next),
      };
      await this.store.saveWorkflowWithEvents(updated, [
        this.event(workflowId, "criteria_revised", { criteria: updated.criteria }),
      ]);
      return updated;
    });
  }

  async dispatchStep(workflowId: string, step: NewStep): Promise<StepSnapshot> {
    return this.withWorkflowLock(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      if (isTerminalWorkflow(workflow.state)) {
        throw new WorkflowTerminalError(workflow.state);
      }

      const existing = await this.store.listSteps(workflowId);
      const active = existing.find((candidate) => isActiveStep(candidate.state));
      if (active) throw new WorkflowBusyError(active.id);

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
        await this.terminate(workflow, "FAILED", breach, [
          this.event(workflowId, "guardrail_triggered", { reason: breach }),
        ]);
        throw new GuardrailError(breach);
      }

      if (workflow.state === "CREATED") {
        const running: WorkflowSnapshot = { ...workflow, state: "RUNNING" };
        await this.store.saveWorkflowWithEvents(running, [
          this.event(workflowId, "step_dispatched", { starting: true }),
        ]);
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
        this.event(workflowId, "step_dispatched", {
          stepId: snapshot.id,
          capability: snapshot.capability,
        }),
      );
      return snapshot;
    });
  }

  async applyStepStatus(
    workflowId: string,
    stepId: string,
    update: StepStatusUpdate,
  ): Promise<WorkflowSnapshot> {
    return this.withWorkflowLock(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      const step = await this.store.getStep(stepId);
      if (!step || step.workflowId !== workflowId) {
        throw new Error(`unknown step ${stepId}`);
      }

      // Terminal steps are immutable; UNKNOWN is reconciled separately.
      if (isTerminalStep(step.state)) return workflow;
      // Ignore illegal and duplicate transitions: no state change, no event.
      if (!canTransitionStep(step.state, update.state)) return workflow;

      const next: StepSnapshot = {
        ...step,
        state: update.state,
        // waitClass describes only the CURRENT wait; clear it on resume.
        waitClass: update.state === "WAITING" ? update.waitClass : null,
      };
      const evidence =
        update.state === "COMPLETED" || update.state === "FAILED"
          ? update.evidence
          : undefined;
      const stepEvent = this.event(workflowId, "step_status", {
        stepId,
        state: next.state,
        // Evidence is stored verbatim; Capability schema validation is P3/P4.
        ...(evidence === undefined ? {} : { evidence }),
      });

      // A queued cancel converges the moment its non-interruptible step ends —
      // on ANY terminal outcome, including UNKNOWN (WORKFLOW_SPEC.md §2.1).
      if (workflow.state === "CANCELLING" && convergesCancelling(next.state)) {
        return this.terminate(
          workflow,
          "CANCELLED",
          workflow.terminalReason,
          [stepEvent],
          next,
        );
      }

      await this.store.saveStep(next, stepEvent);
      return (await this.store.getWorkflow(workflowId))!;
    });
  }

  async cancel(workflowId: string, reason = "user_cancelled"): Promise<WorkflowSnapshot> {
    return this.withWorkflowLock(workflowId, async () => {
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

      const requested = this.event(workflowId, "cancel_requested", { reason });

      if (decision === "IMMEDIATE") {
        return this.terminate(workflow, "CANCELLED", reason, [requested]);
      }

      const queued: WorkflowSnapshot = {
        ...workflow,
        state: "CANCELLING",
        // Remembered so convergence keeps the engineer's original intent.
        terminalReason: reason,
      };
      await this.store.saveWorkflowWithEvents(queued, [requested]);
      return queued;
    });
  }

  async reconcileUnknown(
    workflowId: string,
    stepId: string,
    outcome: "COMPLETED" | "FAILED",
  ): Promise<WorkflowSnapshot> {
    return this.withWorkflowLock(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      if (isTerminalWorkflow(workflow.state)) throw new WorkflowTerminalError(workflow.state);

      const step = await this.store.getStep(stepId);
      if (!step || step.workflowId !== workflowId) {
        throw new Error(`unknown step ${stepId}`);
      }
      if (step.state !== "UNKNOWN") throw new Error("step is not UNKNOWN");

      await this.store.saveStep(
        { ...step, state: outcome },
        this.event(workflowId, "step_status", { stepId, state: outcome, reconciled: true }),
      );
      return (await this.store.getWorkflow(workflowId))!;
    });
  }

  /**
   * Orphan reclamation (WORKFLOW_SPEC.md §2.2): the engineer's cancel intent
   * wins; otherwise the workflow fails as client-unreachable.
   */
  async reclaimOrphan(workflowId: string): Promise<WorkflowSnapshot> {
    return this.withWorkflowLock(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      if (isTerminalWorkflow(workflow.state)) return workflow;

      if (workflow.state === "CANCELLING") {
        return this.terminate(
          workflow,
          "CANCELLED",
          workflow.terminalReason ?? "user_cancelled",
        );
      }
      return this.terminate(workflow, "FAILED", "client_unreachable");
    });
  }

  async confirmCompletion(
    workflowId: string,
    resolution: "solved" | "not_solved",
    feedback?: string,
  ): Promise<WorkflowSnapshot> {
    return this.withWorkflowLock(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      if (isTerminalWorkflow(workflow.state)) return workflow;

      const response = this.event(workflowId, "completion_response", {
        resolution,
        feedback,
      });

      if (resolution === "solved") {
        return this.terminate(workflow, "COMPLETED", null, [response]);
      }

      const rounds = workflow.notSolvedRounds + 1;
      const updated: WorkflowSnapshot = {
        ...workflow,
        // "not solved" means keep diagnosing (WORKFLOW_SPEC.md §9).
        state: "RUNNING",
        notSolvedRounds: rounds,
      };

      const breach = breachedGuardrail(
        { stepCount: 0, consecutiveRetries: 0, notSolvedRounds: rounds, elapsedMs: 0 },
        this.guardrails,
      );
      if (breach) return this.terminate(updated, "FAILED", breach, [response]);

      await this.store.saveWorkflowWithEvents(updated, [response]);
      return updated;
    });
  }
}
