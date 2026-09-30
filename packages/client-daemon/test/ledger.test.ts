import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
