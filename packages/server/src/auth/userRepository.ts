import type pg from "pg";
import { newUserId } from "@adt/shared";
import { hashPassword, verifyPassword } from "./password";

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  disabled: boolean;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  disabled: boolean;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    disabled: row.disabled,
  };
}

let dummyHash: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  return dummyHash;
}

export class UserRepository {
  constructor(private readonly pool: pg.Pool) {}

  async findByUsername(username: string): Promise<User | null> {
    const result = await this.pool.query<UserRow>(
      "SELECT id, username, password_hash, disabled FROM users WHERE username = $1",
      [username],
    );
    const row = result.rows[0];
    return row ? toUser(row) : null;
  }

  /** Idempotent upsert so repeated seeding (tests, bootstrap) does not fail. */
  async create(username: string, secret: string): Promise<User> {
    const passwordHash = await hashPassword(secret);
    const result = await this.pool.query<UserRow>(
      `INSERT INTO users (id, username, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING id, username, password_hash, disabled`,
      [newUserId(), username, passwordHash],
    );
    return toUser(result.rows[0]!);
  }

  async verifyCredentials(username: string, secret: string): Promise<User | null> {
    const user = await this.findByUsername(username);
    // Always verify once, even for unknown users, to keep timing uniform.
    const ok = await verifyPassword(user?.passwordHash ?? (await getDummyHash()), secret);
    if (!user || user.disabled || !ok) return null;
    return user;
  }

  /** Usernames and their enabled/disabled state — never the hash. */
  async list(): Promise<Array<{ username: string; disabled: boolean }>> {
    const result = await this.pool.query<{ username: string; disabled: boolean }>(
      "SELECT username, disabled FROM users ORDER BY username",
    );
    return result.rows;
  }

  /** Enables/disables an account. `true` when a row was changed. */
  async setDisabled(username: string, disabled: boolean): Promise<boolean> {
    const result = await this.pool.query("UPDATE users SET disabled = $2 WHERE username = $1", [
      username,
      disabled,
    ]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Does this username exist? (Used to refuse a silent password reset.) */
  async exists(username: string): Promise<boolean> {
    const result = await this.pool.query("SELECT 1 FROM users WHERE username = $1", [username]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Replaces an account's password. `true` when a row was changed. */
  async changePassword(username: string, secret: string): Promise<boolean> {
    const passwordHash = await hashPassword(secret);
    const result = await this.pool.query("UPDATE users SET password_hash = $2 WHERE username = $1", [
      username,
      passwordHash,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
}
