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

  it("correlates capability.sync errors with the session", async () => {
    const { srv, c } = await authed();
    const err = await c.sendRaw({
      ...c.base("capability.sync"),
      payload: { mode: "bogus", revision: 0, added: [], removed: [] },
    });
    expect((err.payload as { code: string }).code).toBe("malformed_payload");
    expect(err.session_id).toBe(c.sessionId);
    expect(err.user_id).toBe(c.userId);
    await c.close();
    await srv.close();
  });

  it("keeps explicit side_effect/interruptible values", async () => {
    const { srv, c } = await authed();
    await c.sync({
      mode: "full",
      revision: 0,
      added: [
        {
          name: "git.collect_diagnostics",
          side_effect: false,
          interruptible: true,
          idempotent: true,
        },
      ],
      removed: [],
    });
    await srv.waitFor(() => srv.capabilities(c.sessionId).has("git.collect_diagnostics"));
    const cap = srv.capabilities(c.sessionId).get("git.collect_diagnostics")!;
    expect(cap.side_effect).toBe(false);
    expect(cap.interruptible).toBe(true);
    expect(cap.idempotent).toBe(true);
    await c.close();
    await srv.close();
  });

  it("keeps the declared output_type so evidence.type can be checked later", async () => {
    const { srv, c } = await authed();
    await c.sync({
      mode: "full",
      revision: 0,
      added: [
        {
          name: "git.collect_diagnostics",
          side_effect: false,
          interruptible: true,
          output_type: "git_status",
        },
      ],
      removed: [],
    });
    await srv.waitFor(() => srv.capabilities(c.sessionId).has("git.collect_diagnostics"));

    // Without it the Server can only validate the shape of `evidence.result`,
    // never that the evidence is the kind of output the capability promised.
    expect(srv.capabilities(c.sessionId).get("git.collect_diagnostics")!.output_type).toBe(
      "git_status",
    );
    await c.close();
    await srv.close();
  });

  it("applies an incremental removal", async () => {
    const { srv, c } = await authed();
    await c.sync({
      mode: "full",
      revision: 0,
      added: [{ name: "git.collect_diagnostics", side_effect: false, interruptible: true }],
      removed: [],
    });
    await srv.waitFor(() => srv.capabilities(c.sessionId).has("git.collect_diagnostics"));

    await c.sync({
      mode: "incremental",
      revision: 1,
      added: [],
      removed: ["git.collect_diagnostics"],
    });
    await srv.waitFor(() => !srv.capabilities(c.sessionId).has("git.collect_diagnostics"));
    await c.close();
    await srv.close();
  });

  it("rejects a malformed capability.sync shape", async () => {
    const { srv, c } = await authed();
    const err = await c.sendRaw({
      ...c.base("capability.sync"),
      payload: { mode: "full", revision: 1, added: "nope", removed: [] },
    });
    expect((err.payload as { code: string }).code).toBe("malformed_payload");
    await c.close();
    await srv.close();
  });
});
