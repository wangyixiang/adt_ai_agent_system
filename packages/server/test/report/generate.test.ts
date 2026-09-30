import { describe, it, expect } from "vitest";
import { generateReport, resolveDetailLevel } from "../../src/report/generate";
import type { RecordDocument } from "../../src/record/types";

const base: RecordDocument = {
  record_id: "rec_1",
  workflow_id: "wf_1",
  owner_user_id: "usr_1",
  spec_versions: { workflow_spec: "0.4", capability_spec: "0.6" },
  created_at: 0,
  ended_at: 60_000,
  terminal_state: "COMPLETED",
  terminal_reason: null,
  completion_criteria: { mode: "open", revision: 0 },
  criteria_revisions: [],
  user_request: { text: "项目起不来了" },
  summary: {
    problem_short: "项目起不来",
    terminal_state: "COMPLETED",
    result_short: "修复完成",
    duration_ms: 60_000,
  },
  entries: [
    {
      entry_id: "e1",
      ts: 1000,
      kind: "step_dispatched",
      ref: { step_id: "s1", capability: "git.collect_diagnostics", objective: "读日志" },
      narrative: "下发了 git.collect_diagnostics。",
    },
    {
      entry_id: "e2",
      ts: 2000,
      kind: "evidence_received",
      ref: { step_id: "s1", evidence: { source: "capability", type: "git_status", result: {} } },
      narrative: "读取了 git_status。",
    },
  ],
  final_result: {
    root_cause: "依赖缺失",
    resolution: "advisory",
    resolution_summary: "重装依赖后恢复",
  },
};

describe("generateReport", () => {
  it("defaults to full and renders the whole process", () => {
    expect(resolveDetailLevel(undefined)).toBe("full");
    const r = generateReport(base, "full");
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.content).toContain("# 诊断报告");
    expect(r.content).toContain("项目起不来");
    expect(r.content).toContain("读取了 git_status。");
    expect(r.content).toContain("重装依赖后恢复");
  });

  it("renders only the conclusion for the summary level", () => {
    const r = generateReport(base, "summary");
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.content).not.toContain("读取了 git_status。");
    expect(r.content).toContain("修复完成");
  });

  it("surfaces unresolved side effects in the conclusion", () => {
    const record: RecordDocument = {
      ...base,
      terminal_state: "CANCELLED",
      terminal_reason: "user_cancelled",
      summary: {
        ...base.summary,
        terminal_state: "CANCELLED",
        result_short: "存在未对账的副作用动作",
      },
      final_result: {
        cancelled_summary: null,
        unresolved_side_effects: [
          {
            step_id: "step_9",
            capability: "sim_rig.trigger_reset",
            idempotency_key: "idem_9",
            last_known_state: "UNKNOWN",
          },
        ],
      },
    };
    const r = generateReport(record, "full");
    if (r.status !== "ok") throw new Error("expected ok");
    expect(r.content).toContain("未被对账");
    expect(r.content).toContain("sim_rig.trigger_reset");
  });

  it("rejects an unknown detail level", () => {
    expect(resolveDetailLevel("verbose")).toBeNull();
    expect(resolveDetailLevel(undefined)).toBe("full");
    expect(resolveDetailLevel("summary")).toBe("summary");
  });
});
