import { createRequire } from "node:module";

/**
 * What the ledger knows about an `idempotency_key` (WORKFLOW_SPEC.md §4.3).
 *
 * `in_flight` is the state that makes a reconnect safe: the Server re-dispatches
 * the same step after `session.resume`, and a client that cannot confirm the
 * outcome must report `UNKNOWN` rather than execute a second time.
 */
export type LedgerState =
  | { state: "in_flight" }
  | { state: "done"; type: string; result: unknown };

/** The payload of a finished entry — what gets replayed as Evidence. */
export interface LedgerEntry {
  type: string;
  result: unknown;
}

export interface Ledger {
  /**
   * Whether entries survive a process restart. Resuming a logical session is
   * only safe when they do: the Server re-dispatches mid-flight steps, and an
   * empty ledger would look like "never seen" (see `stepRunner`).
   */
  readonly persistent: boolean;
  get(key: string): LedgerState | undefined;
  /** Written before a side effect starts, so a later re-dispatch knows. */
  markInFlight(key: string): void;
  markDone(key: string, type: string, result: unknown): void;
  /** For outcomes that did not happen (failed/rejected): not "unknown", just nothing. */
  clear(key: string): void;
  close(): void;
}

/** The slice of `node:sqlite` this module uses. */
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
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
 * The client-side idempotency ledger. It survives a process restart by design —
 * a daemon that crashed mid-reset cannot be trusted to know whether the reset
 * happened, but it can remember that it started one.
 *
 * Backed by `node:sqlite` (ADR-004 §3), so there is no native dependency.
 */
export function openLedger(location: string): Ledger {
  const db = new DatabaseSync(location);

  // A ledger from before the three-state change has two columns and only ever
  // recorded finished actions; migrate it rather than start over (a key that
  // was already executed must stay executed).
  const existing = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger'")
    .get() as { name?: string } | undefined;
  if (existing) {
    const columns = (db.prepare("PRAGMA table_info(ledger)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    if (!columns.includes("state")) {
      db.exec(`
        ALTER TABLE ledger RENAME TO ledger_legacy;
        CREATE TABLE ledger (key text PRIMARY KEY, state text NOT NULL, type text, result text);
        INSERT INTO ledger (key, state, type, result)
          SELECT key, 'done', type, result FROM ledger_legacy;
        DROP TABLE ledger_legacy;
      `);
    }
  }

  db.exec(
    `CREATE TABLE IF NOT EXISTS ledger (
       key    text PRIMARY KEY,
       state  text NOT NULL,
       type   text,
       result text
     )`,
  );

  const read = db.prepare("SELECT state, type, result FROM ledger WHERE key = ?");
  const write = db.prepare(
    `INSERT INTO ledger (key, state, type, result) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET state = excluded.state, type = excluded.type, result = excluded.result`,
  );
  const del = db.prepare("DELETE FROM ledger WHERE key = ?");

  return {
    persistent: location !== ":memory:",

    get(key: string): LedgerState | undefined {
      const row = read.get(key) as
        | { state: string; type: string | null; result: string | null }
        | undefined;
      if (!row) return undefined;
      if (row.state === "in_flight") return { state: "in_flight" };

      try {
        return {
          state: "done",
          type: String(row.type),
          result: JSON.parse(row.result ?? "null") as unknown,
        };
      } catch {
        // A `done` row we cannot read is *not* "never seen": the action
        // happened. Reporting it as in-flight makes the runner answer UNKNOWN
        // (WORKFLOW_SPEC.md §4.3) instead of running it a second time.
        console.warn(`[ledger] unreadable entry for ${key}; treating it as unconfirmed`);
        return { state: "in_flight" };
      }
    },

    markInFlight(key: string): void {
      write.run(key, "in_flight", null, null);
    },

    markDone(key: string, type: string, result: unknown): void {
      write.run(key, "done", type, JSON.stringify(result ?? null));
    },

    clear(key: string): void {
      del.run(key);
    },

    close(): void {
      db.close();
    },
  };
}
