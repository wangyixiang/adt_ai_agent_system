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
  guardrailThreshold,
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

/**
 * A side effect was proposed while an earlier one is unresolved
 * (WORKFLOW_SPEC.md §4.3: while a workflow has an unreconciled UNKNOWN, no
 * further side-effect step may be dispatched — read-only and reconciliation
 * steps are still allowed).
 */
export class WorkflowBlockedError extends Error {
  readonly unknownStepId: string;

  constructor(unknownStepId: string) {
    super(`workflow has an unreconciled UNKNOWN side-effect step: ${unknownStepId}`);
    this.name = "WorkflowBlockedError";
    this.unknownStepId = unknownStepId;
  }
}

export interface NewStep {
  objective: string;
  capability: string;
  sideEffect: boolean;
  interruptible: boolean;
  input?: Record<string, unknown>;
  /** Snapshot of the capability's output schema, for in-flight validation. */
  outputSchema?: Record<string, unknown> | null;
  /** Snapshot of the capability's declared evidence type, same reason. */
  expectedOutput?: string | null;
  idempotencyKey?: string | null;
  /** step_timeout budget from the capability's timeout_hint; 0 = no timeout. */
  timeoutMs?: number;
}

export type StepStatusUpdate =
  | { state: "RUNNING"; progress?: unknown }
  | { state: "WAITING"; waitClass: "human" | "execution" }
  | { state: "COMPLETED"; evidence?: unknown }
  | { state: "FAILED"; evidence?: unknown; failReason?: { code: string; message?: string } }
  | { state: "REJECTED"; rejectReason?: { code: string; message?: string } }
  | { state: "UNKNOWN" };

export interface EngineDeps {
  store: WorkflowStore;
  guardrails?: GuardrailConfig;
  /**
   * Ordering clock for events and workflow timestamps. Monotonic and
   * process-local (PROTOCOL_SPEC.md §2) — it is NOT compared across restarts.
   */
  now?: () => number;
  /**
   * Wall clock for step deadlines. `updatedAt` is persisted and read back by a
   * possibly-newer process, so it must be comparable across a restart
   * (a persisted `performance.now()` is meaningless to the next process).
   */
  wallClock?: () => number;
  onTerminated?: (workflow: WorkflowSnapshot) => Promise<void> | void;
}

const newWorkflowId = () => `wf_${randomUUID()}`;
const newStepId = () => `step_${randomUUID()}`;
const newEventId = () => `ev_${randomUUID()}`;

export class WorkflowEngine {
  private readonly store: WorkflowStore;
  private readonly guardrails: GuardrailConfig;
  private readonly now: () => number;
  private readonly wallClock: () => number;
  private readonly onTerminated?: EngineDeps["onTerminated"];
  /** Per-workflow serialization: all mutations of one workflow run in order. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(deps: EngineDeps) {
    this.store = deps.store;
    this.guardrails = deps.guardrails ?? DEFAULT_GUARDRAILS;
    // Monotonic and integer-valued (the DB stores bigint milliseconds).
    this.now = deps.now ?? (() => Math.floor(performance.now()));
    this.wallClock = deps.wallClock ?? (() => Date.now());
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

  /** The configured limit travels with the breach, so the Record can state it. */
  private guardrailPayload(reason: GuardrailReason): { reason: GuardrailReason; threshold: number | null } {
    return { reason, threshold: guardrailThreshold(this.guardrails, reason) };
  }

  /**
   * The state-change body shared by `applyStepStatus` and `timeoutStep`. Callers
   * must already hold the workflow lock (they call it from inside one, and
   * re-entering here would deadlock on the per-workflow chain).
   */
  private async applyStatus(
    workflow: WorkflowSnapshot,
    step: StepSnapshot,
    update: StepStatusUpdate,
  ): Promise<WorkflowSnapshot> {
    const next: StepSnapshot = {
      ...step,
      state: update.state,
      // waitClass describes only the CURRENT wait; clear it on resume.
      waitClass: update.state === "WAITING" ? update.waitClass : null,
      updatedAt: this.wallClock(),
    };
    const evidence =
      update.state === "COMPLETED" || update.state === "FAILED"
        ? update.evidence
        : undefined;
    const failReason = update.state === "FAILED" ? update.failReason : undefined;
    const rejectReason = update.state === "REJECTED" ? update.rejectReason : undefined;
    const stepEvent = this.event(workflow.id, "step_status", {
      stepId: step.id,
      state: next.state,
      // Stored verbatim here; the protocol layer validates `result` against
      // the Capability output schema and records `invalid_output` upstream.
      ...(evidence === undefined ? {} : { evidence }),
      ...(failReason === undefined ? {} : { failReason }),
      ...(rejectReason === undefined ? {} : { rejectReason }),
      ...(update.state === "RUNNING" && update.progress !== undefined
        ? { progress: update.progress }
        : {}),
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
    return (await this.store.getWorkflow(workflow.id))!;
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
    request: unknown,
    criteria: CompletionCriteria,
  ): Promise<WorkflowSnapshot> {
    const workflow: WorkflowSnapshot = {
      id: newWorkflowId(),
      userId,
      sessionId,
      userRequest: request,
      state: "CREATED",
      terminalReason: null,
      criteria,
      createdAt: this.now(),
      endedAt: null,
      notSolvedRounds: 0,
    };
    await this.store.createWorkflow(
      workflow,
      this.event(workflow.id, "workflow_created", { request, criteria }),
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

      // WORKFLOW_SPEC.md §4.3: while a side effect's outcome is unresolved, no
      // further side effect may be dispatched (read-only and reconciliation
      // steps are still allowed). The device must not receive a second action
      // whose interaction with the first is unknown.
      if (step.sideEffect) {
        const unresolved = existing.find((candidate) => candidate.state === "UNKNOWN");
        if (unresolved) throw new WorkflowBlockedError(unresolved.id);
      }

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
          this.event(workflowId, "guardrail_triggered", this.guardrailPayload(breach)),
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
        // Side effects get a key that is stable for the life of the step, so a
        // resume re-dispatch of the same step is not executed twice on the
        // client (WORKFLOW_SPEC.md §4.3).
        idempotencyKey:
          step.sideEffect || step.idempotencyKey
            ? (step.idempotencyKey ?? `idem_${randomUUID()}`)
            : null,
        attempt: 1,
        waitClass: null,
        input: step.input ?? {},
        outputSchema: step.outputSchema ?? null,
        expectedOutput: step.expectedOutput ?? null,
        updatedAt: this.wallClock(),
        timeoutMs: step.timeoutMs ?? 0,
      };
      await this.store.createStep(
        snapshot,
        this.event(workflowId, "step_dispatched", {
          stepId: snapshot.id,
          capability: snapshot.capability,
          input: snapshot.input,
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

      // A repeated status on an executing step is a keep-alive:
      // PROTOCOL_SPEC.md §9 resets the deadline on ANY step.status, and the
      // state does not change, so there is no transition to apply. (A human
      // wait never reaches here — the client only reports it once, and it is
      // exempt from the deadline anyway.)
      const keepAlive =
        (update.state === "RUNNING" && step.state === "RUNNING") ||
        (update.state === "WAITING" &&
          step.state === "WAITING" &&
          update.waitClass === step.waitClass);
      if (keepAlive) {
        await this.store.saveStep(
          { ...step, updatedAt: this.wallClock() },
          this.event(workflowId, "step_status", {
            stepId,
            state: step.state,
            ...(step.state === "WAITING" ? { waitClass: step.waitClass } : {}),
            ...(update.state === "RUNNING" && update.progress !== undefined
              ? { progress: update.progress }
              : {}),
          }),
        );
        return workflow;
      }

      // Ignore illegal and duplicate transitions: no state change, no event.
      if (!canTransitionStep(step.state, update.state)) return workflow;

      return this.applyStatus(workflow, step, update);
    });
  }

  /**
   * step_timeout (PROTOCOL_SPEC.md §9). A read-only step that never reports back
   * fails; a side-effect step may already have taken effect, so it becomes
   * UNKNOWN and is reconciled later. A human wait is unbounded by design.
   */
  async timeoutStep(workflowId: string, stepId: string): Promise<WorkflowSnapshot> {
    return this.withWorkflowLock(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      if (isTerminalWorkflow(workflow.state)) return workflow;

      const step = await this.store.getStep(stepId);
      if (!step || step.workflowId !== workflowId) {
        throw new Error(`unknown step ${stepId}`);
      }

      // Only a step that is executing can time out: PENDING means the client
      // has not acknowledged yet, and a human wait has no deadline.
      const executing =
        step.state === "RUNNING" ||
        (step.state === "WAITING" && step.waitClass !== "human");
      if (!executing) return workflow;

      const update: StepStatusUpdate = step.sideEffect
        ? { state: "UNKNOWN" }
        : { state: "FAILED", failReason: { code: "timeout" } };
      if (!canTransitionStep(step.state, update.state)) return workflow;

      return this.applyStatus(workflow, step, update);
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
    evidenceRefs: string[] = [],
  ): Promise<WorkflowSnapshot> {
    return this.withWorkflowLock(workflowId, async () => {
      const workflow = await this.requireWorkflow(workflowId);
      if (isTerminalWorkflow(workflow.state)) throw new WorkflowTerminalError(workflow.state);

      const step = await this.store.getStep(stepId);
      if (!step || step.workflowId !== workflowId) {
        throw new Error(`unknown step ${stepId}`);
      }
      if (step.state !== "UNKNOWN") throw new Error("step is not UNKNOWN");
      // A verdict without evidence is a guess (WORKFLOW_SPEC.md §4.3: "证据不足
      // 时退回工程师确认"), and the Record would claim a fact it cannot cite.
      if (evidenceRefs.length === 0) {
        throw new Error("reconciliation requires at least one evidence reference");
      }

      await this.store.saveStep(
        { ...step, state: outcome, updatedAt: this.wallClock() },
        this.event(workflowId, "step_status", {
          stepId,
          state: outcome,
          reconciled: true,
          evidenceRefs,
        }),
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

  /**
   * Deterministic failure for a workflow the Server cannot continue (planner
   * unavailable, invalid planner output). A queued cancel still wins — a
   * CANCELLING workflow converges to CANCELLED (WORKFLOW_SPEC.md §2.1).
   */
  async fail(workflowId: string, reason: string): Promise<WorkflowSnapshot> {
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
      return this.terminate(workflow, "FAILED", reason);
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
      // The breach terminates the workflow, so it belongs in the Record just
      // like a dispatch-time breach does.
      if (breach) {
        return this.terminate(updated, "FAILED", breach, [
          response,
          this.event(workflowId, "guardrail_triggered", this.guardrailPayload(breach)),
        ]);
      }

      await this.store.saveWorkflowWithEvents(updated, [response]);
      return updated;
    });
  }
}
