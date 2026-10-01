import { createInterface } from "node:readline";

import { UserRepository } from "../auth/userRepository";
import { loadServerEnv } from "../config";
import { createPool } from "../db/pool";

/** The slice of `UserRepository` the CLI needs; kept narrow so it is easy to fake. */
export interface AdmUsers {
  create(username: string, secret: string): Promise<unknown>;
  list(): Promise<Array<{ username: string; disabled: boolean }>>;
  setDisabled(username: string, disabled: boolean): Promise<boolean>;
  changePassword(username: string, secret: string): Promise<boolean>;
}

export interface AdmIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  "用法：adm user add <name> [--secret <s>] [--force]",
  "      adm user list",
  "      adm user passwd <name> [--secret <s>]",
  "      adm user disable|enable <name>",
].join("\n");

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/**
 * The account-administration CLI's logic, separated from the database and the
 * terminal so it can be tested without either. Returns the process exit code:
 * 0 success, 2 usage error, 1 runtime error. **Never** prints a secret or a hash.
 */
export async function runAdm(
  argv: readonly string[],
  users: AdmUsers,
  io: AdmIo,
  fallbackSecret?: string,
): Promise<number> {
  const [group, command, name] = argv;
  if (group !== "user" || command === undefined) {
    io.err(USAGE);
    return 2;
  }
  const rest = argv.slice(3);
  const secret = flagValue(rest, "--secret") ?? fallbackSecret;

  switch (command) {
    case "list": {
      const rows = await users.list();
      if (rows.length === 0) io.out("（没有用户）");
      for (const row of rows) io.out(`${row.username}\t${row.disabled ? "disabled" : "active"}`);
      return 0;
    }

    case "add": {
      if (name === undefined) {
        io.err(USAGE);
        return 2;
      }
      if (secret === undefined) {
        io.err("缺少口令：--secret <s>、ADT_SECRET，或交互输入");
        return 2;
      }
      try {
        await users.create(name, secret);
      } catch {
        // An existing account is not silently reset — that would be a surprise.
        if (!rest.includes("--force")) {
          io.err(`用户 ${name} 已存在（重置口令请用 user passwd，或加 --force）`);
          return 1;
        }
        if (!(await users.changePassword(name, secret))) {
          io.err(`用户 ${name} 已存在但重置失败`);
          return 1;
        }
      }
      io.out(`已创建用户 ${name}`);
      return 0;
    }

    case "passwd": {
      if (name === undefined) {
        io.err(USAGE);
        return 2;
      }
      if (secret === undefined) {
        io.err("缺少口令：--secret <s>、ADT_SECRET，或交互输入");
        return 2;
      }
      if (!(await users.changePassword(name, secret))) {
        io.err(`用户 ${name} 不存在`);
        return 1;
      }
      io.out(`已更新用户 ${name} 的口令`);
      return 0;
    }

    case "disable":
    case "enable": {
      if (name === undefined) {
        io.err(USAGE);
        return 2;
      }
      if (!(await users.setDisabled(name, command === "disable"))) {
        io.err(`用户 ${name} 不存在`);
        return 1;
      }
      io.out(`已${command === "disable" ? "停用" : "启用"}用户 ${name}`);
      return 0;
    }

    default:
      io.err(USAGE);
      return 2;
  }
}

/** Reads a secret from the terminal without echoing it. */
async function promptSecret(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  // `_writeToOutput` is Node's own echo hook; muting it hides the keystrokes.
  const internal = rl as unknown as { _writeToOutput?: (text: string) => void };
  const original = internal._writeToOutput;
  internal._writeToOutput = () => undefined;
  process.stderr.write("口令（不回显）：");
  return new Promise((resolve) => {
    rl.question("", (answer) => {
      internal._writeToOutput = original;
      process.stderr.write("\n");
      rl.close();
      resolve(answer);
    });
  });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  loadServerEnv();
  const pool = createPool(process.env.DATABASE_URL ?? "postgres://adt:adt@localhost:55432/adt");
  const io: AdmIo = { out: (line) => console.log(line), err: (line) => console.error(line) };
  try {
    const command = argv[1];
    const needsSecret = command === "add" || command === "passwd";
    let fallback = process.env.ADT_SECRET;
    if (needsSecret && !argv.includes("--secret") && (fallback === undefined || fallback === "")) {
      fallback = await promptSecret();
    }
    return await runAdm(argv, new UserRepository(pool), io, fallback);
  } finally {
    await pool.end();
  }
}

const isMain = Boolean(process.argv[1]) && /adm\.(ts|js)$/.test(process.argv[1]!);
if (isMain) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
