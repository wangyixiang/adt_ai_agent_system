import { describe, it, expect } from "vitest";
import { buildDeposit } from "../../src/kb/deposit";
import type { RecordDocument } from "../../src/record/types";

const record = {
  record_id: "rec_1",
  workflow_id: "wf_1",
  owner_user_id: "usr_1",
  spec_versions: { workflow_spec: "0.7", capability_spec: "0.11" },
  created_at: 1,
  ended_at: 2,
  terminal_state: "COMPLETED",
  entries: [],
} as unknown as RecordDocument;

const now = () => 1_700_000_000_000;

describe("buildDeposit", () => {
  it("is stable for the same record and object", () => {
    const a = buildDeposit({ record, object: "record", now });
    const b = buildDeposit({ record, object: "record", now });

    expect(a.deposit_id).toBe(b.deposit_id);
    expect(a.deposit_version).toBe("1");
    expect(a.source).toBe("adt_ai_agent_system");
    expect(a.submitted_at).toBe("2023-11-14T22:13:20.000Z");
    expect(a.spec_versions).toEqual({ workflow_spec: "0.7", capability_spec: "0.11" });
  });

  it("changes the key when the object changes", () => {
    const asRecord = buildDeposit({ record, object: "record", now });
    const asReport = buildDeposit({
      record,
      object: "report",
      report: { format: "markdown", content: "# 报告" },
      now,
    });

    expect(asReport.deposit_id).not.toBe(asRecord.deposit_id);
    // A report deposit carries the report only — never the raw record.
    expect(asReport.content).toEqual({ format: "markdown", content: "# 报告" });
    expect(asReport.spec_versions).toBeUndefined();
    expect(JSON.stringify(asReport)).not.toContain("\"entries\"");
  });

  it("changes the key when the content changes", () => {
    const a = buildDeposit({ record, object: "record", now });
    const b = buildDeposit({
      record: { ...record, terminal_state: "FAILED" } as unknown as RecordDocument,
      object: "record",
      now,
    });
    expect(b.deposit_id).not.toBe(a.deposit_id);
  });

  it("refuses a report deposit that carries no report", () => {
    // A compile error for typed callers; the runtime guard is for untyped ones,
    // since this function is exported from the package.
    // @ts-expect-error a report deposit must carry its report
    expect(() => buildDeposit({ record, object: "report", now })).toThrow(/report/);
  });
});
