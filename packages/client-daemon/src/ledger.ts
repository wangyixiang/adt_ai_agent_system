import { createRequire } from "node:module";

/** What is remembered for an `idempotency_key`: the Evidence to replay. */
export interface LedgerEntry {
  type: string;
  result: unknown;
}

export interface Ledger {
  get(key: string): LedgerEntry | undefined;
  set(key: string, entry: LedgerEntry): void;
  close(): void;
}

/** The slice of `node:sqlite` this module uses. */
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/**
 * `node:sqlite` is loaded with a runtime `require` on purpose: it is a Node
 * builtin, but `module.builtinModules` lists it only as `node:sqlite`, so a
 * bundler that strips the prefix looks for a file named `sqlite` and fails. A
 * static import would make every consumer (including the test runner) need a
 * bundler workaround for what is otherwise a plain builtin.
 */
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (location: string) => SqliteDatabase;
};

/**
 * The client-side idempotency ledger (WORKFLOW_SPEC.md §4.3). A side-effect step
 * whose key is already recorded must NOT run again: the Server may re-dispatch
 * the same step after a reconnect (`session.resume` carries `pending_step`), and
 * repeating an action that already happened is exactly what the key prevents.
 *
 * It survives a process restart by design — a daemon that crashed mid-reset
 * cannot be trusted to know whether the reset happened, but it can remember
 * what it reported.
 *
 * Backed by `node:sqlite` (ADR-004 §3), so there is no native dependency.
 */
export function openLedger(location: string): Ledger {
  const db = new DatabaseSync(location);
  db.exec(
    `CREATE TABLE IF NOT EXISTS ledger (
       key    text PRIMARY KEY,
       type   text NOT NULL,
       result text NOT NULL
     )`,
  );

  const read = db.prepare("SELECT type, result FROM ledger WHERE key = ?");
  const write = db.prepare(
    "INSERT INTO ledger (key, type, result) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET type = excluded.type, result = excluded.result",
  );

  return {
    get(key: string): LedgerEntry | undefined {
      const row = read.get(key) as { type: string; result: string } | undefined;
      if (!row) return undefined;
      try {
        return { type: row.type, result: JSON.parse(row.result) as unknown };
      } catch {
        // A corrupted row must not throw out of the step runner (that would
        // leave the step without a status). Treat it as "no record" — the
        // action is re-confirmed rather than silently replayed.
        console.warn(`[ledger] unreadable entry for ${key}; ignoring it`);
        return undefined;
      }
    },
    set(key: string, entry: LedgerEntry): void {
      write.run(key, entry.type, JSON.stringify(entry.result ?? null));
    },
    close(): void {
      db.close();
    },
  };
}
