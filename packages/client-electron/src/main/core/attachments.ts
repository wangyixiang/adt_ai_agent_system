import type { IncomingAttachment } from "../../shared/contract";

/** One request may carry at most this many attachments. */
export const MAX_ATTACHMENTS = 10;
/** …and at most this many bytes in total. */
export const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** At or below this, an attachment rides inline; above it, it goes over blob. */
export const INLINE_THRESHOLD_BYTES = 64 * 1024;

/** Mirrors the Server's `DEFAULT_ALLOWED_MEDIA_TYPES` (server/src/blob/config.ts). */
export const ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/zip",
  "application/gzip",
  "application/octet-stream",
  "image/png",
  "image/jpeg",
]);

/** A type we cannot place is sent as opaque bytes; the Server whitelist is the backstop. */
export function normalizeMediaType(raw: string): string {
  return ALLOWED_MEDIA_TYPES.has(raw) ? raw : "application/octet-stream";
}

export type AttachmentRejection = { ok: false; code: "too_many" | "too_large"; message: string };

export function checkAttachments(incoming: readonly IncomingAttachment[]): { ok: true } | AttachmentRejection {
  if (incoming.length > MAX_ATTACHMENTS) {
    return { ok: false, code: "too_many", message: `最多 ${MAX_ATTACHMENTS} 个附件（收到 ${incoming.length}）` };
  }
  const total = incoming.reduce((sum, item) => sum + Buffer.from(item.dataBase64, "base64").length, 0);
  if (total > MAX_TOTAL_BYTES) {
    return { ok: false, code: "too_large", message: `附件总量超过 ${MAX_TOTAL_BYTES} 字节` };
  }
  return { ok: true };
}

/** Inline for small payloads, blob for the rest (PROTOCOL_SPEC §7.5). */
export function planAttachment(bytes: Uint8Array): { mode: "inline" } | { mode: "blob" } {
  return bytes.length <= INLINE_THRESHOLD_BYTES ? { mode: "inline" } : { mode: "blob" };
}
