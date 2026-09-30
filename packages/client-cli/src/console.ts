import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

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
  stableJson,
} from "./render";

/** The only thing this program needs from a terminal. */
export interface Prompter {
  ask(question: string): Promise<string>;
  print(line: string): void;
}

/**
 * One question at a time — and one *speaker* at a time.
 *
 * Dispatches arrive asynchronously while the human is mid-answer, so every
 * question (the command prompt and the daemon's host callbacks alike) goes
 * through this queue: two pending questions would eat each other's input. The
 * queue also owns printing, holding inbound lines back until the question on
 * screen has been answered, so a dispatch never lands inside it.
 */
export function createPromptQueue(prompter: Prompter): PromptQueue {
  let chain: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const deferred: string[] = [];

  const flush = (): void => {
    if (pending > 0) return;
    while (deferred.length > 0) prompter.print(deferred.shift()!);
  };

  /** Serialize one question. `skip` is re-checked once it is this one's turn. */
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    pending++;
    const next = chain.then(work, work);
    chain = next.then(
      () => {
        pending--;
        flush();
      },
      () => {
        pending--;
        flush();
      },
    );
    return next;
  };

  return {
    ask: (question: string): Promise<string> => enqueue(() => prompter.ask(question)),
    askUnless: (skip: () => boolean, question: string): Promise<string | null> =>
      enqueue(() => (skip() ? Promise.resolve(null) : prompter.ask(question))),
    print(line: string): void {
      if (pending > 0) deferred.push(line);
      else prompter.print(line);
    },
  };
}

/** The queue's halves: ask a question, or say something between questions. */
export interface PromptQueue {
  ask(question: string): Promise<string>;
  /**
   * Ask, unless `skip` has become true by the time this question's turn comes —
   * so quitting is not held up by a question that was queued behind the quit.
   * Resolves `null` when skipped.
   */
  askUnless(skip: () => boolean, question: string): Promise<string | null>;
  print(line: string): void;
}

export function renderConfirmationPrompt(request: ConfirmationRequest): string {
  return [
    `⚠ 需要你确认的副作用动作（Step ${request.stepId}）`,
    `  目标：${request.objective ?? "（未给出目标）"}`,
    `  能力：${request.capability}`,
    `  输入：${stableJson(request.input)}`,
    "执行吗？[y/N] ",
  ].join("\n");
}

export function renderUserInputPrompt(request: UserInputRequest): string {
  return [
    `✋ 建议你手动执行（Step ${request.stepId}）`,
    `  目标：${request.objective ?? "（未给出目标）"}`,
    `  能力：${request.capability}`,
    `  输入：${stableJson(request.input)}`,
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
      for (;;) {
        const line = await askOrNull(renderUserInputPrompt(request));
        if (line === null) return undefined;
        // An empty line is a real answer: "nothing to report".
        if (line.trim() === "") return undefined;

        const feedback = parseManualFeedback(line);
        if (feedback !== null) return feedback;
        // A mistyped report must not be silently dropped — nor read as "declined".
        print('请回报 succeeded | failed | partially | unknown（可跟 ": 观察"），或直接回车不回报。');
      }
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
  /** Flags we did not recognise — a typo should be visible, not silent. */
  unknownFlags: string[];
  /** Recognised flags that carried no value (e.g. `--url` at the end of argv). */
  valuelessFlags: string[];
}

const DEFAULT_URL = "ws://127.0.0.1:8080/ws";
const DEFAULT_LEDGER = ".adt/client-cli/ledger.db";
const DEFAULT_SESSION = ".adt/client-cli/session.json";
const KNOWN_FLAGS = new Set(["url", "user", "secret", "workspace", "ledger", "session"]);

export function parseArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): CliArgs {
  const flags = new Map<string, string>();
  const unknownFlags: string[] = [];
  const valuelessFlags: string[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=");
    // A bare `--` (what `pnpm start -- …` passes through) has no name: skip it
    // without consuming the next argument, which is a real flag.
    if (!name) continue;
    if (!KNOWN_FLAGS.has(name)) {
      unknownFlags.push(`--${name}`);
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined) {
      valuelessFlags.push(`--${name}`);
      continue;
    }
    flags.set(name, value);
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
    unknownFlags,
    valuelessFlags,
  };
}

/**
 * Work started by a push handler that must not outlive the CLI.
 *
 * The completion answer is sent from a handler, not from the command loop, so
 * nothing would otherwise wait for it: a fast `:quit` could close the daemon
 * mid-send and lose the answer. `runCli` drains before it returns.
 */
export function createInFlight(): { track(work: Promise<unknown>): void; drain(): Promise<void> } {
  const pending = new Set<Promise<unknown>>();

  return {
    track(work: Promise<unknown>): void {
      // Swallowed here so a failing handler never becomes an unhandled rejection.
      const settled = work.then(
        () => undefined,
        () => undefined,
      );
      pending.add(settled);
      void settled.finally(() => pending.delete(settled));
    },
    async drain(): Promise<void> {
      // Handlers may track more work while we wait, so keep going until quiet.
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
  };
}

export const CLI_HELP = [  "命令：",
  "  :ask <文本>                          提交一次诊断请求（开始一个 Workflow）",
  "  :records                             列出自己的 Record",
  "  :show <record_id>                    看一条 Record 的完整内容",
  "  :report <record_id> [summary|full]   生成 Report（默认 full）",
  "  :export <record_id> [record|report]  导出到 KB（默认 record）",
  "  :blob <content_ref> <path>           取回 blob 并写到本地文件",
  "  :help / :quit",
].join("\n");

export interface CliIo {
  daemon: ClientDaemon;
  /** The queue owns printing too, so inbound lines never land inside a question. */
  prompts: PromptQueue;
  workspaceRoot: string;
}

/** The command loop: reads a line, runs a command, until `:quit` or EOF. */
export async function runCli(io: CliIo): Promise<void> {
  const { daemon, prompts, workspaceRoot } = io;
  const print = (line: string): void => prompts.print(line);
  const connection = daemon.connection;
  const inFlight = createInFlight();
  let quitting = false;

  connection.on("step.dispatch", (env) => print(renderDispatch(env.payload as StepDispatchPayload)));
  connection.on("workflow.terminated", (env) =>
    print(renderTerminated(env.payload as Parameters<typeof renderTerminated>[0])),
  );
  connection.on("workflow.completion_candidate", (env) => {
    // `workflow_id` is on the envelope, not in this payload (§7.2).
    const payload = env.payload as { summary?: string };
    const workflowId = env.workflow_id;
    // The Server proposes; only the human disposes (§7.2). Nothing here may
    // assume "solved" — an unanswered candidate is not a solved one. Tracked so
    // `runCli` waits for the answer before the caller closes the connection.
    inFlight.track(
      (async () => {
        print(`◇ 系统认为可能已完成：${payload.summary ?? "（未给出说明）"}`);
        let line: string | null;
        try {
          // Skipped if the human quits before this question's turn: a quit must
          // not be held up by a question that was queued behind it.
          line = await prompts.askUnless(() => quitting, "接受这个结论吗？[y/N] ");
        } catch {
          line = ""; // EOF: nobody is there to answer, which is not a "solved".
        }
        if (line === null) return; // quitting: the Server reclaims the workflow
        connection.send("workflow.completion_response", {
          workflow_id: workflowId,
          resolution: parseConfirmation(line) === true ? "solved" : "not_solved",
        });
        print(parseConfirmation(line) === true ? "已确认完成。" : "已反馈：尚未解决。");
      })(),
    );
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
      quitting = true;
      await inFlight.drain();
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
      quitting = true;
      await inFlight.drain();
      return;
    }
    await runCommand(command, { connection, print, workspaceRoot });
  }
}

async function runCommand(
  command: Command,
  io: { connection: ClientDaemon["connection"]; print: (line: string) => void; workspaceRoot: string },
): Promise<void> {
  const { connection, print, workspaceRoot } = io;

  try {
    switch (command.kind) {
      case "help":
        print(CLI_HELP);
        return;

      case "ask": {
        const payload = await connection.request(
          "workflow.request",
          {
            client_request_id: randomUUID(),
            user_request: { text: command.text, attachments: [], context: {} },
          },
          "workflow.created",
        );
        print(`已提交：Workflow ${String(payload.workflow_id)}`);
        return;
      }

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
 *
 * There is deliberately only ever **one** readline interface on stdin: a second
 * one would echo a password the hidden prompt is trying to hide, and would eat
 * the line the user typed next. Hiding is done by gating the single interface's
 * echo, not by starting another.
 */
export function readlinePrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Prompter & { close(): void; askHidden(question: string): Promise<string> } {
  let muted = false;
  const gate = new Writable({
    write(chunk: unknown, encoding: BufferEncoding, done: (error?: Error | null) => void) {
      if (!muted) output.write(chunk as string, encoding);
      done();
    },
  });
  const rl = createInterface({ input, output: gate, terminal: true });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  const ask = (question: string): Promise<string> => {
    if (closed) return Promise.reject(new Error("EOF"));
    return new Promise<string>((resolve, reject) => {
      const onClose = (): void => reject(new Error("EOF"));
      rl.once("close", onClose);
      rl.question(question, (answer) => {
        rl.off("close", onClose);
        resolve(answer);
      });
    });
  };

  return {
    ask,
    async askHidden(question: string): Promise<string> {
      // The prompt is ours to write; readline's echo of the answer is not.
      output.write(question);
      muted = true;
      try {
        return await ask("");
      } finally {
        muted = false;
        output.write("\n");
      }
    },
    print(line: string): void {
      output.write(`${line}\n`);
    },
    close(): void {
      rl.close();
    },
  };
}
