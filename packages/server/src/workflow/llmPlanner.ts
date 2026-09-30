import type { NormalizedCapability } from "@adt/shared";
import type { LlmProvider, LlmTool } from "../llm/provider";
import type { CompletionCriteria } from "./criteria";
import type { NewStep } from "./engine";
import type { Planner, PlannerDecision, PlannerInput } from "./planner";
import type { WorkflowEvent } from "./store";

const SET_CRITERIA_TOOL = "set_completion_criteria";
const PROPOSE_STEP_TOOL = "propose_step";

const SYSTEM_PROMPT = [
  "You are the planning step of a hardware-in-the-loop diagnosis assistant.",
  "You must call exactly one tool and nothing else.",
  "",
  "Rules:",
  "- Plan ONE step at a time (One-Step Planning). Never describe a multi-step plan.",
  "- Prefer read-only capabilities. Only propose a side-effecting capability when it is genuinely needed.",
  "- The step's `capability` MUST be one of the available capabilities.",
  "- `step.input` must satisfy that capability's input schema.",
  "- Propose a completion candidate only when the evidence already justifies it; the engineer still confirms.",
  "- A side-effecting step can end UNKNOWN: it may or may not have taken effect.",
  "  Gather objective evidence with read-only steps first, then settle it with",
  "  action=reconcile (outcome COMPLETED or FAILED). Reconcile only a step listed",
  "  as UNKNOWN, and never without evidence for the verdict.",
].join("\n");

/** The `completion_criteria` shape the planner must produce (WORKFLOW_SPEC.md §8.1). */
function criteriaTool(): LlmTool {
  return {
    name: SET_CRITERIA_TOOL,
    description: "Record what 'solved' means for this request.",
    parameters: {
      type: "object",
      required: ["mode", "description"],
      properties: {
        mode: { type: "string", enum: ["formal", "open"] },
        description: { type: "string" },
        assertions: { type: "array", items: { type: "string" } },
      },
    },
  };
}

/** One tool carrying both the step and the completion-candidate shapes. */
function proposeStepTool(capabilities: NormalizedCapability[]): LlmTool {
  return {
    name: PROPOSE_STEP_TOOL,
    description: "Propose the single next step, or a completion candidate.",
    parameters: {
      type: "object",
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["step", "completion_candidate", "reconcile"] },
        step: {
          type: "object",
          required: ["objective", "capability", "input"],
          properties: {
            objective: { type: "string" },
            capability: { type: "string", enum: capabilities.map((c) => c.name) },
            input: { type: "object" },
          },
        },
        completion: {
          type: "object",
          required: ["summary", "evidence_refs"],
          properties: {
            summary: { type: "string" },
            evidence_refs: { type: "array", items: { type: "string" } },
          },
        },
        reconcile: {
          type: "object",
          required: ["step_id", "outcome"],
          properties: {
            step_id: { type: "string" },
            outcome: { type: "string", enum: ["COMPLETED", "FAILED"] },
            evidence_refs: { type: "array", items: { type: "string" } },
          },
        },
        criteria: {
          type: "object",
          properties: {
            mode: { type: "string", enum: ["formal", "open"] },
            description: { type: "string" },
            assertions: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };
}

function renderCapabilities(capabilities: NormalizedCapability[]): string {
  if (capabilities.length === 0) return "(none declared)";
  return capabilities
    .map(
      (cap) =>
        `- ${cap.name} (side_effect=${cap.side_effect}) input_schema=${JSON.stringify(cap.input_schema ?? {})}`,
    )
    .join("\n");
}

function renderCriteria(criteria: CompletionCriteria): string {
  const assertions = criteria.assertions?.length ? ` assertions=${JSON.stringify(criteria.assertions)}` : "";
  return `${criteria.mode}: ${criteria.description ?? "(no description)"}${assertions}`;
}

function renderEvidence(events: WorkflowEvent[]): string {
  const evidence = events
    .filter((event) => event.kind === "step_status")
    .map((event) => (event.payload as { evidence?: unknown }).evidence)
    .filter((item) => item !== undefined && item !== null);
  return evidence.length ? evidence.map((item) => JSON.stringify(item)).join("\n") : "(none)";
}

function renderPlanningContext(input: PlannerInput): string {
  const { workflow, steps, events, capabilities } = input;
  const unknown = steps.filter((step) => step.state === "UNKNOWN");
  const requestText =
    typeof (workflow.userRequest as { text?: unknown } | null)?.text === "string"
      ? (workflow.userRequest as { text: string }).text
      : JSON.stringify(workflow.userRequest ?? null);

  return [
    "Decide exactly one next step. Call propose_step.",
    "",
    `User request: ${requestText}`,
    `Completion criteria: ${renderCriteria(workflow.criteria)}`,
    `Workflow state: ${workflow.state}`,
    "",
    "Available capabilities:",
    renderCapabilities(capabilities),
    "",
    "Steps so far:",
    steps.length
      ? steps.map((step) => `- ${step.id} [${step.state}] ${step.capability}: ${step.objective}`).join("\n")
      : "(none)",
    "",
    "Steps whose outcome is UNKNOWN and may be reconciled:",
    unknown.length
      ? unknown.map((step) => `- ${step.id} (${step.capability})`).join("\n")
      : "(none)",
    "",
    "Evidence so far:",
    renderEvidence(events),
  ].join("\n");
}

function parseCriteriaFields(args: Record<string, unknown>): Omit<CompletionCriteria, "revision"> {
  const assertions = Array.isArray(args.assertions)
    ? args.assertions.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    mode: args.mode === "formal" ? "formal" : "open",
    description: typeof args.description === "string" ? args.description : undefined,
    assertions,
  };
}

function parseCriteria(args: Record<string, unknown>): CompletionCriteria {
  return { ...parseCriteriaFields(args), revision: 0 };
}

function parseDecision(
  args: Record<string, unknown>,
  capabilities: NormalizedCapability[],
): PlannerDecision {
  const criteria =
    typeof args.criteria === "object" && args.criteria !== null
      ? parseCriteriaFields(args.criteria as Record<string, unknown>)
      : undefined;
  const withCriteria = criteria ? { criteria } : {};

  if (args.action === "completion_candidate") {
    const completion = (args.completion ?? {}) as { summary?: unknown; evidence_refs?: unknown };
    return {
      kind: "completion_candidate",
      summary: typeof completion.summary === "string" ? completion.summary : "",
      evidenceRefs: Array.isArray(completion.evidence_refs)
        ? completion.evidence_refs.filter((item): item is string => typeof item === "string")
        : [],
      ...withCriteria,
    };
  }

  if (args.action === "reconcile") {
    const raw = (args.reconcile ?? {}) as {
      step_id?: unknown;
      outcome?: unknown;
      evidence_refs?: unknown;
    };
    if (
      typeof raw.step_id !== "string" ||
      (raw.outcome !== "COMPLETED" && raw.outcome !== "FAILED")
    ) {
      throw new Error("planner reconcile is missing step_id/outcome");
    }
    return {
      kind: "reconcile",
      stepId: raw.step_id,
      outcome: raw.outcome,
      evidenceRefs: Array.isArray(raw.evidence_refs)
        ? raw.evidence_refs.filter((item): item is string => typeof item === "string")
        : [],
    };
  }

  if (args.action !== "step") {
    throw new Error(`planner produced an unknown action: ${String(args.action)}`);
  }

  const raw = (args.step ?? {}) as { objective?: unknown; capability?: unknown; input?: unknown };
  if (typeof raw.objective !== "string" || typeof raw.capability !== "string") {
    throw new Error("planner step is missing objective/capability");
  }

  const capability = capabilities.find((candidate) => candidate.name === raw.capability);
  if (!capability) {
    throw new Error(`planner chose an unknown capability: ${raw.capability}`);
  }

  const step: NewStep = {
    objective: raw.objective,
    capability: raw.capability,
    sideEffect: capability.side_effect,
    interruptible: capability.interruptible,
    input:
      typeof raw.input === "object" && raw.input !== null
        ? (raw.input as Record<string, unknown>)
        : {},
  };
  return { kind: "step", step, ...withCriteria };
}

/**
 * The LLM-backed planner (ADR-004 §2). It turns the current Workflow state into
 * one structured tool call and maps the answer onto the `Planner` seam. Any
 * missing/malformed tool call is an error — the orchestrator then fails the
 * workflow deterministically rather than looping.
 */
export class LlmPlanner implements Planner {
  constructor(private readonly deps: { provider: LlmProvider }) {}

  async initialCriteria(
    request: unknown,
    capabilities: NormalizedCapability[],
  ): Promise<CompletionCriteria> {
    const response = await this.deps.provider.complete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            "Set the completion criteria for this request. Call set_completion_criteria.",
            "",
            `User request: ${JSON.stringify(request)}`,
            "",
            "Available capabilities:",
            renderCapabilities(capabilities),
          ].join("\n"),
        },
      ],
      tools: [criteriaTool()],
      toolChoice: SET_CRITERIA_TOOL,
    });

    const call = response.toolCalls.find((candidate) => candidate.name === SET_CRITERIA_TOOL);
    if (!call) throw new Error("planner produced no usable completion criteria");
    return parseCriteria(call.arguments);
  }

  async proposeNext(input: PlannerInput): Promise<PlannerDecision> {
    const response = await this.deps.provider.complete({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: renderPlanningContext(input) },
      ],
      tools: [proposeStepTool(input.capabilities)],
      toolChoice: PROPOSE_STEP_TOOL,
    });

    const call = response.toolCalls.find((candidate) => candidate.name === PROPOSE_STEP_TOOL);
    if (!call) throw new Error("planner produced no usable decision");
    const decision = parseDecision(call.arguments, input.capabilities);
    // The model may only settle a step that is actually UNKNOWN (WORKFLOW_SPEC.md
    // §4.3); anything else is a bad decision, not a silent state change.
    if (decision.kind === "reconcile") {
      const target = input.steps.find((step) => step.id === decision.stepId);
      if (!target || target.state !== "UNKNOWN") {
        throw new Error(
          `planner tried to reconcile a step that is not UNKNOWN: ${decision.stepId}`,
        );
      }
    }
    return decision;
  }
}
