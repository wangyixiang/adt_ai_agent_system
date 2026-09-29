import { describe, it, expect } from "vitest";
import { Connection, SessionManager } from "@adt/server";
import { SessionLifecycle } from "../../src/session/lifecycle";

describe("SessionLifecycle", () => {
  it("expires sessions past the ttl and reclaims their workflows in one sweep", async () => {
    let t = 0;
    const sessions = new SessionManager({ ttlMs: 100, now: () => t });
    const s = sessions.create(
      "usr_1",
      new Connection({ send: () => {}, close: () => {} }, "c1"),
    );
    sessions.detach("c1");

    const reclaimer = { reclaim: async () => ["wf_1"] };
    const lifecycle = new SessionLifecycle(
      { sessions, reclaimer },
      { intervalMs: 10, now: () => t },
    );

    t = 50;
    expect(await lifecycle.sweep()).toEqual({ expired: [], reclaimed: ["wf_1"] });

    t = 150;
    expect(await lifecycle.sweep()).toEqual({ expired: [s.id], reclaimed: ["wf_1"] });
    expect(sessions.get(s.id)).toBeNull();
  });
});
