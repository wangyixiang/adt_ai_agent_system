import { describe, it, expect } from "vitest";
import { placeholderAdapter } from "../../src/capability/adapters/placeholder";
import { mvpSpec } from "../../src/capability/descriptors";

describe("placeholderAdapter", () => {
  it("is declared but reports it is not implemented, without fabricating evidence", async () => {
    const adapter = placeholderAdapter(mvpSpec("local-agent.diagnose_project"));
    expect(adapter.spec.side_effect).toBe(false);
    expect(adapter.spec.input_schema).toBeUndefined();
    expect(
      await adapter.execute(
        {},
        { workspaceRoot: "/ws", run: async () => ({ stdout: "", stderr: "", code: 0 }) },
      ),
    ).toEqual({
      status: "failed",
      code: "capability_error",
      message: "local-agent.diagnose_project is not implemented in this MVP",
    });
  });
});
