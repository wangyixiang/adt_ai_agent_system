import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { DaemonConnection } from "../src/connection";

/** The slice of the `ws` API `DaemonConnection` uses. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  send(): void {
    // nothing to do
  }
  close(): void {
    this.emit("close");
  }
}

const connectionWith = (socket: FakeSocket): DaemonConnection =>
  new (DaemonConnection as unknown as new (
    ws: FakeSocket,
    sessionId: string,
    userId: string,
    heartbeatIntervalMs: number,
  ) => DaemonConnection)(socket, "sess_1", "usr_1", 60_000);

describe("DaemonConnection socket errors", () => {
  it("handles a socket error instead of letting it crash the process", () => {
    const socket = new FakeSocket();
    connectionWith(socket);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Without a listener this emit is an unhandled 'error' event, which Node
    // turns into a thrown exception outside any try/catch.
    expect(() => socket.emit("error", new Error("connection reset"))).not.toThrow();
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "connection reset",
    );
    warn.mockRestore();
  });
});
