import { writeFile } from "node:fs/promises";

/**
 * The testable half of "save as": the Electron save dialog lives in
 * `main/index.ts`, this just writes the bytes. Kept apart so the file write can
 * be unit-tested without Electron.
 */
export async function writeTextFile(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf8");
}
