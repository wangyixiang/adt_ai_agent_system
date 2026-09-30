/**
 * The blob channel's wire types (PROTOCOL_SPEC.md §7.5). Large or binary
 * evidence (logs, screenshots) never travels inside the main protocol: the
 * message carries a reference, and the bytes move over a signed URL.
 */

export type BlobDirection = "upload" | "download";

/**
 * The reference that lives inside `evidence.result` (or `attachments`), and
 * that the Record keeps so the evidence stays retraceable.
 */
export interface BlobRef {
  /** `blob_<uuid>` (see `newContentRefId`). */
  content_ref: string;
  media_type: string;
  size: number;
  sha256: string;
  name?: string;
}

/**
 * `blob.allocate_request` — the ask that precedes any transfer. An `upload`
 * declares what will be sent (so the Server can refuse early); a `download`
 * names what is wanted.
 */
export interface BlobAllocatePayload {
  direction: BlobDirection;
  /** Required for `download`; ignored for `upload`. */
  content_ref?: string;
  /** Required for `upload`. */
  name?: string;
  media_type?: string;
  size?: number;
  sha256?: string;
}

/**
 * `blob.allocate_response` — where to send/collect the bytes. The URL carries
 * a signed token (no server-side session state), and expires.
 */
export interface BlobAllocateResponse {
  content_ref: string;
  url: string;
  /** ISO-8601 instant. */
  expires_at: string;
}
