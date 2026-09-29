import { describe, it, expect } from "vitest";
import { startTestServer, TestClient } from "@adt/test-support";

async function authed() {
  const srv = await startTestServer();
  const c = await TestClient.connect(srv.url);
  await c.hello({ username: "alice", secret: "pw-alice" });
  return { srv, c };
}

describe("capability.sync", () => {
  it("applies conservative defaults when side_effect/interruptible are missing", async () => {
    const { srv, c } = await authed();
    await c.sync({
      mode: "full",
      revision: 0,
      added: [{ name: "git.collect_diagnostics" }],
      removed: [],
    });
    await srv.waitFor(() => srv.capabilities(c.sessionId).has("git.collect_diagnostics"));
    const cap = srv.capabilities(c.sessionId).get("git.collect_diagnostics")!;
    expect(cap.side_effect).toBe(true);
    expect(cap.interruptible).toBe(false);
    expect(cap.idempotent).toBe(false);
    await c.close();
    await srv.close();
  });

  it("ignores a stale revision and warns", async () => {
    const { srv, c } = await authed();
    await c.sync({
      mode: "full",
      revision: 5,
      added: [{ name: "filesystem.read_file", side_effect: false, interruptible: true }],
      removed: [],
    });
    await srv.waitFor(() => srv.capabilities(c.sessionId).has("filesystem.read_file"));
    await c.sync({
      mode: "incremental",
      revision: 3,
      added: [{ name: "docker.inspect_container" }],
      removed: [],
    });
    await srv.waitFor(() =>
      srv.warnings(c.sessionId).some((w) => /stale revision/i.test(w)),
    );
    expect(srv.capabilities(c.sessionId).has("docker.inspect_container")).toBe(false);
    await c.close();
    await srv.close();
  });

  it("ignores an unregistered capability name but keeps the rest", async () => {
    const { srv, c } = await authed();
    await c.sync({
      mode: "full",
      revision: 0,
      added: [
        { name: "not.registered_thing" },
        { name: "filesystem.read_file", side_effect: false, interruptible: true },
      ],
      removed: [],
    });
    await srv.waitFor(() => srv.capabilities(c.sessionId).has("filesystem.read_file"));
    expect(srv.capabilities(c.sessionId).has("not.registered_thing")).toBe(false);
    await c.close();
    await srv.close();
  });
});
