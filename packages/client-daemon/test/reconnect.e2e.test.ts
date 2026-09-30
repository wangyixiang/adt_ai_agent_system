import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Planner } from "@adt/server";
import { startTestServer, type TestServer } from "@adt/test-support";
import { ClientDaemon } from "../src/daemon";
import { defaultRegistry } from "../src/capability/defaultRegistry";
import { mvpSpec } from "../src/capability/descriptors";
import { openLedger } from "../src/ledger";
import { openSessionStore } from "../src/sessionStore";

const credentials = { username: "alice", secret: "pw-alice" };
const clientInfo = { name: "reconnect-e2e", platform: "test" };

/** Proposes the reset, settles it once the outcome is unknown, then stops. */
function planner(): Planner {
  return {
    initialCriteria: async () => ({ mode: "open", revision: 0 }),
    proposeNext: async ({ steps }) => {
      const unknown = steps.find((step) => step.state === "UNKNOWN");
      if (unknown) {
        return {
          kind: "reconcile",
          stepId: unknown.id,
          outcome: "COMPLETED",
          evidenceRefs: [unknown.id],
        };
      }
      if (steps.length === 0) {
        return {
          kind: "step",
          step: {
            objective: "复位测试台",
            capability: "sim_rig.trigger_reset",
            sideEffect: true,
            interruptible: false,
          },
        };
      }
      return { kind: "completion_candidate", summary: "完成", evidenceRefs: [] };
    },
  };
}

/** The reset never answers: only the reconnect can end this step. */
function hangingRegistry(onRun: () => void) {
  const registry = defaultRegistry();
  registry.register({
    spec: mvpSpec("sim_rig.trigger_reset"),
    execute: () => {
      onRun();
      return new Promise<never>(() => undefined);
    },
  });
  return registry;
}

const stateOf = async (srv: TestServer, stepId: string): Promise<string> =>
  (await srv.engine.getStep(stepId))?.state ?? "";

async function waitForState(srv: TestServer, stepId: string, target: string): Promise<string> {
  const deadline = Date.now() + 5000;
  let state = "";
  while (Date.now() < deadline) {
    state = await stateOf(srv, stepId);
    if (state === target) return state;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return state;
}

describe("reconnect after a side effect started", () => {
  it("reports the unknown outcome instead of executing the action a second time", async () => {
    const srv = await startTestServer({
      plannerImpl: planner(),
      // Long enough that the Server itself never times the step out: the
      // UNKNOWN must come from the client that actually began the action.
      stepTimeoutMs: 60_000,
    });

    const dir = mkdtempSync(join(tmpdir(), "adt-reconnect-"));
    const sessionStore = openSessionStore(join(dir, "session.db"));
    const ledgerPath = join(dir, "ledger.db");

    let runs = 0;
    let stepId = "";

    const first = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      registry: hangingRegistry(() => {
        runs++;
      }),
      ledger: openLedger(ledgerPath),
      sessionStore,
      onConfirmationRequired: async () => true,
    });
    const sessionId = first.connection.sessionId;
    first.connection.on("step.dispatch", (env) => {
      stepId = (env.payload as { step_id: string }).step_id;
    });
    first.connection.send("workflow.request", {
      client_request_id: "req_reconnect",
      user_request: { text: "x", attachments: [], context: {} },
    });

    // Wait until the action is actually under way, then drop the connection —
    // the "began it, never learned how it ended" moment.
    const started = Date.now() + 3000;
    while (Date.now() < started && runs === 0) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(runs).toBe(1);
    await first.close();

    const second = await ClientDaemon.connect({
      url: srv.url,
      credentials,
      clientInfo,
      workspaceRoot: process.cwd(),
      registry: hangingRegistry(() => {
        runs++;
      }),
      ledger: openLedger(ledgerPath),
      sessionStore,
      onConfirmationRequired: async () => true,
    });

    // Resumed the same logical session...
    expect(second.connection.sessionId).toBe(sessionId);

    // ...and the re-dispatched step was reported unknown (then reconciled),
    // never executed again.
    const settled = await waitForState(srv, stepId, "COMPLETED");
    expect(settled).toBe("COMPLETED");
    expect(runs).toBe(1);

    await second.close();
    await srv.close();
  });
});
