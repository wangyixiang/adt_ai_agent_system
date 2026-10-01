import { useState } from "react";

import { STEP_STATE_TEXT, type TranscriptItem } from "../transcript";
import { deriveWorkbench, type WorkbenchState } from "../workbench";

const STATE_TEXT: Record<WorkbenchState, string> = {
  running: "进行中",
  CANCELLING: "正在取消（等待当前步骤结束）",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

export interface WorkbenchProps {
  items: TranscriptItem[];
  cancelling: boolean;
  canCancel: boolean;
  onCancel(workflowId: string): void;
}

/**
 * The structured view of the selected run: its state, its steps and evidence,
 * and its conclusion. It renders from the same `TranscriptItem[]` the thread
 * uses, so a live run and a past Record look alike. Cancellation is confirmed
 * inline (a second, explicit click) and requested at most once.
 */
export function Workbench({ items, cancelling, canCancel, onCancel }: WorkbenchProps) {
  const [confirming, setConfirming] = useState(false);
  const [requested, setRequested] = useState(false);

  if (items.length === 0) {
    return (
      <aside className="workbench" data-testid="workbench">
        <p className="empty">还没有可看的工作台内容。</p>
      </aside>
    );
  }

  const model = deriveWorkbench(items, cancelling);
  const canAskToCancel = canCancel && !cancelling && !requested;

  const confirmCancel = (): void => {
    if (model.workflowId === null) return;
    setConfirming(false);
    setRequested(true);
    onCancel(model.workflowId);
  };

  return (
    <aside className="workbench" data-testid="workbench">
      <header className="workbench-header">
        <span className="workbench-state">{STATE_TEXT[model.state]}</span>
        <div className="workbench-actions">
          {canAskToCancel && !confirming && (
            <button type="button" onClick={() => setConfirming(true)}>
              取消
            </button>
          )}
          {canAskToCancel && confirming && (
            <>
              <p className="hint">确定取消这条诊断吗？正在执行的不可中断步骤会等它结束。</p>
              <button type="button" onClick={confirmCancel}>
                确定取消
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                返回
              </button>
            </>
          )}
        </div>
      </header>

      <section className="workbench-steps">
        {model.steps.length === 0 && <p className="empty">还没有步骤。</p>}
        {model.steps.map((step) => (
          <article key={step.key} className="workbench-step" data-state={step.state}>
            <header>
              <span className="capability">{step.capability}</span>
              <span className="badge">{STEP_STATE_TEXT[step.state]}</span>
            </header>
            <p className="objective">{step.objective}</p>
            {step.evidenceSummary !== null && <pre className="evidence">{step.evidenceSummary}</pre>}
          </article>
        ))}
      </section>

      {model.conclusion !== null && (
        <section className="workbench-conclusion">
          <p>
            {model.conclusion.terminalState}
            {model.conclusion.terminalReason === null ? "" : ` · ${model.conclusion.terminalReason}`}
          </p>
          {model.conclusion.recordId !== null && (
            <p className="record">Record: {model.conclusion.recordId}</p>
          )}
        </section>
      )}
    </aside>
  );
}
