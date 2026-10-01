import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { startTestServer } from "@adt/test-support";

/**
 * The Server the desktop smoke talks to: a real `@adt/test-support` server with a
 * scripted planner (a side-effect step, then a completion candidate). It writes
 * its WS URL where the spec can read it, then stays up.
 */
const stateFile = join(process.cwd(), "smoke", ".server.json");

const resetStep = {
  kind: "step" as const,
  step: {
    objective: "复位测试台",
    capability: "sim_rig.trigger_reset",
    sideEffect: true,
    interruptible: false,
  },
};
const done = { kind: "completion_candidate" as const, summary: "看起来好了", evidenceRefs: [] };

async function main(): Promise<void> {
  const srv = await startTestServer({ planner: [resetStep, done] as never });
  await writeFile(stateFile, JSON.stringify({ url: srv.url }));
  process.stdout.write(`server ready: ${srv.url}\n`);

  const stop = async (): Promise<void> => {
    await srv.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
