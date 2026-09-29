import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { createPool } from "./pool";

export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

export async function migrate(pool: pg.Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];

  for (const file of files) {
    const seen = await pool.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
    if (seen.rowCount) continue;

    const sql = await readFile(path.join(dir, file), "utf8");
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await pool.query("COMMIT");
      applied.push(file);
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
  }

  return applied;
}

const isMain = Boolean(process.argv[1]) && /migrate\.(ts|js)$/.test(process.argv[1]!);

if (isMain) {
  const pool = createPool(
    process.env.DATABASE_URL ?? "postgres://adt:adt@localhost:55432/adt",
  );
  migrate(pool)
    .then(async (applied) => {
      console.log(`applied: ${applied.length ? applied.join(", ") : "(none)"}`);
      await pool.end();
    })
    .catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exit(1);
    });
}
