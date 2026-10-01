import type { Answer, Ask, StepState, TerminalState } from "@adt/shared";
import type { ClientDaemon, StepStatusUpdate } from "@adt/client-daemon";

import type { UiEventInput, UiSnapshot, UiStep, UiWorkflow } from "../../shared/contract";

/**
 * The daemon's own view of its workflows, projected for the renderer. The daemon
 * does not model "chat messages", so the renderer's transcript is derived — and
 * this projection is what `snapshot()` hands over so a reloading window (or a
 * second one) can rebuild it.
 */
export interface Projection {
  noteRequest(workflowId: string, text: string): void;
  observe(
    type: string,
    env: { workflow_id: string | null; payload: unknown },
  ): UiEventInput | null;
  observeStepStatus(update: StepStatusUpdate): UiEventInput;
  observeAsk(ask: Ask, workflowId: string): UiEventInput;
  /** The Server accepted a cancellation; mark the run as still converging. */
  observeCancelAck(workflowId: string, status: string): void;
  noteAnswered(askId: string, answer: Answer): UiEventInput | null;
  snapshot(daemon: ClientDaemon | null): UiSnapshot;
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
    noteRequest(workflowId, text) {
      ensure(workflowId).userRequest = { text };
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
        if (update.evidenceSummary !== undefined) step.evidenceSummary = update.evidenceSummary;
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

    snapshot(daemon) {
      return {
        connection: daemon === null ? "disconnected" : "connected",
        userId: daemon === null ? null : daemon.connection.userId,
        capabilities: daemon === null ? [] : daemon.registry.descriptors().map((spec) => spec.name),
        workflows: [...workflows.values()],
      };
    },
  };
}
