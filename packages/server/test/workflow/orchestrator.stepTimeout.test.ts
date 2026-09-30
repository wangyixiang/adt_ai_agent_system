import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import type { NormalizedCapability } from "@adt/shared";
import { createPool } from "../../src/db/pool";
import { migrate } from "../../src/db/migrate";
import { PostgresWorkflowStore } from "../../src/workflow/postgresStore";
import { WorkflowEngine } from "../../src/workflow/engine";
import {
  DEFAULT_STEP_TIMEOUT_GRACE_MS,
  WorkflowOrchestrator,
} from "../../src/workflow/orchestrator";
import { TEST_DATABASE_URL } from "@adt/test-support";

let pool: ReturnType<typeof createPool>;

beforeAll(async () => {
  pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
});
beforeEach(async () => {
  await pool.query("TRUNCATE workflows, workflow_steps, workflow_events");
});
afterAll(async () => {
  await pool.end();
});

const readCap = (over: Partial<NormalizedCapability> = {}): NormalizedCapability => ({
  name: "git.collect_diagnostics",
  side_effect: false,
  interruptible: true,
  idempotent: false,
  output_schema: { type: "object" },
  ...over,
});

async function dispatchedTimeout(
  capabilities: NormalizedCapability[],
  deps: { stepTimeoutGraceMs?: number; defaultStepTimeoutMs?: number } = {},
): Promise<number> {
  const store = new PostgresWorkflowStore(pool);
  const engine = new WorkflowEngine({ store, now: () => 1000 });
  const orch = new WorkflowOrchestrator({
    engine,
    store,
    planner: {
      initialCriteria: async () => ({ mode: "open", revision: 0 }),
      proposeNext: async () => ({
        kind: "step",
        step: {
          objective: "read",
          capability: "git.collect_diagnostics",
          sideEffect: false,
          interruptible: true,
        },
      }),
    },
    capabilitiesOf: () => capabilities,
    ...deps,
  });

  const wf = await engine.create("usr_1", "sess_1", { text: "x" }, { mode: "open", revision: 0 });
  const result = await orch.advance(wf.id);
  return result.dispatched!.timeoutMs;
}

describe("step timeout grace", () => {
  it("leaves the client a grace beyond its own local limit", async () => {
    const timeoutMs = await dispatchedTimeout([readCap({ timeout_hint: 5000 })]);

    // The client kills its own command at 5000; the Server waits a little
    // longer so the client's observation gets there first (PROTOCOL_SPEC.md §9).
    expect(timeoutMs).toBe(5000 + DEFAULT_STEP_TIMEOUT_GRACE_MS);
  });

  it("can be pinned exactly, for callers that do not want a grace", async () => {
    const timeoutMs = await dispatchedTimeout([readCap({ timeout_hint: 5000 })], {
      stepTimeoutGraceMs: 0,
    });
    expect(timeoutMs).toBe(5000);
  });

  it("adds the grace on top of the server default when the capability declares none", async () => {
    const timeoutMs = await dispatchedTimeout([readCap()], { defaultStepTimeoutMs: 7000 });
    expect(timeoutMs).toBe(7000 + DEFAULT_STEP_TIMEOUT_GRACE_MS);
  });
});
