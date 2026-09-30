import { describe, it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createLocalBlobStore, BlobIntegrityError } from "../../src/blob/store";

const sha = (data: Buffer): string => createHash("sha256").update(data).digest("hex");
const root = (): Promise<string> => mkdtemp(join(tmpdir(), "adt-blob-"));

const streamOf = (data: Buffer): Readable => Readable.from([data]);

describe("LocalBlobStore", () => {
  it("stores by content address and reads the same bytes back", async () => {
    const store = createLocalBlobStore(await root());
    const data = Buffer.from("can trace line 1\n");
    const digest = sha(data);

    const written = await store.write(streamOf(data), {
      sha256: digest,
      size: data.length,
      maxBytes: 1024,
    });

    expect(written).toEqual({ sha256: digest, size: data.length });
    expect(await store.has(digest)).toBe(true);

    const read = (await store.read(digest))!;
    const chunks: Buffer[] = [];
    for await (const chunk of read) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(data)).toBe(true);
  });

  it("returns null when the bytes are not there", async () => {
    const store = createLocalBlobStore(await root());
    expect(await store.read(sha(Buffer.from("nope")))).toBeNull();
    expect(await store.has(sha(Buffer.from("nope")))).toBe(false);
  });

  it("rejects a stream whose sha256 does not match the declaration", async () => {
    const store = createLocalBlobStore(await root());
    const real = Buffer.from("real");

    await expect(
      store.write(streamOf(real), {
        sha256: sha(Buffer.from("declared")),
        size: real.length,
        maxBytes: 1024,
      }),
    ).rejects.toBeInstanceOf(BlobIntegrityError);

    // The mismatching bytes must not be reachable under any name.
    expect(await store.has(sha(real))).toBe(false);
  });

  it("rejects a stream whose size does not match the declaration", async () => {
    const store = createLocalBlobStore(await root());
    const data = Buffer.from("12345");
    await expect(
      store.write(streamOf(data), { sha256: sha(data), size: 4, maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(await store.has(sha(data))).toBe(false);
  });

  it("aborts as soon as the stream exceeds maxBytes", async () => {
    const store = createLocalBlobStore(await root());
    const big = Buffer.alloc(4096, 1);

    await expect(
      store.write(streamOf(big), { sha256: sha(big), size: big.length, maxBytes: 1024 }),
    ).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(await store.has(sha(big))).toBe(false);
  });

  it("deletes stored bytes", async () => {
    const store = createLocalBlobStore(await root());
    const data = Buffer.from("x");
    const digest = sha(data);
    await store.write(streamOf(data), { sha256: digest, size: 1, maxBytes: 16 });
    await store.delete(digest);
    expect(await store.has(digest)).toBe(false);
  });
});
