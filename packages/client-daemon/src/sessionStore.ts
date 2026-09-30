import { createRequire } from "node:module";

export interface RememberedSession {
  sessionId: string;
  userId: string;
}

export interface SessionStore {
  save(session: RememberedSession): void;
  load(): RememberedSession | null;
  clear(): void;
  close(): void;
}

interface SqliteStatement {
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

// See ledger.ts: `node:sqlite` cannot be resolved statically by the bundler.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (location: string) => SqliteDatabase;
};

/**
 * Remembers the logical session a daemon was last bound to, so a reconnect can
 * ask to resume it instead of starting a new one (PROTOCOL_SPEC.md §5.2,
 * REQUIREMENTS.md NFR-3). Only one session is ever live, so the table holds a
 * single row.
 */
export function openSessionStore(location: string): SessionStore {
  const db = new DatabaseSync(location);
  db.exec(
    `CREATE TABLE IF NOT EXISTS session (
       id         text PRIMARY KEY,
       session_id text NOT NULL,
       user_id    text NOT NULL
     )`,
  );

  const read = db.prepare("SELECT session_id, user_id FROM session WHERE id = 'current'");
  const write = db.prepare(
    `INSERT INTO session (id, session_id, user_id) VALUES ('current', ?, ?)
     ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, user_id = excluded.user_id`,
  );
  const del = db.prepare("DELETE FROM session WHERE id = 'current'");

  return {
    save(session) {
      write.run(session.sessionId, session.userId);
    },
    load() {
      const row = read.get() as { session_id: string; user_id: string } | undefined;
      return row ? { sessionId: row.session_id, userId: row.user_id } : null;
    },
    clear() {
      del.run();
    },
    close() {
      db.close();
    },
  };
}
