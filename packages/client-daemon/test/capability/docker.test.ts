import { describe, it, expect } from "vitest";
import { dockerInspectContainer } from "../../src/capability/adapters/docker";
import { mvpSpec } from "../../src/capability/descriptors";
import type { CommandRunner } from "../../src/capability/result";

const adapter = () => dockerInspectContainer(mvpSpec("docker.inspect_container"));
const ctxWith = (run: CommandRunner) => ({ workspaceRoot: "/ws", run });

describe("docker.inspect_container", () => {
  it("maps docker inspect JSON to running/image", async () => {
    const run: CommandRunner = async () => ({
      code: 0,
      stderr: "",
      stdout: JSON.stringify([{ State: { Running: true }, Config: { Image: "nginx:1.27" } }]),
    });
    const result = await adapter().execute({ container: "web" }, ctxWith(run));
    expect(result).toEqual({
      status: "completed",
      type: "container_info",
      result: { running: true, image: "nginx:1.27" },
    });
  });

  it("fails when docker exits non-zero", async () => {
    const run: CommandRunner = async () => ({ code: 1, stdout: "", stderr: "No such container" });
    const result = await adapter().execute({ container: "nope" }, ctxWith(run));
    expect(result.status).toBe("failed");
    expect((result as { code: string }).code).toBe("capability_error");
  });

  it("requires a container name", async () => {
    const run: CommandRunner = async () => ({ code: 0, stdout: "[]", stderr: "" });
    const result = await adapter().execute({}, ctxWith(run));
    expect(result.status).toBe("rejected");
    expect((result as { code: string }).code).toBe("invalid_input");
  });
});
