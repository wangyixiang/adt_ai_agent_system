import type { RecordDocument, StepDispatchPayload } from "@adt/server";

/**
 * Rendering is display-only: it must never add a fact the message did not
 * carry (RECORD_SPEC.md — the Record/Report is the only source of truth). Where
 * a field is absent, say it is absent rather than guessing.
 */

/** Stable key order, so the same input always reads the same way. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const source = v as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = source[key];
    return sorted;
  });
}

export function renderDispatch(step: StepDispatchPayload): string {
  const lines = [
    `▸ Step ${step.step_id}（Workflow ${step.workflow_id}）`,
    // The wire type requires an objective, but a listener must never render
    // `undefined` — say the field is absent instead.
    `  目标：${step.objective ?? "（未给出目标）"}`,
    `  能力：${step.capability}`,
    `  输入：${stableJson(step.input)}`,
    `  期望证据类型：${step.expected_output ?? "（未声明）"}`,
  ];
  if (step.requires_confirmation) {
    lines.push("  ⚠ 这是一个需要你确认的副作用动作。");
  }
  return lines.join("\n");
}

export function renderTerminated(payload: {
  workflow_id: string;
  terminal_state: string;
  terminal_reason?: string | null;
  record_id: string | null;
  record_persistence_failed?: boolean;
}): string {
  const lines = [`■ Workflow ${payload.workflow_id} 结束：${payload.terminal_state}`];
  if (payload.terminal_reason) lines.push(`  原因：${payload.terminal_reason}`);
  if (payload.record_id) lines.push(`  Record：${payload.record_id}`);
  if (payload.record_persistence_failed) {
    lines.push("  ⚠ Record 未能落盘——这次诊断过程没有被完整保存。");
  }
  return lines.join("\n");
}

export function renderRecordList(payload: {
  records: Array<{
    record_id: string;
    workflow_id: string;
    summary: {
      problem_short: string;
      terminal_state: string;
      result_short: string;
      duration_ms: number;
    };
  }>;
  next_cursor: string | null;
}): string {
  if (payload.records.length === 0) return "（还没有任何 Record）";

  const lines = payload.records.map(
    (item) =>
      `- ${item.record_id}  [${item.summary.terminal_state}]  ${item.summary.problem_short}` +
      `  →  ${item.summary.result_short}（${Math.round(item.summary.duration_ms / 1000)}s）`,
  );
  if (payload.next_cursor) {
    lines.push(`（还有更多：next_cursor=${payload.next_cursor}）`);
  }
  return lines.join("\n");
}

export function renderRecord(record: RecordDocument): string {
  const lines = [
    `Record ${record.record_id}（Workflow ${record.workflow_id}）`,
    `状态：${record.terminal_state}${record.terminal_reason ? `（${record.terminal_reason}）` : ""}`,
    `问题：${record.summary.problem_short}`,
    `结果：${record.summary.result_short}`,
    "",
    "时间线：",
    ...record.entries.map((entry) => `  [${entry.kind}] ${entry.narrative}`),
  ];
  return lines.join("\n");
}

export function renderReport(payload: {
  status: string;
  report: { format: string; content: string } | null;
  error_code: string | null;
  message: string | null;
}): string {
  if (payload.status === "ok" && payload.report) return payload.report.content;
  return `Report 生成失败：${payload.error_code ?? "（未给出 error_code）"}${
    payload.message ? ` — ${payload.message}` : ""
  }`;
}

export function renderExport(payload: {
  record_id: string;
  object: string;
  status: string;
  error_code: string | null;
  message: string | null;
}): string {
  if (payload.status === "ok") {
    // ADR-005 §4: `ok` means the endpoint accepted it (2xx) — nothing more.
    return (
      `导出（${payload.object}）已发送：KB 端点已接收（2xx）——` +
      "这不表示已被收录，收录与否由 KB 侧决定。"
    );
  }
  return `导出（${payload.object}）失败：${payload.error_code ?? "（未给出 error_code）"}${
    payload.message ? ` — ${payload.message}` : ""
  }`;
}

export function renderAllocation(payload: {
  content_ref: string;
  url: string;
  expires_at: string;
  media_type: string;
  size: number;
  sha256: string;
}): string {
  return [
    `blob ${payload.content_ref}（${payload.media_type}，${payload.size} 字节）`,
    `  sha256：${payload.sha256}`,
    `  地址：${payload.url}`,
    `  有效期至：${payload.expires_at}`,
  ].join("\n");
}

export function renderProtocolError(code: string, message: string | null): string {
  return `协议错误：${code}${message ? ` — ${message}` : ""}`;
}
