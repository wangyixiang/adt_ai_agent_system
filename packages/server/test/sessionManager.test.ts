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
});
