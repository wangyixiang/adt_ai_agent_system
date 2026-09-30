import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "@adt/test-support";
import type { DepositOutcome, DepositPayload, KnowledgeDepositor, PlannerDecision } from "@adt/server";
import {
  ClientDaemon,
  defaultRegistry,
  mvpSpec,
  openLedger,
  openSessionStore,
  uploadBlob,
  type CapabilityRegistry,
} from "@adt/client-daemon";
import { buildHostCallbacks, createPromptQueue, runCli } from "../src/console";

const credentials = { username: "alice", secret: "pw-alice" };
const clientInfo = { name: "cli-e2e", platform: "test" };

const resetStep = {
  objective: "复位测试台",
  capability: "sim_rig.trigger_reset",
  sideEffect: true,
  interruptible: false,
};
const done: PlannerDecision = { kind: "completion_candidate", summary: "看起来好了", evidenceRefs: [] };

const output = (printed: string[]): string => printed.join("\n");

/**
 * Answers each prompt by its *kind* — the human seams are asynchronous and
 * interleave with the command loop, so a positional script would be flaky. Read
 * commands wait for the run to end, because a Record only exists once it has.
 */
function scriptedCli(options: {
  commands: Array<string | (() => string | Promise<string>)>;
  /** True once the run has terminated — the gate must not read deferred output. */
  isDone: () => boolean;
  confirmation?: string;
  completion?: string;
  conflict?: string;
  feedback?: string;
}) {
  const printed: string[] = [];
  const asked: string[] = [];
  const commands = [...options.commands];
  let started = false;

  const prompter = {
    ask: async (question: string): Promise<string> => {
      asked.push(question);

      if (question.startsWith("⚠ 需要你确认")) return options.confirmation ?? "y";
      if (question.startsWith("⚠ 资源被占用")) return options.conflict ?? "stop";
      if (question.startsWith("✋")) return options.feedback ?? "";
      if (question.startsWith("接受这个结论")) return options.completion ?? "y";

      if (started && !options.isDone()) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return ""; // the run is still going: re-prompt
      }
      const next = commands.shift();
      if (next === undefined) throw new Error("EOF"); // nobody left to type
      const line = typeof next === "function" ? await next() : next;
      if (line.startsWith(":ask")) started = true;
      return line;
    },
    print: (line: string): void => void printed.push(line),
  };

  return { prompter, printed, asked };
}

async function startCli(options: {
  planner: PlannerDecision[];
  commands: Array<string | (() => string | Promise<string>)>;
  confirmation?: string;
  completion?: string;
  conflict?: string;
  feedback?: string;
  registry?: CapabilityRegistry;
  knowledgeDepositor?: KnowledgeDepositor;
}) {
  const srv: TestServer = await startTestServer({
    planner: options.planner,
    ...(options.knowledgeDepositor === undefined
      ? {}
      : { knowledgeDepositor: options.knowledgeDepositor }),
  });
  // The gate must not read printed output: the queue holds prints back while a
  // question is pending, so watching the wire is the only deadlock-free signal.
  let terminated = false;
  const scripted = scriptedCli({ ...options, isDone: () => terminated });
  const queue = createPromptQueue(scripted.prompter);
  const workspaceRoot = await mkdtemp(join(tmpdir(), "adt-cli-"));

  const daemon = await ClientDaemon.connect({
    url: srv.url,
    credentials,
    clientInfo,
    workspaceRoot,
    ledger: openLedger(":memory:"),
    sessionStore: openSessionStore(":memory:"),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...buildHostCallbacks(queue, queue.print),
  });

  daemon.connection.on("workflow.terminated", () => {
    terminated = true;
  });
  const cliDone = runCli({ daemon, prompts: queue, workspaceRoot });

  return {
    srv,
    daemon,
    workspaceRoot,
    printed: scripted.printed,
    asked: scripted.asked,
    cliDone,
    async close() {
      await cliDone.catch(() => undefined);
      await daemon.close();
      await srv.close();
    },
  };
}

interface RecordView {
  terminal_state: string;
  terminal_reason: string | null;
  entries: Array<{ kind: string; ref: Record<string, unknown> }>;
}

async function readRecord(
  connection: ClientDaemon["connection"],
  recordId: string,
): Promise<RecordView> {
  const env = await new Promise<{ payload: unknown }>((resolve) => {
    connection.on("record.get_response", (received) => resolve(received));
    connection.send("record.get_request", { record_id: recordId });
  });
  return (env.payload as { record: RecordView }).record;
}

const recordIdFrom = (printed: string[]): string => {
  const match = output(printed).match(/Record：(rec_[0-9a-f-]+)/);
  if (!match) throw new Error("no record id was printed");
  return match[1]!;
};

describe("client-cli end to end", () => {
  it("starts a run, shows the dispatch, asks for approval, and the evidence lands in the Record", async () => {
    const cli = await startCli({ planner: [{ kind: "step", step: resetStep }, done], commands: [":ask 服务异常"] });

    await cli.cliDone;

    // The human saw what was dispatched, and why they were asked.
    expect(output(cli.printed)).toContain("复位测试台");
    expect(output(cli.printed)).toContain("sim_rig.trigger_reset");
    expect(cli.asked.some((q) => q.includes("需要你确认"))).toBe(true);
    expect(output(cli.printed)).toContain("已确认完成。");

    const record = await readRecord(cli.daemon.connection, recordIdFrom(cli.printed));
    expect(record.terminal_state).toBe("COMPLETED");
    expect(record.entries.map((entry) => entry.kind)).toEqual(
      expect.arrayContaining(["step_dispatched", "evidence_received"]),
    );

    await cli.close();
  });

  it("records a refusal as a rejection instead of executing", async () => {
    const cli = await startCli({
      planner: [{ kind: "step", step: resetStep }, done],
      commands: [":ask 服务异常"],
      confirmation: "n",
    });

    await cli.cliDone;

    const record = await readRecord(cli.daemon.connection, recordIdFrom(cli.printed));
    // RECORD_SPEC.md: a *human* decline is `user_confirmation(declined)`;
    // `step_rejected` is for rejections that were not the engineer's decision.
    const declined = record.entries.find((entry) => entry.kind === "user_confirmation");
    expect(declined?.ref.decision).toBe("declined");
    expect(record.entries.map((entry) => entry.kind)).not.toContain("evidence_received");

    await cli.close();
  });

  it("ends the workflow as FAILED(resource_conflict) when the engineer will not wait", async () => {
    // The provider is the only one who can know the rig is busy, so it reports
    // it; the CLI just carries the engineer's answer.
    const registry = defaultRegistry();
    registry.register({
      spec: mvpSpec("sim_rig.trigger_reset"),
      execute: async () => ({
        status: "rejected" as const,
        code: "resource_conflict",
        message: "测试台正被占用",
      }),
    });

    const cli = await startCli({
      planner: [{ kind: "step", step: resetStep }, done],
      commands: [":ask 服务异常"],
      registry,
      conflict: "stop",
    });

    await cli.cliDone;

    expect(cli.asked.some((q) => q.includes("资源被占用"))).toBe(true);
    expect(output(cli.printed)).toContain("resource_conflict");

    const record = await readRecord(cli.daemon.connection, recordIdFrom(cli.printed));
    expect(record.terminal_state).toBe("FAILED");
    expect(record.terminal_reason).toBe("resource_conflict");

    await cli.close();
  });

  it("lists, shows and renders the Record through the read commands", async () => {
    const cli = await startCli({
      planner: [{ kind: "step", step: resetStep }, done],
      commands: [":ask 服务异常", () => `:show ${recordIdFrom(cli.printed)}`, () => `:report ${recordIdFrom(cli.printed)}`],
    });

    await cli.cliDone;

    expect(output(cli.printed)).toContain("时间线：");
    expect(output(cli.printed)).toContain("[step_dispatched]");
    expect(output(cli.printed)).toContain("# 诊断报告");

    await cli.close();
  });

  it("exports to the knowledge base, and says so honestly when none is configured", async () => {
    const seen: DepositPayload[] = [];
    const depositor: KnowledgeDepositor = {
      deposit: async (payload): Promise<DepositOutcome> => {
        seen.push(payload);
        return { status: "ok" };
      },
    };

    const configured = await startCli({
      planner: [{ kind: "step", step: resetStep }, done],
      commands: [":ask 服务异常", () => `:export ${recordIdFrom(configured.printed)}`],
      knowledgeDepositor: depositor,
    });
    await configured.cliDone;

    expect(seen).toHaveLength(1);
    expect(seen[0]!.object).toBe("record");
    expect(output(configured.printed)).toContain("已接收");
    expect(output(configured.printed)).toContain("不表示");
    await configured.close();

    // No endpoint configured: the honest answer, never a fake success.
    const bare = await startCli({
      planner: [{ kind: "step", step: resetStep }, done],
      commands: [":ask 服务异常", () => `:export ${recordIdFrom(bare.printed)}`],
    });
    await bare.cliDone;

    expect(output(bare.printed)).toContain("export_unavailable");
    await bare.close();
  });

  it("fetches a blob to a file and verifies the bytes", async () => {
    const bytes = Buffer.from("can trace line 1\nline 2\n");
    const cli = await startCli({
      planner: [{ kind: "step", step: resetStep }, done],
      commands: [
        ":ask 服务异常",
        async () => {
          const ref = await uploadBlob(
            { connection: cli.daemon.connection },
            { name: "can.log", mediaType: "text/plain", bytes },
          );
          return `:blob ${ref.content_ref} can.log`;
        },
      ],
    });

    // The script only runs out after `:blob` has finished, so this is the wait.
    await cli.cliDone;
    expect(output(cli.printed)).toContain("sha256 已校验");

    const written = await readFile(join(cli.workspaceRoot, "can.log"));
    expect(written.equals(bytes)).toBe(true);
    expect(createHash("sha256").update(written).digest("hex")).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );

    await cli.close();
  });
});
