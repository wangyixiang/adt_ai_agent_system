import { type Envelope, PROTOCOL_VERSION } from "./envelope";
import { newMessageId, nowUtcIso } from "./ids";

export type ErrorCode =
  | "unsupported_version"
  | "session_expired"
  | "auth_failed"
  | "unknown_message_type"
  | "malformed_payload"
  | "unknown_workflow"
  | "unknown_step"
  | "unknown_record"
  | "blob_rejected";

export type Disposition = "fatal" | "request" | "ignore";

/**
 * PROTOCOL_SPEC.md §12 disposition matrix.
 * fatal   -> close the connection (or re-handshake)
 * request -> fail the originating request, keep the connection
 * ignore  -> drop the message and warn, never disconnect
 */
export const ERROR_DISPOSITION: Record<ErrorCode, Disposition> = {
  unsupported_version: "fatal",
  session_expired: "fatal",
  auth_failed: "fatal",
  unknown_message_type: "ignore",
  malformed_payload: "request",
  unknown_workflow: "request",
  unknown_step: "request",
  unknown_record: "request",
  blob_rejected: "request",
};

export function makeError(
  code: ErrorCode,
  message: string,
  inReplyTo: string | null,
): Envelope {
  return {
    protocol_version: PROTOCOL_VERSION,
    message_id: newMessageId(),
    session_id: null,
    workflow_id: null,
    user_id: null,
    type: "protocol.error",
    ts: nowUtcIso(),
    in_reply_to: inReplyTo,
    payload: { code, message },
  };
}
