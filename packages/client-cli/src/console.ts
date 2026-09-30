import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
  downloadBlob,
  type ClientDaemon,
  type ClientDaemonOptions,
  type ConfirmationRequest,
  type ManualActionFeedback,
  type ResourceConflictRequest,
  type UserInputRequest,
} from "@adt/client-daemon";
import type { RecordDocument, StepDispatchPayload } from "@adt/server";

import { parseCommand, parseConfirmation, parseManualFeedback, parseResourceConflict, type Command } from "./answers";
import {
  renderDispatch,
  renderExport,
  renderRecord,
  renderRecordList,
  renderReport,
  renderProtocolError,
  renderTerminated,
} from "./render";

/** The only thing this program needs from a terminal. */
export interface Prompter {
  ask(question: string): Promise<string>;
  print(line: string): void;
}

/**
 * One question at a time. Dispatches arrive asynchronously while the human is
 * mid-answer, so every question — the command prompt and the daemon's host
 * callbacks alike — goes through this queue. Two pending questions would eat
 * each other's input.
 */
export function createPromptQueue(prompter: Prompter): { ask(question: string): Promise<string> } {
  let chain: Promise<unknown> = Promise.resolve();

  return {
    ask(question: string): Promise<string> {
      const next = chain.then(
        () => prompter.ask(question),
        () => prompter.ask(question),
      );
      chain = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

export function renderConfirmationPrompt(request: ConfirmationRequest): string {
  return [
    `⚠ 需要你确认的副作用动作（Step ${request.stepId}）`,
    `  目标：${request.objective}`,
    `  能力：${request.capability}`,
    `  输入：${JSON.stringify(request.input)}`,
    "执行吗？[y/N] ",
  ].join("\n");
}

export function renderUserInputPrompt(request: UserInputRequest): string {
  return [
    `✋ 建议你手动执行（Step ${request.stepId}）`,
    `  目标：${request.objective}`,
    `  能力：${request.capability}`,
    `  输入：${JSON.stringify(request.input)}`,
    "做完后回报：succeeded | failed | partially | unknown（可跟 \": 观察\"）；直接回车表示不回报。",
    "> ",
  ].join("\n");
}

export function renderResourceConflictPrompt(request: ResourceConflictRequest): string {
  return [
    `⚠ 资源被占用（Step ${request.stepId}，${request.capability}）`,
    `  目标：${request.objective}`,
    ...(request.message ? [`  提供方说明：${request.message}`] : []),
    "等资源腾出来（wait），还是就此停下（stop）？[wait/stop] ",
  ].join("\n");
}

/**
 * The daemon's three human seams. Every path out of here lands on the **safe**
 * default when nobody answers (EOF, a closed stdin, a thrown read): decline the
 * side effect, stop on a resource conflict, report nothing.
 */
export function buildHostCallbacks(
  prompts: { ask(question: string): Promise<string> },
  print: (line: string) => void,
): Pick<ClientDaemonOptions, "onConfirmationRequired" | "onUserInput" | "onResourceConflict"> {
  const askOrNull = async (question: string): Promise<string | null> => {
    try {
      return await prompts.ask(question);
    } catch {
      return null;
    }
  };

  return {
    onConfirmationRequired: async (request: ConfirmationRequest): Promise<boolean> => {
      for (;;) {
        const line = await askOrNull(renderConfirmationPrompt(request));
        if (line === null || line.trim() === "") {
          print("（没有回答，按安全默认处理：拒绝）");
          return false;
        }
        const answer = parseConfirmation(line);
        if (answer !== null) return answer;
        print("请回答 y 或 n。");
      }
    },

    onUserInput: async (request: UserInputRequest): Promise<ManualActionFeedback | undefined> => {
      const line = await askOrNull(renderUserInputPrompt(request));
      if (line === null) return undefined;
      // `null` means "no feedback", which the daemon spells `undefined`.
      return parseManualFeedback(line) ?? undefined;
    },

    onResourceConflict: async (request: ResourceConflictRequest): Promise<"wait" | "stop"> => {
      for (;;) {
        const line = await askOrNull(renderResourceConflictPrompt(request));
        if (line === null || line.trim() === "") return "stop";
        const answer = parseResourceConflict(line);
        if (answer !== null) return answer;
        print("请回答 wait 或 stop。");
      }
    },
  };
}

export interface CliArgs {
  url: string;
  username: string;
  /** `null` means "ask for it without echoing", never "no secret". */
  secret: string | null;
  workspaceRoot: string;
  ledgerPath: string;
  sessionPath: string;
}

const DEFAULT_URL = "ws://127.0.0.1:8080/ws";
const DEFAULT_LEDGER = ".adt/client-cli/ledger.db";
const DEFAULT_SESSION = ".adt/client-cli/session.json";

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): CliArgs {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=");
    // A bare `--` (what `pnpm start -- …` passes through) has no name: skip it
    // without consuming the next argument, which is a real flag.
    if (!name) continue;
    const value = inline ?? argv[++index];
    if (value !== undefined) flags.set(name, value);
  }

  return {
    url: flags.get("url") ?? DEFAULT_URL,
    username: flags.get("user") ?? "",
    // A password on argv is visible to `ps`, so it is a convenience, not the
    // only way in: main() prompts without echoing when this is null.
    secret: flags.get("secret") ?? env.ADT_SECRET ?? null,
    workspaceRoot: resolve(flags.get("workspace") ?? process.cwd()),
    ledgerPath: flags.get("ledger") ?? DEFAULT_LEDGER,
    sessionPath: flags.get("session") ?? DEFAULT_SESSION,
  };
}

export const CLI_HELP = [
  "命令：",
  "  :records                             列出自己的 Record",
  "  :show <record_id>                    看一条 Record 的完整内容",
  "  :report <record_id> [summary|full]   生成 Report（默认 full）",
  "  :export <record_id> [record|report]  导出到 KB（默认 record）",
  "  :blob <content_ref> <path>           取回 blob 并写到本地文件",
  "  :help / :quit",
].join("\n");

export interface CliIo {
  daemon: ClientDaemon;
  prompts: { ask(question: string): Promise<string> };
  print: (line: string) => void;
  workspaceRoot: string;
}

/** The command loop: reads a line, runs a command, until `:quit` or EOF. */
export async function runCli(io: CliIo): Promise<void> {
  const { daemon, prompts, print, workspaceRoot } = io;
  const connection = daemon.connection;

  connection.on("step.dispatch", (env) => print(renderDispatch(env.payload as StepDispatchPayload)));
  connection.on("workflow.terminated", (env) =>
    print(renderTerminated(env.payload as Parameters<typeof renderTerminated>[0])),
  );
  connection.on("workflow.completion_candidate", (env) => {
    const payload = env.payload as { summary?: string };
    print(`◇ 系统认为可能已完成：${payload.summary ?? "（未给出说明）"}（在 Server 侧确认）`);
  });
  connection.on("protocol.error", (env) => {
    const payload = env.payload as { code?: string; message?: string };
    print(renderProtocolError(payload.code ?? "error", payload.message ?? null));
  });

  print(`已连接：session=${connection.sessionId}，user=${connection.userId}`);
  print(CLI_HELP);

  for (;;) {
    let line: string;
    try {
      line = await prompts.ask("> ");
    } catch {
      print("（输入结束，退出）");
      return;
    }
    if (line.trim() === "") continue;

    const command = parseCommand(line);
    if (command === null) {
      print("（这不是一条命令。输入 :help 看用法）");
      continue;
    }
    if (command.kind === "quit") {
      print("再见。");
      return;
    }
    await runCommand(command, { connection, print, workspaceRoot });
  }
}

async function runCommand(
  command: Command,
  io: Pick<CliIo, "workspaceRoot" | "print"> & { connection: ClientDaemon["connection"] },
): Promise<void> {
  const { connection, print, workspaceRoot } = io;

  try {
    switch (command.kind) {
      case "help":
        print(CLI_HELP);
        return;

      case "records": {
        const payload = await connection.request(
          "record.list_request",
          { filters: {}, cursor: null, page_size: 20 },
          "record.list_response",
        );
        print(renderRecordList(payload as Parameters<typeof renderRecordList>[0]));
        return;
      }

      case "show": {
        const payload = await connection.request(
          "record.get_request",
          { record_id: command.recordId },
          "record.get_response",
        );
        print(renderRecord(payload.record as RecordDocument));
        return;
      }

      case "report": {
        const payload = await connection.request(
          "report.generate_request",
          { record_id: command.recordId, options: { detail_level: command.detailLevel } },
          "report.generate_result",
        );
        print(renderReport(payload as Parameters<typeof renderReport>[0]));
        return;
      }

      case "export": {
        const payload = await connection.request(
          "record.export_request",
          { record_id: command.recordId, object: command.object, target: "knowledge_base" },
          "record.export_result",
        );
        print(renderExport(payload as Parameters<typeof renderExport>[0]));
        return;
      }

      case "blob": {
        // `downloadBlob` verifies the sha256 the server reports, so a mangled
        // transfer cannot look like a successful fetch.
        const bytes = await downloadBlob({ connection }, command.contentRef);
        const target = resolve(workspaceRoot, command.path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        print(`已写入 ${target}（${bytes.length} 字节，sha256 已校验）`);
        return;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    print(`请求失败：${message}`);
  }
}

/**
 * The real terminal. `ask` rejects once the input is closed, which is how the
 * host callbacks learn that nobody is there to answer.
 */
export function readlinePrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Prompter & { close(): void } {
  const rl = createInterface({ input, output, terminal: true });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  return {
    ask(question: string): Promise<string> {
      if (closed) return Promise.reject(new Error("EOF"));
      return new Promise<string>((resolve, reject) => {
        const onClose = (): void => reject(new Error("EOF"));
        rl.once("close", onClose);
        rl.question(question, (answer) => {
          rl.off("close", onClose);
          resolve(answer);
        });
      });
    },
    print(line: string): void {
      output.write(`${line}\n`);
    },
    close(): void {
      rl.close();
    },
  };
}
