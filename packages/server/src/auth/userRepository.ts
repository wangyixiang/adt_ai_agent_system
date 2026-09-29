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
}
