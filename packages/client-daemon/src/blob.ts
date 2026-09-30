import { createHash } from "node:crypto";
import type { BlobRef } from "@adt/shared";
import type { DaemonConnection } from "./connection";

export interface BlobClientDeps {
  connection: Pick<DaemonConnection, "request">;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Uploads bytes over the blob channel (PROTOCOL_SPEC.md §7.5) and returns the
 * reference to put in evidence. The bytes only count as stored once the HTTP
 * response says so — that is what makes the reference safe to report.
 */
export async function uploadBlob(
  deps: BlobClientDeps,
  input: { name: string; mediaType: string; bytes: Uint8Array },
): Promise<BlobRef> {
  const sha256 = sha256Hex(input.bytes);
  const allocation = await deps.connection.request(
    "blob.allocate_request",
    {
      direction: "upload",
      name: input.name,
      media_type: input.mediaType,
      size: input.bytes.length,
      sha256,
    },
    "blob.allocate_response",
  );

  const response = await (deps.fetchImpl ?? fetch)(String(allocation.url), {
    method: "PUT",
    headers: { "content-type": input.mediaType },
    body: input.bytes,
  });
  if (!response.ok) {
    throw new Error(`blob upload failed: ${response.status} ${await response.text()}`);
  }

  return {
    content_ref: String(allocation.content_ref),
    media_type: input.mediaType,
    size: input.bytes.length,
    sha256,
    name: input.name,
  };
}

/** Fetches the bytes a Record cited, so the evidence stays readable. */
export async function downloadBlob(deps: BlobClientDeps, contentRef: string): Promise<Buffer> {
  const allocation = await deps.connection.request(
    "blob.allocate_request",
    { direction: "download", content_ref: contentRef },
    "blob.allocate_response",
  );

  const response = await (deps.fetchImpl ?? fetch)(String(allocation.url));
  if (!response.ok) {
    throw new Error(`blob download failed: ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  // The server tells us what it sent; a mangled transfer must not look like a
  // successful fetch (the whole point of the reference is that it is true).
  const expected = response.headers.get("x-blob-sha256");
  if (expected !== null && sha256Hex(bytes) !== expected) {
    throw new Error("blob download failed: sha256 mismatch");
  }
  return bytes;
}
