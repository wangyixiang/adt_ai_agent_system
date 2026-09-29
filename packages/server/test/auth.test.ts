import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { UserRepository } from "../src/auth/userRepository";
import { hashPassword, verifyPassword } from "../src/auth/password";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://adt:adt@localhost:55432/adt_test";

let pool: ReturnType<typeof createPool>;
let repo: UserRepository;

beforeAll(async () => {
  pool = createPool(url);
  await migrate(pool);
  await pool.query("TRUNCATE users");
  repo = new UserRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("password hashing", () => {
  it("verifies the correct secret and rejects a wrong one", async () => {
    const h = await hashPassword("s3cret");
    expect(h).not.toContain("s3cret");
    expect(await verifyPassword(h, "s3cret")).toBe(true);
    expect(await verifyPassword(h, "nope")).toBe(false);
  });
});

describe("UserRepository", () => {
  it("returns the user for correct credentials, null otherwise", async () => {
    await repo.create("alice", "pw-alice");
    expect((await repo.verifyCredentials("alice", "pw-alice"))?.username).toBe("alice");
    expect(await repo.verifyCredentials("alice", "wrong")).toBeNull();
    expect(await repo.verifyCredentials("ghost", "x")).toBeNull();
  });
});
