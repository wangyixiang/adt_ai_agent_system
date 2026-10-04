import type { Answer, Ask, StepState, TerminalState } from "@adt/shared";
import type { ResumedStep, StepStatusUpdate } from "@adt/client-daemon";

import type { UiAttachment, UiEventInput, UiStep, UiWorkflow } from "../../shared/contract";

/**
 * The daemon's own view of its workflows, projected for the renderer. The daemon
 * does not model "chat messages", so the renderer's transcript is derived — and
 * this projection is what `snapshot()` hands over so a reloading window (or a
 * second one) can rebuild it.
 */
export interface Projection {
  noteRequest(workflowId: string, text: string, attachments: UiAttachment[]): void;
  observe(
    type: string,
    env: { workflow_id: string | null; payload: unknown },
  ): UiEventInput | null;
  observeStepStatus(update: StepStatusUpdate): UiEventInput;
  observeAsk(ask: Ask, workflowId: string): UiEventInput;
  /** The Server accepted a cancellation; mark the run as still converging. */
  observeCancelAck(workflowId: string, status: string): void;
  noteAnswered(askId: string, answer: Answer): UiEventInput | null;
  /** Seed a step the Server re-dispatched on resume, with its full dispatch. */
  noteResumed(step: ResumedStep): UiEventInput;
  /** Mark a workflow the Server reports as terminal on resume. */
  noteTerminal(workflowId: string, terminalState: TerminalState, recordId: string | null): void;
  workflows(): UiWorkflow[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

export function createProjection(): Projection {
  const workflows = new Map<string, UiWorkflow>();

  const ensure = (workflowId: string): UiWorkflow => {
    let workflow = workflows.get(workflowId);
    if (workflow === undefined) {
      workflow = {
        workflowId,
        userRequest: { text: "" },
        attachments: [],
        terminalState: null,
        terminalReason: null,
        recordId: null,
        cancelling: false,
        pendingAskId: null,
        pendingAsk: null,
        steps: [],
      };
      workflows.set(workflowId, workflow);
    }
    return workflow;
  };

  const stepOf = (workflow: UiWorkflow, stepId: string): UiStep | undefined =>
    workflow.steps.find((step) => step.stepId === stepId);

  return {
    noteRequest(workflowId, text, attachments) {
      const workflow = ensure(workflowId);
      workflow.userRequest = { text };
      workflow.attachments = attachments;
    },

    observe(type, env) {
      const workflowId = env.workflow_id ?? "";
      const payload = asRecord(env.payload);

      switch (type) {
        case "step.dispatch": {
          const stepId = String(payload["step_id"] ?? "");
          const workflow = ensure(workflowId);
          const step: UiStep = {
            stepId,
            capability: String(payload["capability"] ?? ""),
            objective: typeof payload["objective"] === "string" ? payload["objective"] : "",
            input: asRecord(payload["input"]),
            state: "PENDING",
            requiresConfirmation: payload["requires_confirmation"] === true,
            evidenceSummary: null,
            evidenceBlob: null,
          };
          workflow.steps = [...workflow.steps.filter((s) => s.stepId !== stepId), step];
          return {
            type: "step.dispatched",
            workflowId,
            stepId,
            capability: step.capability,
            objective: step.objective,
            input: step.input,
            requiresConfirmation: step.requiresConfirmation,
          };
        }

        case "workflow.terminated": {
          const workflow = ensure(workflowId);
          const state = payload["terminal_state"];
          const known = state === "COMPLETED" || state === "FAILED" || state === "CANCELLED";
          workflow.terminalState = known ? state : null;
          workflow.terminalReason =
            typeof payload["terminal_reason"] === "string" ? payload["terminal_reason"] : null;
          workflow.recordId =
            typeof payload["record_id"] === "string" ? payload["record_id"] : null;
          workflow.cancelling = false;
          workflow.pendingAskId = null;
          workflow.pendingAsk = null;

          return known
            ? {
                type: "workflow.terminated",
                workflowId,
                terminalState: state,
                terminalReason: workflow.terminalReason,
                recordId: workflow.recordId,
              }
            : {
                type: "notice",
                level: "warn",
                message: `unknown terminal_state: ${String(state)} (workflow ${workflowId})`,
              };
        }

        case "protocol.error": {
          return {
            type: "notice",
            level: "warn",
            message: `${String(payload["code"] ?? "error")}: ${String(payload["message"] ?? "")}`,
          };
        }

        default:
          return null;
      }
    },

    observeStepStatus(update) {
      const workflow = ensure(update.workflowId);
      const step = stepOf(workflow, update.stepId);
      if (step !== undefined) {
        step.state = update.state;
        step.resuming = false;
        if (update.evidenceSummary !== undefined) step.evidenceSummary = update.evidenceSummary;
        if (update.evidenceRef !== undefined) step.evidenceBlob = update.evidenceRef;
      }
      // A step that moved on is no longer waiting for anyone.
      if (update.state !== "WAITING") {
        workflow.pendingAskId = null;
        workflow.pendingAsk = null;
      }

      return {
        type: "step.status",
        workflowId: update.workflowId,
        stepId: update.stepId,
        state: update.state,
        ...(update.evidenceSummary === undefined ? {} : { evidenceSummary: update.evidenceSummary }),
        ...(update.evidenceRef === undefined ? {} : { evidenceBlob: update.evidenceRef }),
        ...(update.failReason === undefined ? {} : { failReason: update.failReason }),
      };
    },

    observeAsk(ask, workflowId) {
      const workflow = ensure(workflowId);
      workflow.pendingAskId = ask.askId;
      workflow.pendingAsk = ask;
      return { type: "ask", workflowId, ask };
    },

    observeCancelAck(workflowId, status) {
      const workflow = ensure(workflowId);
      // A late ack must not resurrect a run that already terminated, and a run
      // the Server already reported CANCELLED is not "still converging".
      if (workflow.terminalState === null) workflow.cancelling = status === "CANCELLING";
    },

    noteAnswered(askId, answer) {
      for (const workflow of workflows.values()) {
        if (workflow.pendingAskId === askId) {
          workflow.pendingAskId = null;
          workflow.pendingAsk = null;
          return { type: "ask.answered", workflowId: workflow.workflowId, askId, answer };
        }
      }
      return null;
    },

    noteResumed(step) {
      const workflow = ensure(step.workflowId);
      const existing = stepOf(workflow, step.stepId);
      const seeded: UiStep =
        existing ?? {
          stepId: step.stepId,
          capability: step.capability,
          objective: step.objective,
          input: step.input,
          state: "PENDING",
          requiresConfirmation: false,
          evidenceSummary: null,
          evidenceBlob: null,
        };
      if (step.capability !== "") seeded.capability = step.capability;
      if (step.objective !== "") seeded.objective = step.objective;
      seeded.input = step.input;
      seeded.resuming = true;
      if (existing === undefined) workflow.steps = [...workflow.steps, seeded];

      return {
        type: "step.dispatched",
        workflowId: step.workflowId,
        stepId: step.stepId,
        capability: seeded.capability,
        objective: seeded.objective,
        input: seeded.input,
        requiresConfirmation: seeded.requiresConfirmation,
        resuming: true,
      };
    },

    workflows() {
      return [...workflows.values()];
    },

    noteTerminal(workflowId, terminalState, recordId) {
      const workflow = ensure(workflowId);
      // Never downgrade a workflow that already reached a terminal state; the
      // Server is authoritative but a later reconciliation must not contradict
      // a `workflow.terminated` the client already saw.
      if (workflow.terminalState !== null) return;
      workflow.terminalState = terminalState;
      workflow.recordId = recordId;
      workflow.cancelling = false;
      workflow.pendingAskId = null;
      workflow.pendingAsk = null;
    },
  };
}
