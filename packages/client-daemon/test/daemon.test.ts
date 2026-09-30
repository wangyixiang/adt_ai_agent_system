import { describe, it, expect } from "vitest";
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
});
