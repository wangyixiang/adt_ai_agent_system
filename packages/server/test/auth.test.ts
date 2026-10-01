import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { UserRepository } from "../src/auth/userRepository";
import { hashPassword, verifyPassword } from "../src/auth/password";
import { runAdm } from "../src/cli/adm";

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

  it("lists users without hashes, and a disabled user cannot log in", async () => {
    await repo.create("adm_probe", "pw-old");
    const listed = await repo.list();
    const probe = listed.find((u) => u.username === "adm_probe");
    expect(probe).toEqual({ username: "adm_probe", disabled: false });
    expect(Object.keys(listed[0]!)).toEqual(["username", "disabled"]);

    expect(await repo.setDisabled("adm_probe", true)).toBe(true);
    expect(await repo.verifyCredentials("adm_probe", "pw-old")).toBeNull();
    expect(await repo.setDisabled("adm_probe", false)).toBe(true);

    expect(await repo.changePassword("adm_probe", "pw-new")).toBe(true);
    expect(await repo.verifyCredentials("adm_probe", "pw-old")).toBeNull();
    expect(await repo.verifyCredentials("adm_probe", "pw-new")).not.toBeNull();

    expect(await repo.setDisabled("nobody", true)).toBe(false);
    expect(await repo.changePassword("nobody", "x")).toBe(false);
  });

  it("adm user add refuses an existing account, against the real repository", async () => {
    // The fake catches this trivially; the real `create` is an upsert that does
    // NOT throw, so only an explicit existence check prevents a silent reset.
    await repo.create("adm_add_probe", "original");
    const io = { out: () => undefined, err: () => undefined };
    expect(await runAdm(["user", "add", "adm_add_probe", "--secret", "changed"], repo, io)).toBe(1);
    expect(await repo.verifyCredentials("adm_add_probe", "original")).not.toBeNull();
    expect(await repo.verifyCredentials("adm_add_probe", "changed")).toBeNull();
  });
});
