import { describe, it, expect } from "vitest";
import { Connection, HeartbeatMonitor, SessionManager } from "@adt/server";

describe("monotonic clock injection", () => {
  it("sessions record time from the injected clock, not the wall clock", () => {
    const clock = { t: 1000 };
    const sessions = new SessionManager({ now: () => clock.t });
    const conn = new Connection({ send: () => {}, close: () => {} }, "c1");
    const session = sessions.create("usr_1", conn);
    expect(session.lastSeenAt).toBe(1000);
  });

  it("heartbeat sweeps against the injected clock", () => {
    const clock = { t: 1000 };
    const sessions = new SessionManager({ now: () => clock.t });
    const conn = new Connection({ send: () => {}, close: () => {} }, "c1");
    const session = sessions.create("usr_1", conn);

    const dead: string[] = [];
    const monitor = new HeartbeatMonitor(sessions, {
      intervalMs: 100,
      maxMissed: 2,
      now: () => clock.t,
      onDead: (id) => dead.push(id),
    });

    monitor.sweep();
    expect(dead).toEqual([]);

    clock.t = 5000;
    monitor.sweep();
    expect(dead).toEqual([session.id]);
  });
});
