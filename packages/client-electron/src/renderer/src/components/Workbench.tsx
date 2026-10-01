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
  onCancel(workflowId: string): Promise<void> | void;
  /** The selected run's Record, if it has one; enables report/export. */
  recordId: string | null;
  /** A report has already been generated this session (enables exporting it). */
  reportReady: boolean;
  onGenerateReport(detailLevel: "summary" | "full"): void;
  onExport(object: "record" | "report"): void;
}

/**
 * The structured view of the selected run: its state, its steps and evidence,
 * and its conclusion. It renders from the same `TranscriptItem[]` the thread
 * uses, so a live run and a past Record look alike. Cancellation is confirmed
 * inline (a second, explicit click) and requested at most once.
 */
export function Workbench({
  items,
  cancelling,
  canCancel,
  onCancel,
  recordId,
  reportReady,
  onGenerateReport,
  onExport,
}: WorkbenchProps) {
  const [confirming, setConfirming] = useState(false);
  const [requested, setRequested] = useState(false);
  const [detailLevel, setDetailLevel] = useState<"summary" | "full">("full");
  const [exportObject, setExportObject] = useState<"record" | "report">("record");

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
    const workflowId = model.workflowId;
    setConfirming(false);
    setRequested(true);
    void Promise.resolve(onCancel(workflowId)).catch(() => {
      // The request failed; let the human try again (the error is surfaced by App).
      setRequested(false);
      setConfirming(false);
    });
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

          {recordId !== null && (
            <>
              <label className="detail-level">
                报告
                <select
                  value={detailLevel}
                  onChange={(event) => setDetailLevel(event.target.value as "summary" | "full")}
                >
                  <option value="full">完整</option>
                  <option value="summary">摘要</option>
                </select>
              </label>
              <button type="button" onClick={() => onGenerateReport(detailLevel)}>
                生成报告
              </button>

              <label className="export-object">
                导出
                <select
                  value={exportObject}
                  onChange={(event) => setExportObject(event.target.value as "record" | "report")}
                >
                  <option value="record">Record</option>
                  <option value="report" disabled={!reportReady}>
                    Report
                  </option>
                </select>
              </label>
              {!reportReady && <span className="hint">生成一次报告后可导出 Report</span>}
              <button type="button" onClick={() => onExport(exportObject)}>
                导出到知识库
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
            {step.decisions.length > 0 && (
              <div className="decisions">
                {step.decisions.map((decision, index) => (
                  <span key={index} className="decision">
                    {decision}
                  </span>
                ))}
              </div>
            )}
            {step.evidenceSummary !== null && <pre className="evidence">{step.evidenceSummary}</pre>}
          </article>
        ))}
      </section>

      {model.completion !== null && (
        <section className="workbench-completion">
          <p>完成候选：{model.completion.summary}</p>
          {model.completion.evidenceRefs.length > 0 && (
            <p className="evidence-refs">依据证据：{model.completion.evidenceRefs.join("、")}</p>
          )}
        </section>
      )}

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
