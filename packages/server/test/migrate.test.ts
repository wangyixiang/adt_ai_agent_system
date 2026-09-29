import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPool } from "../src/db/pool";
import { migrate } from "../src/db/migrate";
import { TEST_DATABASE_URL } from "@adt/test-support";

describe("migrations", () => {
  it("rolls back a failing migration and leaves nothing behind", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "adt-mig-"));
    await writeFile(
      path.join(dir, "001_partial.sql"),
      "CREATE TABLE mig_partial (id int); CREATE TABLE mig_partial (id int);",
    );

    const pool = createPool(TEST_DATABASE_URL);
    await pool.query("DROP TABLE IF EXISTS mig_partial");

    await expect(migrate(pool, dir)).rejects.toThrow();

    const result = await pool.query<{ t: string | null }>(
      "SELECT to_regclass('public.mig_partial') AS t",
    );
    expect(result.rows[0]!.t).toBeNull();

    await pool.end();
  });
});
