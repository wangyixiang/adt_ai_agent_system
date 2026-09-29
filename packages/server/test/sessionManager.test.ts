import { describe, it, expect } from "vitest";
import { Connection, SessionManager } from "@adt/server";

function makeConnection(id: string) {
  return new Connection({ send: () => {}, close: () => {} }, id);
}

describe("SessionManager", () => {
  it("expires the previous session when the same connection re-handshakes", () => {
    const sessions = new SessionManager({ now: () => 0 });
    const conn = makeConnection("c1");

    const first = sessions.create("usr_1", conn);
    const second = sessions.create("usr_1", conn);

    expect(sessions.get(first.id)).toBeNull();
    expect(sessions.get(second.id)).not.toBeNull();
    expect(sessions.all()).toHaveLength(1);
  });

  it("retains a detached session until the ttl, then expires it", () => {
    let t = 1000;
    const sessions = new SessionManager({ ttlMs: 100, now: () => t });
    const s = sessions.create("usr_1", makeConnection("c1"));

    sessions.detach("c1");
    expect(sessions.get(s.id)!.connection).toBeNull();
    expect(sessions.byConnection("c1")).toBeNull();

    t += 50;
    expect(sessions.sweep()).toEqual([]);
    expect(sessions.get(s.id)).not.toBeNull();

    t += 60;
    expect(sessions.sweep()).toEqual([s.id]);
    expect(sessions.get(s.id)).toBeNull();
  });

  it("attaches a resumed session and carries its dedup window", () => {
    let t = 1000;
    const sessions = new SessionManager({ ttlMs: 100, now: () => t });
    const s = sessions.create("usr_1", makeConnection("c1"));
    s.dedup.add("msg_1");
    sessions.detach("c1");

    const resumed = sessions.attach(s.id, makeConnection("c2"));
    expect(resumed!.id).toBe(s.id);
    expect(resumed!.connection!.id).toBe("c2");
    expect(resumed!.disconnectedAt).toBeNull();
    expect(resumed!.dedup.has("msg_1")).toBe(true);
    expect(sessions.byConnection("c2")!.id).toBe(s.id);
    expect(sessions.byConnection("c1")).toBeNull();
  });

  it("refuses to attach an expired or unknown session", () => {
    let t = 1000;
    const sessions = new SessionManager({ ttlMs: 100, now: () => t });
    const s = sessions.create("usr_1", makeConnection("c1"));
    sessions.detach("c1");

    t += 200;
    expect(sessions.attach(s.id, makeConnection("c2"))).toBeNull();
    expect(sessions.attach("sess_nope", makeConnection("c3"))).toBeNull();
  });
});
