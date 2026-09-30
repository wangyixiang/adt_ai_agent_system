import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { openLedger } from "../src/ledger";

describe("openLedger", () => {
  it("persists entries across a reopen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "adt-ledger-")), "ledger.db");

    const first = openLedger(path);
    first.set("idem_1", { type: "reset_ack", result: { reset_ack: true } });
    first.close();

    // A new process would do exactly this; the key must still be remembered.
    const second = openLedger(path);
    expect(second.get("idem_1")).toEqual({ type: "reset_ack", result: { reset_ack: true } });
    expect(second.get("missing")).toBeUndefined();
    second.close();
  });

  it("overwrites an existing key instead of failing", () => {
    const ledger = openLedger(":memory:");
    ledger.set("idem_1", { type: "reset_ack", result: { reset_ack: true } });
    ledger.set("idem_1", { type: "reset_ack", result: { reset_ack: false } });
    expect(ledger.get("idem_1")).toEqual({ type: "reset_ack", result: { reset_ack: false } });
    ledger.close();
  });

  it("treats an unreadable entry as no record instead of throwing at the step runner", () => {
    const path = join(mkdtempSync(join(tmpdir(), "adt-ledger-")), "ledger.db");
    const first = openLedger(path);
    first.set("idem_1", { type: "reset_ack", result: { reset_ack: true } });
    first.close();

    // Simulate a corrupted / schema-drifted row (the runner must not be the one
    // that discovers it by crashing).
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (location: string) => { exec(sql: string): void; close(): void };
    };
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE ledger SET result = 'not json' WHERE key = 'idem_1'");
    raw.close();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reopened = openLedger(path);
    expect(reopened.get("idem_1")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    reopened.close();
  });
});
