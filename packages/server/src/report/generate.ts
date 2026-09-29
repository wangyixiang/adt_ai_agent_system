import type { RecordDocument, UnresolvedSideEffect } from "../record/types";

export type DetailLevel = "summary" | "full";

export type ReportErrorCode =
  | "generation_failed"
  | "insufficient_content"
  | "invalid_option"
  | "timeout";

export type ReportResult =
  | { status: "ok"; format: "markdown"; content: string }
  | { status: "failed"; error_code: ReportErrorCode; message: string };

/** Unspecified → `full` (REPORT_SPEC.md §3). */
export function resolveDetailLevel(value: unknown): DetailLevel | null {
  if (value === undefined || value === null) return "full";
  return value === "summary" || value === "full" ? value : null;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}

function renderConclusion(record: RecordDocument): string {
  const final = record.final_result as Record<string, unknown>;
  switch (record.terminal_state) {
    case "COMPLETED": {
      const rootCause = final.root_cause ?? "未给出明确原因";
      return `- 原因：${String(rootCause)}\n- 结论：${String(final.resolution_summary ?? "")}`;
    }
    case "FAILED":
      return `- ${String(final.failure_summary ?? "系统判定无法继续")}`;
    default:
      return final.cancelled_summary ? `- ${String(final.cancelled_summary)}` : "- 工程师主动终止。";
  }
}

function renderUnresolved(record: RecordDocument): string {
  const final = record.final_result as Record<string, unknown>;
  const unresolved = final.unresolved_side_effects as UnresolvedSideEffect[] | undefined;
  if (!unresolved || unresolved.length === 0) return "";

  const lines = unresolved.map(
    (item) =>
      `- ${item.step_id} / ${item.capability} / 最后已知状态：${item.last_known_state}`,
  );
  return [
    "",
    "> ⚠️ 以下副作用动作在 Workflow 结束时**未被对账**，可能已执行（不推断其成败）：",
    ...lines,
    "",
  ].join("\n");
}

/**
 * A Report is only a re-arrangement of an existing Record — it never adds
 * facts (REPORT_SPEC.md §0). `narrative` is reused verbatim, not rewritten.
 */
export function generateReport(record: RecordDocument, detailLevel: DetailLevel): ReportResult {
  const problem = record.summary.problem_short;

  if (detailLevel === "summary") {
    const content = [
      `# 诊断报告：${problem}`,
      "",
      `- Record ID: ${record.record_id}`,
      `- 状态：${record.summary.terminal_state}`,
      `- 耗时：${formatDuration(record.summary.duration_ms)}`,
      "",
      "## 结论",
      "",
      record.summary.result_short,
      "",
      "## 最终结果",
      "",
      renderConclusion(record),
      renderUnresolved(record),
    ].join("\n");
    return { status: "ok", format: "markdown", content };
  }

  const processLines = record.entries.map((entry) => `- ${entry.narrative}`).join("\n");
  const content = [
    `# 诊断报告：${problem}`,
    "",
    `- Record ID: ${record.record_id}`,
    `- 状态：${record.summary.terminal_state}`,
    `- 耗时：${formatDuration(record.summary.duration_ms)}`,
    "",
    "## 问题描述",
    "",
    String((record.user_request as { text?: string } | null)?.text ?? ""),
    "",
    "## 诊断过程",
    "",
    processLines || "（无）",
    "",
    "## 结论",
    "",
    renderConclusion(record),
    renderUnresolved(record),
  ].join("\n");

  return { status: "ok", format: "markdown", content };
}
