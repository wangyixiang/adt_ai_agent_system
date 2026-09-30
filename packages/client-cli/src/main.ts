import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";

import { ClientDaemon, openLedger, openSessionStore } from "@adt/client-daemon";

import {
  buildHostCallbacks,
  createPromptQueue,
  parseArgs,
  readlinePrompter,
  runCli,
} from "./console";

/**
 * Reads a secret without echoing it. A password on argv is visible to `ps`, so
 * `--secret` is a convenience rather than the only way in.
 *
 * The echo is muted by pointing readline at a stream that swallows writes —
 * no private readline internals are touched.
 */
async function askSecretWithoutEcho(): Promise<string> {
  const muted = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });

  return new Promise<string>((resolve) => {
    process.stdout.write("密码（不回显）：");
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.username === "") {
    process.stderr.write("用法：client-cli --user <用户名> [--url ws://host:port/ws] ...\n");
    process.exitCode = 2;
    return;
  }

  const terminal = readlinePrompter(process.stdin, process.stdout);
  const prompts = createPromptQueue(terminal);
  const print = (line: string): void => terminal.print(line);

  const secret = args.secret ?? (await askSecretWithoutEcho());
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
    await runCli({ daemon, prompts, print, workspaceRoot: args.workspaceRoot });
  } finally {
    await daemon.close();
    terminal.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
