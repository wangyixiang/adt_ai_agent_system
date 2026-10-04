import { useCallback, useState } from "react";

import { STEP_STATE_TEXT, type TranscriptItem } from "../transcript";
import { deriveWorkbench, type WorkbenchState } from "../workbench";
import { Icon } from "./Icon";

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
  onPreviewBlob(contentRef: string, mediaType: string): void;
  onSaveBlob(contentRef: string, mediaType: string, name?: string): void;
  /** The step the thread asked to locate; `null` when nothing was asked. */
  focusedStepId: string | null;
  /** Locate a step in this panel (used by the completion candidate's refs). */
  onLocate(stepId: string): void;
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
  onPreviewBlob,
  onSaveBlob,
  focusedStepId,
  onLocate,
}: WorkbenchProps) {
  const [confirming, setConfirming] = useState(false);
  const [requested, setRequested] = useState(false);
  const [detailLevel, setDetailLevel] = useState<"summary" | "full">("full");
  const [exportObject, setExportObject] = useState<"record" | "report">("record");
  const focusRef = useCallback((node: HTMLElement | null): void => {
    node?.scrollIntoView?.({ block: "nearest" });
  }, []);

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
        <div className="workbench-heading">
          <h2 className="workbench-title"><Icon name="tune" /> 诊断工作台</h2>
          <span className="workbench-state" data-state={model.state}>
            <span className="workbench-state-dot" />
            {STATE_TEXT[model.state]}
          </span>
        </div>

        <div className="workbench-actions">
          {recordId !== null && (
            <button type="button" onClick={() => onGenerateReport(detailLevel)}>
              <Icon name="summarize" /> 生成报告
            </button>
          )}
          {recordId !== null && (
            <button type="button" onClick={() => onExport(exportObject)}>
              <Icon name="book" /> 导出到知识库
            </button>
          )}
          {canAskToCancel && !confirming && (
            <button type="button" className="danger" onClick={() => setConfirming(true)}>
              <Icon name="cancel" /> 取消
            </button>
          )}
          {canAskToCancel && confirming && (
            <>
              <button type="button" className="danger" onClick={confirmCancel}>
                确定取消
              </button>
              <button type="button" onClick={() => setConfirming(false)}>
                返回
              </button>
            </>
          )}
        </div>
        {canAskToCancel && confirming && (
          <p className="hint">确定取消这条诊断吗？正在执行的不可中断步骤会等它结束。</p>
        )}

        {recordId !== null && (
          <div className="workbench-options">
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
          </div>
        )}
      </header>

      <div className="workbench-scroll">
      <div className="workbench-section-heading">
        <span className="workbench-section-label"><Icon name="timeline" /> 步骤与证据时间线 / STEP TIMELINE</span>
        <span className="workbench-section-count">{model.steps.length} NODES</span>
      </div>
      <section className="workbench-steps">
        {model.steps.length === 0 && <p className="empty">还没有步骤。</p>}
        <div className="workbench-timeline">
          {model.steps.map((step) => (
            <article
              key={step.key}
              className="workbench-step"
              data-state={step.state}
              data-focused={focusedStepId === step.stepId}
              ref={focusedStepId === step.stepId ? focusRef : undefined}
            >
              <span className="workbench-node" data-state={step.state} />
              <header>
                <span className="capability">{step.capability}</span>
                <span className="badge">{STEP_STATE_TEXT[step.state]}</span>
              </header>
              {step.objective !== "" && <p className="objective">目标: {step.objective}</p>}
              {step.requiresConfirmation && <p className="needs-confirmation">需要人工确认</p>}
              {Object.keys(step.input).length > 0 && (
                <details className="step-input">
                  <summary>输入</summary>
                  <pre>{JSON.stringify(step.input, null, 2)}</pre>
                </details>
              )}
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
              {step.evidenceBlob !== null && (
                <div className="evidence-blob">
                  <button
                    type="button"
                    onClick={() => onPreviewBlob(step.evidenceBlob!.content_ref, step.evidenceBlob!.media_type)}
                  >
                    <Icon name="eye" /> 预览证据
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onSaveBlob(step.evidenceBlob!.content_ref, step.evidenceBlob!.media_type, step.evidenceBlob!.name)
                    }
                  >
                    <Icon name="download" /> 另存证据
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      </section>
      </div>

      <div className="workbench-footer">
      <div className="workbench-section-heading">
        <span className="workbench-section-label">结论与收敛区 / TERMINAL &amp; CANDIDATE</span>
      </div>
      {model.completion !== null && (
        <section className="workbench-completion">
          <div className="workbench-completion-head">
            <span className="workbench-completion-title"><Icon name="tips" /> 当前完成候选 (Completion Candidate)</span>
            <span className="chip">DRAFT</span>
          </div>
          <p className="completion-decision">{model.completion.decision ?? "待你决定"}</p>
          {model.completion.evidenceRefs.length > 0 && (
            <div className="completion-refs">
              <span>依据证据：</span>
              {model.completion.evidenceRefs.map((ref) =>
                model.steps.some((step) => step.stepId === ref) ? (
                  <button key={ref} type="button" onClick={() => onLocate(ref)}>
                    {ref}
                  </button>
                ) : (
                  <span key={ref} className="completion-ref-missing">
                    {ref}
                  </span>
                ),
              )}
            </div>
          )}
        </section>
      )}

      {model.conclusion === null ? (
        <div className="workbench-terminal-placeholder">
          <Icon name="verified" /> 终止收敛后将在此固化 terminal_state、terminal_reason 与 recordId 归档指纹。
        </div>
      ) : (
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
      </div>
    </aside>
  );
}
