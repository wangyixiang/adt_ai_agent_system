import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ClientDaemon, openLedger, openSessionStore } from "@adt/client-daemon";

import {
  buildHostCallbacks,
  createPromptQueue,
  parseArgs,
  readlinePrompter,
  runCli,
} from "./console";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // A typo should say so — the usage line alone does not tell you which flag it was.
  if (args.unknownFlags.length > 0) {
    process.stderr.write(`未知参数（已忽略）：${args.unknownFlags.join(" ")}\n`);
  }
  if (args.valuelessFlags.length > 0) {
    process.stderr.write(`缺少值的参数（已用默认值）：${args.valuelessFlags.join(" ")}\n`);
  }
  if (args.username === "") {
    process.stderr.write("用法：client-cli --user <用户名> [--url ws://host:port/ws] ...\n");
    process.exitCode = 2;
    return;
  }

  // One interface for the whole session — the hidden prompt is hidden by gating
  // this one's echo, never by starting a second readline on the same stdin.
  const terminal = readlinePrompter(process.stdin, process.stdout);
  const prompts = createPromptQueue(terminal);
  const print = (line: string): void => prompts.print(line);

  // A password on argv is visible to `ps`, so `--secret` is a convenience
  // rather than the only way in.
  const secret = args.secret ?? (await terminal.askHidden("密码（不回显）："));
  if (secret === "") {
    process.stderr.write("没有拿到密码。\n");
    process.exitCode = 2;
    terminal.close();
    return;
  }

  // Both stores are file-backed by default: the daemon only resumes a session
  // when its idempotency ledger is persistent, and a re-dispatched side effect
  // must never run twice.
  for (const path of [args.ledgerPath, args.sessionPath]) {
    await mkdir(dirname(resolve(path)), { recursive: true });
  }

  const daemon = await ClientDaemon.connect({
    url: args.url,
    credentials: { username: args.username, secret },
    clientInfo: { name: "adt-client-cli", platform: process.platform },
    workspaceRoot: args.workspaceRoot,
    ledger: openLedger(args.ledgerPath),
    sessionStore: openSessionStore(args.sessionPath),
    ...buildHostCallbacks(prompts, print),
  });

  try {
    await runCli({ daemon, prompts, workspaceRoot: args.workspaceRoot });
  } finally {
    await daemon.close();
    terminal.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
