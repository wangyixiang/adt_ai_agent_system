/**
 * The transcript is **derived**, not modelled: main only emits workflow events,
 * and this module turns "snapshot + events" into the list of chat items. It is a
 * **pure function over data** — no React — so the hard cases (out-of-order,
 * duplicate, reconnect) are tested with plain values.
 */
import type { Answer, Ask, AskKind, StepState, TerminalState } from "@adt/shared";

import type { UiEvent, UiSnapshot } from "../../shared/contract";

export type TranscriptItem =
  | { key: string; kind: "user"; workflowId: string; text: string }
  | {
      key: string;
      kind: "assistant";
      workflowId: string;
      stepId: string;
      capability: string;
      text: string;
    }
  | {
      key: string;
      kind: "tool";
      workflowId: string;
      stepId: string;
      capability: string;
      objective: string;
      input: Record<string, unknown>;
      state: StepState;
      requiresConfirmation: boolean;
      evidenceSummary: string | null;
      text: string;
    }
  | {
      key: string;
      kind: "ask";
      workflowId: string;
      askId: string;
      ask: Ask | null;
      askKind: AskKind | null;
      answered: boolean;
      /** The step this decision belongs to; `null` for the completion candidate. */
      stepId: string | null;
      text: string;
    }
  | { key: string; kind: "notice"; level: "info" | "warn"; text: string }
  | {
      key: string;
      kind: "summary";
      workflowId: string;
      terminalState: TerminalState;
      terminalReason: string | null;
      recordId: string | null;
      text: string;
    };

export interface UiState {
  snapshot: UiSnapshot;
  events: UiEvent[];
}

/** The system could not reconcile the step's outcome — not the human's doubt. */
export const STEP_STATE_TEXT: Record<StepState, string> = {
  PENDING: "待执行",
  RUNNING: "执行中",
  WAITING: "等待中",
  COMPLETED: "完成",
  FAILED: "失败",
  REJECTED: "被拒",
  UNKNOWN: "未对账（系统判定结果不确定）",
};

/** `outcome:"unknown"` is the human saying they are not sure. */
export const MANUAL_OUTCOME_TEXT: Record<"succeeded" | "failed" | "partially" | "unknown", string> = {
  succeeded: "人说已成功",
  failed: "人说已失败",
  partially: "人说部分成功",
  unknown: "人说自己不确定",
};

const ASK_KIND_TEXT: Record<AskKind, string> = {
  confirmation: "有一个确认在等你回答",
  manual_action: "有一个手工动作反馈在等你回答",
  resource_conflict: "有一个资源冲突在等你决定",
  completion: "有一个完成候选在等你判断",
};

const NOTICE_RANK = Number.MAX_SAFE_INTEGER;

interface Ordered {
  item: TranscriptItem;
  workflowRank: number;
  userRank: number;
  order: number;
  sub: number;
}

function byOrder(a: Ordered, b: Ordered): number {
  if (a.workflowRank !== b.workflowRank) return a.workflowRank - b.workflowRank;
  if (a.userRank !== b.userRank) return a.userRank - b.userRank;
  if (a.order !== b.order) return a.order - b.order;
  if (a.sub !== b.sub) return a.sub - b.sub;
  return a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0;
}

interface StepPatch {
  capability?: string;
  objective?: string;
  input?: Record<string, unknown>;
  state?: StepState;
  requiresConfirmation?: boolean;
  evidenceSummary?: string | null;
}

function answerText(answer: Answer): string {
  switch (answer.kind) {
    case "confirmation":
      return answer.decision === "confirmed" ? "已确认" : "已拒绝";
    case "manual_action":
      return MANUAL_OUTCOME_TEXT[answer.outcome];
    case "resource_conflict":
      return answer.answer === "wait" ? "选择等待" : "选择停止";
    case "completion":
      return answer.resolution === "solved" ? "认为已解决" : "认为没解决";
  }
}

function summaryText(terminalState: TerminalState, terminalReason: string | null): string {
  const reason = terminalReason === null ? "" : ` · ${terminalReason}`;
  return `工作流已终止：${terminalState}${reason}`;
}

/** Seed from the snapshot, then fold the events in id order (at most once each). */
export function deriveTranscript(snapshot: UiSnapshot, events: UiEvent[]): TranscriptItem[] {
  const ordered = new Map<string, Ordered>();
  const workflowRanks = new Map<string, number>();
  let nextRank = 0;

  const rankOf = (workflowId: string): number => {
    let rank = workflowRanks.get(workflowId);
    if (rank === undefined) {
      rank = nextRank++;
      workflowRanks.set(workflowId, rank);
    }
    return rank;
  };

  const get = (key: string): Ordered | undefined => ordered.get(key);

  const putUser = (workflowId: string, text: string): void => {
    const key = `user:${workflowId}`;
    ordered.set(key, {
      item: { key, kind: "user", workflowId, text },
      workflowRank: rankOf(workflowId),
      userRank: 0,
      order: -1,
      sub: 0,
    });
  };

  const stepOrder = (workflowId: string, stepId: string, fallback: number): number => {
    const existing =
      get(`tool:${workflowId}:${stepId}`) ?? get(`assistant:${workflowId}:${stepId}`);
    return existing?.order ?? fallback;
  };

  const putStep = (
    workflowId: string,
    stepId: string,
    patch: StepPatch,
    order: number,
  ): void => {
    const toolKey = `tool:${workflowId}:${stepId}`;
    const assistantKey = `assistant:${workflowId}:${stepId}`;
    const previousTool = get(toolKey);
    const previous = previousTool?.item.kind === "tool" ? previousTool.item : undefined;
    const resolved = stepOrder(workflowId, stepId, order);
    const rank = rankOf(workflowId);

    const capability = patch.capability ?? previous?.capability ?? "";
    const objective = patch.objective ?? previous?.objective ?? "";
    const input = patch.input ?? previous?.input ?? {};
    const state = patch.state ?? previous?.state ?? "PENDING";
    const requiresConfirmation =
      patch.requiresConfirmation ?? previous?.requiresConfirmation ?? false;
    const evidenceSummary =
      patch.evidenceSummary !== undefined ? patch.evidenceSummary : (previous?.evidenceSummary ?? null);

    ordered.set(assistantKey, {
      item: { key: assistantKey, kind: "assistant", workflowId, stepId, capability, text: objective },
      workflowRank: rank,
      userRank: 1,
      order: resolved,
      sub: 0,
    });
    ordered.set(toolKey, {
      item: {
        key: toolKey,
        kind: "tool",
        workflowId,
        stepId,
        capability,
        objective,
        input,
        state,
        requiresConfirmation,
        evidenceSummary,
        text: STEP_STATE_TEXT[state],
      },
      workflowRank: rank,
      userRank: 1,
      order: resolved,
      sub: 1,
    });
  };

  const putAsk = (
    workflowId: string,
    askId: string,
    patch: { ask?: Ask | null; answered?: boolean; text?: string; stepId?: string | null },
    order: number,
  ): void => {
    const key = `ask:${workflowId}:${askId}`;
    const existing = get(key);
    const previous = existing?.item.kind === "ask" ? existing.item : undefined;
    const ask = patch.ask ?? previous?.ask ?? null;
    const askKind = ask?.kind ?? previous?.askKind ?? null;
    const answered = patch.answered ?? previous?.answered ?? false;
    const fromAsk = ask === null || ask.kind === "completion" ? null : ask.stepId;
    const stepId = patch.stepId ?? previous?.stepId ?? fromAsk;
    const text =
      patch.text ??
      previous?.text ??
      (askKind === null ? "有一个问题在等你回答" : ASK_KIND_TEXT[askKind]);

    ordered.set(key, {
      item: { key, kind: "ask", workflowId, askId, ask, askKind, answered, stepId, text },
      workflowRank: rankOf(workflowId),
      userRank: 1,
      order: existing?.order ?? order,
      sub: 2,
    });
  };

  const putSummary = (
    workflowId: string,
    terminalState: TerminalState,
    terminalReason: string | null,
    recordId: string | null,
    order: number,
  ): void => {
    const key = `summary:${workflowId}`;
    ordered.set(key, {
      item: {
        key,
        kind: "summary",
        workflowId,
        terminalState,
        terminalReason,
        recordId,
        text: summaryText(terminalState, terminalReason),
      },
      workflowRank: rankOf(workflowId),
      userRank: 1,
      order: get(key)?.order ?? order,
      sub: 3,
    });
  };

  const putNotice = (id: number, level: "info" | "warn", text: string): void => {
    const key = `notice:${id}`;
    ordered.set(key, {
      item: { key, kind: "notice", level, text },
      workflowRank: NOTICE_RANK,
      userRank: 1,
      order: id,
      sub: 0,
    });
  };

  for (const workflow of snapshot.workflows) {
    rankOf(workflow.workflowId);
    putUser(workflow.workflowId, workflow.userRequest.text);
    workflow.steps.forEach((step, index) => putStep(workflow.workflowId, step.stepId, step, index));
    if (workflow.pendingAsk !== null) {
      putAsk(workflow.workflowId, workflow.pendingAsk.askId, { ask: workflow.pendingAsk }, workflow.steps.length + 0.5);
    } else if (workflow.pendingAskId !== null) {
      putAsk(workflow.workflowId, workflow.pendingAskId, {}, workflow.steps.length + 0.5);
    }
    if (workflow.terminalState !== null) {
      putSummary(
        workflow.workflowId,
        workflow.terminalState,
        workflow.terminalReason,
        workflow.recordId,
        workflow.steps.length + 1,
      );
    }
  }

  const seen = new Set<number>();
  for (const event of [...events].sort((a, b) => a.id - b.id)) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);

    switch (event.type) {
      case "workflow.created":
        putUser(event.workflowId, event.userRequest.text);
        break;

      case "step.dispatched":
        putStep(
          event.workflowId,
          event.stepId,
          {
            capability: event.capability,
            objective: event.objective,
            input: event.input,
            requiresConfirmation: event.requiresConfirmation,
          },
          event.id,
        );
        break;

      case "step.status":
        putStep(
          event.workflowId,
          event.stepId,
          {
            state: event.state,
            ...(event.evidenceSummary === undefined ? {} : { evidenceSummary: event.evidenceSummary }),
          },
          event.id,
        );
        break;

      case "ask":
        putAsk(event.workflowId, event.ask.askId, { ask: event.ask }, event.id);
        break;

      case "ask.answered":
        putAsk(event.workflowId, event.askId, { answered: true, text: answerText(event.answer) }, event.id);
        break;

      case "workflow.terminated":
        putSummary(
          event.workflowId,
          event.terminalState,
          event.terminalReason,
          event.recordId,
          event.id,
        );
        break;

      case "notice":
        putNotice(event.id, event.level, event.message);
        break;
    }
  }

  return [...ordered.values()].sort(byOrder).map((entry) => entry.item);
}

/** Fold one more event in; an id is applied at most once. */
export function applyEvent(state: UiState, event: UiEvent): UiState {
  if (state.events.some((existing) => existing.id === event.id)) return state;
  return { snapshot: state.snapshot, events: [...state.events, event].sort((a, b) => a.id - b.id) };
}

/**
 * Is any workflow still live? The snapshot is only fetched at connect/login, so
 * a run started since then is known only through its events.
 */
export function hasRunningWorkflow(items: TranscriptItem[]): boolean {
  const live = new Set<string>();
  const done = new Set<string>();
  for (const item of items) {
    if (item.kind === "notice") continue;
    if (item.kind === "summary") done.add(item.workflowId);
    else live.add(item.workflowId);
  }
  for (const workflowId of live) {
    if (!done.has(workflowId)) return true;
  }
  return false;
}
