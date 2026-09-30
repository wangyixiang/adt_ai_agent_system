import { describe, it, expect } from "vitest";
import { renderDispatch, renderExport, renderReport } from "../src/render";

describe("renderDispatch", () => {
  it("shows why the human is being asked, not just that they are", () => {
    const text = renderDispatch({
      workflow_id: "wf_1",
      step_id: "st_1",
      objective: "复位测试台",
      capability: "sim_rig.trigger_reset",
      input: { rig: "A" },
      expected_output: "rig_state",
      requires_confirmation: true,
      idempotency_key: "idem_1",
    });

    expect(text).toContain("复位测试台");
    expect(text).toContain("sim_rig.trigger_reset");
    expect(text).toContain("rig");
  });

  it("does not print `undefined` when the objective is missing", () => {
    // The wire type requires it, but a listener must never render `undefined`.
    const text = renderDispatch({
      workflow_id: "wf_1",
      step_id: "st_1",
      capability: "git.collect_diagnostics",
      input: {},
      expected_output: null,
      requires_confirmation: false,
      idempotency_key: null,
    } as unknown as Parameters<typeof renderDispatch>[0]);

    expect(text).not.toContain("undefined");
    expect(text).toContain("（未给出目标）");
  });
});

describe("renderExport", () => {
  it("does not claim the KB filed it", () => {
    const text = renderExport({
      record_id: "rec_1",
      object: "record",
      status: "ok",
      error_code: null,
      message: null,
    });

    expect(text).toContain("已接收");
    expect(text).toContain("不表示");
  });

  it("shows a failure as a failure, with the reason", () => {
    const text = renderExport({
      record_id: "rec_1",
      object: "report",
      status: "failed",
      error_code: "export_unavailable",
      message: "no knowledge base endpoint is configured",
    });

    expect(text).toContain("export_unavailable");
    expect(text).toContain("no knowledge base endpoint is configured");
    expect(text).not.toContain("已接收");
  });
});

describe("renderReport", () => {
  it("prints the markdown body when it succeeded", () => {
    const text = renderReport({
      status: "ok",
      report: { format: "markdown", content: "# 诊断报告：x" },
      error_code: null,
      message: null,
    });

    expect(text).toContain("# 诊断报告：x");
  });

  it("prints the error code when it failed", () => {
    const text = renderReport({
      status: "failed",
      report: null,
      error_code: "invalid_option",
      message: "unknown detail_level",
    });

    expect(text).toContain("invalid_option");
  });
});
