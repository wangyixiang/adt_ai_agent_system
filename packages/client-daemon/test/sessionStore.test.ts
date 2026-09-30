import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionStore } from "../src/sessionStore";

describe("openSessionStore", () => {
  it("remembers one logical session across a reopen and forgets it on clear", () => {
    const path = join(mkdtempSync(join(tmpdir(), "adt-session-")), "session.db");
    const first = openSessionStore(path);
    expect(first.load()).toBeNull();

    first.save({ sessionId: "sess_1", userId: "usr_1" });
    first.close();

    const second = openSessionStore(path);
    expect(second.load()).toEqual({ sessionId: "sess_1", userId: "usr_1" });

    // Saving again replaces it: a daemon only ever has one live session.
    second.save({ sessionId: "sess_2", userId: "usr_1" });
    expect(second.load()!.sessionId).toBe("sess_2");

    second.clear();
    expect(second.load()).toBeNull();
    second.close();
  });

  it("keeps working in memory", () => {
    const store = openSessionStore(":memory:");
    store.save({ sessionId: "sess_mem", userId: "usr_1" });
    expect(store.load()).toEqual({ sessionId: "sess_mem", userId: "usr_1" });
    store.close();
  });
});
