import { useEffect } from "react";

export interface ReportViewerProps {
  /** The Server's markdown. `null` only when `error` is set. */
  markdown: string | null;
  error?: string | null;
  onCopy(): void;
  onSave(): void;
  onClose(): void;
}

/**
 * An overlay that shows the generated Report. On failure it shows the error and
 * **never** a partial body — a report the Server refused to generate is not a
 * report (REPORT_SPEC.md §6).
 */
export function ReportViewer({ markdown, error = null, onCopy, onSave, onClose }: ReportViewerProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="report-viewer" data-testid="report-viewer" role="dialog" aria-modal="true">
      <header>
        <span>报告</span>
        <button type="button" onClick={onClose} autoFocus>
          关闭
        </button>
      </header>
      {error !== null ? (
        <p role="alert">{error}</p>
      ) : (
        <>
          <pre className="report-content">{markdown}</pre>
          <div className="report-actions">
            <button type="button" onClick={onCopy}>
              复制
            </button>
            <button type="button" onClick={onSave}>
              另存为 .md
            </button>
          </div>
        </>
      )}
    </div>
  );
}
