import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Readable } from "node:stream";

/**
 * The bytes did not match what the upload declared. This is the one failure a
 * blob store must never paper over: a Record that references bytes different
 * from what it says would be worse than no record at all.
 */
export class BlobIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobIntegrityError";
  }
}

export interface BlobStoreExpectation {
  sha256: string;
  size: number;
  /** Hard ceiling: the write aborts the moment the stream crosses it. */
  maxBytes: number;
}

/**
 * The byte layer (ADR-004 §2): local filesystem behind an interface, addressed
 * by content. Streams in and out, so a 512 MiB blob never has to fit in memory.
 */
export interface BlobStore {
  write(
    source: Readable,
    expect: BlobStoreExpectation,
  ): Promise<{ sha256: string; size: number }>;
  read(sha256: string): Promise<Readable | null>;
  has(sha256: string): Promise<boolean>;
  delete(sha256: string): Promise<void>;
}

/** Sharded two levels deep, so no directory collects every blob. */
const pathFor = (root: string, sha256: string): string =>
  join(root, sha256.slice(0, 2), sha256);

export function createLocalBlobStore(root: string): BlobStore {
  const tmpDir = join(root, "tmp");

  const ensureDirs = async (): Promise<void> => {
    await mkdir(tmpDir, { recursive: true });
  };

  return {
    async write(source, expect) {
      await ensureDirs();

      const staging = join(tmpDir, randomUUID());
      const hash = createHash("sha256");
      let size = 0;
      let exceeded = false;

      const out = createWriteStream(staging);
      const write = (chunk: Buffer): Promise<void> =>
        new Promise((resolve, reject) => {
          out.write(chunk, (error) => (error ? reject(error) : resolve()));
        });

      try {
        for await (const raw of source) {
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
          size += chunk.length;
          if (size > expect.maxBytes) {
            exceeded = true;
            break;
          }
          hash.update(chunk);
          await write(chunk);
        }

        await new Promise<void>((resolve, reject) => {
          out.end((error?: Error | null) => (error ? reject(error) : resolve()));
        });
      } catch (error) {
        out.destroy();
        await rm(staging, { force: true });
        throw error;
      }

      // Aborting mid-stream leaves a partial file behind; drop it and say why.
      if (exceeded) {
        await rm(staging, { force: true });
        throw new BlobIntegrityError(
          `blob exceeds the maximum size of ${expect.maxBytes} bytes`,
        );
      }

      const actual = hash.digest("hex");
      if (actual !== expect.sha256) {
        await rm(staging, { force: true });
        throw new BlobIntegrityError(
          `sha256 mismatch: declared ${expect.sha256}, received ${actual}`,
        );
      }
      if (size !== expect.size) {
        await rm(staging, { force: true });
        throw new BlobIntegrityError(
          `size mismatch: declared ${expect.size} bytes, received ${size}`,
        );
      }

      const target = pathFor(root, actual);
      await mkdir(join(root, actual.slice(0, 2)), { recursive: true });
      // Same content written twice lands on the same path; rename is atomic and
      // idempotent for identical bytes.
      await rename(staging, target);
      return { sha256: actual, size };
    },

    async read(sha256) {
      try {
        await access(pathFor(root, sha256));
      } catch {
        return null;
      }
      return createReadStream(pathFor(root, sha256));
    },

    async has(sha256) {
      try {
        await access(pathFor(root, sha256));
        return true;
      } catch {
        return false;
      }
    },

    async delete(sha256) {
      await rm(pathFor(root, sha256), { force: true });
    },
  };
}
