import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { openLedger } from "../src/ledger";

const sqlite = (): { DatabaseSync: new (location: string) => { exec(sql: string): void; close(): void } } =>
  createRequire(import.meta.url)("node:sqlite") as never;

describe("openLedger", () => {
  it("persists entries across a reopen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "adt-ledger-")), "ledger.db");

    const first = openLedger(path);
    first.markDone("idem_1", "reset_ack", { reset_ack: true });
    first.close();

    // A new process would do exactly this; the key must still be remembered.
    const second = openLedger(path);
    expect(second.get("idem_1")).toEqual({
      state: "done",
      type: "reset_ack",
      result: { reset_ack: true },
    });
    expect(second.get("missing")).toBeUndefined();
    second.close();
  });

  it("distinguishes 'never seen', 'in flight' and 'done'", () => {
    const ledger = openLedger(":memory:");
    const key = "idem_1";

    expect(ledger.get(key)).toBeUndefined();

    // Before executing a side effect the runner says so; that is what makes a
    // re-dispatch after a reconnect report UNKNOWN instead of re-running it.
    ledger.markInFlight(key);
    expect(ledger.get(key)).toEqual({ state: "in_flight" });

    ledger.markDone(key, "reset_ack", { reset_ack: true });
    expect(ledger.get(key)).toEqual({
      state: "done",
      type: "reset_ack",
      result: { reset_ack: true },
    });

    // A failure clears the marker: the action is not "unknown", it did not happen.
    ledger.clear(key);
    expect(ledger.get(key)).toBeUndefined();
    ledger.close();
  });

  it("lets a later result replace an in-flight marker", () => {
    const ledger = openLedger(":memory:");
    ledger.markInFlight("idem_1");
    ledger.markDone("idem_1", "reset_ack", { reset_ack: true });
    expect(ledger.get("idem_1")!.state).toBe("done");
    ledger.close();
  });

  it("treats an unreadable entry as unconfirmed, not as never seen", () => {
    const path = join(mkdtempSync(join(tmpdir(), "adt-ledger-")), "ledger.db");
    const first = openLedger(path);
    first.markDone("idem_1", "reset_ack", { reset_ack: true });
    first.close();

    // Simulate a corrupted / schema-drifted row. The action *did* happen, so the
    // safe reading is "we cannot confirm the outcome" — which the runner answers
    // with UNKNOWN instead of executing a second time (WORKFLOW_SPEC.md §4.3).
    const { DatabaseSync } = sqlite();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE ledger SET result = 'not json' WHERE key = 'idem_1'");
    raw.close();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reopened = openLedger(path);
    expect(reopened.get("idem_1")).toEqual({ state: "in_flight" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    reopened.close();
  });

  it("knows whether its entries survive a restart", () => {
    const file = openLedger(join(mkdtempSync(join(tmpdir(), "adt-ledger-")), "ledger.db"));
    expect(file.persistent).toBe(true);
    file.close();

    // Resuming a session on top of a memory-only ledger is unsafe, so the
    // caller needs to be able to tell the difference.
    const memory = openLedger(":memory:");
    expect(memory.persistent).toBe(false);
    memory.close();
  });

  it("reads a row written by the older two-column ledger as done", () => {
    // The daemon may already have a ledger from before the three-state change.
    const path = join(mkdtempSync(join(tmpdir(), "adt-ledger-")), "ledger.db");
    const { DatabaseSync } = sqlite();
    const raw = new DatabaseSync(path);
    raw.exec(
      "CREATE TABLE ledger (key text PRIMARY KEY, type text NOT NULL, result text NOT NULL)",
    );
    raw.exec(
      `INSERT INTO ledger (key, type, result) VALUES ('idem_old', 'reset_ack', '{"reset_ack":true}')`,
    );
    raw.close();

    const ledger = openLedger(path);
    expect(ledger.get("idem_old")).toEqual({
      state: "done",
      type: "reset_ack",
      result: { reset_ack: true },
    });
    ledger.close();
  });
});
