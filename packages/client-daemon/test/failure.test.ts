import { describe, it, expect } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { encodeEnvelope, makeError } from "@adt/shared";
import { DaemonConnection } from "../src/connection";

describe("client-daemon failure handling", () => {
  it("closes the socket when the handshake is rejected", async () => {
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const port = (wss.address() as AddressInfo).port;

    const serverSawClose = new Promise<void>((resolve) => {
      wss.on("connection", (socket) => {
        socket.send(encodeEnvelope(makeError("auth_failed", "nope", null)));
        socket.on("close", () => resolve());
      });
    });

    await expect(
      DaemonConnection.connect({
        url: `ws://127.0.0.1:${port}/ws`,
        credentials: { username: "alice", secret: "wrong" },
        clientInfo: { name: "daemon-test", platform: "test" },
        capabilities: [],
      }),
    ).rejects.toThrow(/auth_failed/);

    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 3000),
    );
    expect(await Promise.race([serverSawClose.then(() => "closed" as const), timeout])).toBe(
      "closed",
    );

    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});
