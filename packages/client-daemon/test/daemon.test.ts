import { describe, it, expect } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { encodeEnvelope, nowUtcIso, PROTOCOL_VERSION } from "@adt/shared";
import { startTestServer } from "@adt/test-support";
import { ClientDaemon } from "../src/daemon";

describe("ClientDaemon", () => {
  it("declares the registry's capabilities on the server and runs steps", async () => {
    const srv = await startTestServer({ planner: [] });
    const daemon = await ClientDaemon.connect({
      url: srv.url,
      credentials: { username: "alice", secret: "pw-alice" },
      clientInfo: { name: "daemon-test", platform: "test" },
      workspaceRoot: process.cwd(),
    });

    await srv.waitFor(() => srv.capabilities(daemon.connection.sessionId).has("git.collect_diagnostics"));
    const declared = srv.capabilities(daemon.connection.sessionId);
    expect(declared.get("filesystem.read_file")!.side_effect).toBe(false);

    await daemon.close();
    await srv.close();
  });

  it("handles a step.dispatch that arrives immediately after the welcome", async () => {
    const received: string[] = [];
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
    const port = (wss.address() as AddressInfo).port;

    const envelope = (type: string, payload: unknown) =>
      encodeEnvelope({
        protocol_version: PROTOCOL_VERSION,
        message_id: `msg_${type}`,
        session_id: null,
        workflow_id: null,
        user_id: null,
        type,
        ts: nowUtcIso(),
        in_reply_to: null,
        payload,
      });

    wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        const env = JSON.parse(data.toString()) as { type: string; payload: { status?: string } };
        if (env.type === "session.hello") {
          socket.send(
            envelope("session.welcome", {
              protocol_version: PROTOCOL_VERSION,
              session_id: "sess_1",
              user_id: "usr_1",
              heartbeat_interval_ms: 15000,
            }),
          );
          // Dispatch immediately — before the caller can attach a runner.
          socket.send(
            envelope("step.dispatch", {
              workflow_id: "wf_1",
              step_id: "step_1",
              objective: "read",
              capability: "filesystem.read_file",
              input: { path: "a.txt" },
              expected_output: null,
              requires_confirmation: false,
              idempotency_key: null,
            }),
          );
        }
        if (env.type === "step.status" && typeof env.payload.status === "string") {
          received.push(env.payload.status);
        }
      });
    });

    const daemon = await ClientDaemon.connect({
      url: `ws://127.0.0.1:${port}/ws`,
      credentials: { username: "alice", secret: "pw" },
      clientInfo: { name: "t", platform: "test" },
      workspaceRoot: process.cwd(),
    });

    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && !received.includes("RUNNING")) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(received).toContain("RUNNING");

    await daemon.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
});
