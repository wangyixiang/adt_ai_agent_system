import { ERROR_DISPOSITION, makeError, type ErrorCode } from "@adt/shared";
import type { Connection } from "./connection";
import type { Session } from "../session/sessionManager";

/**
 * Single path for emitting `protocol.error`, so post-handshake errors always
 * carry `session_id` / `user_id` (PROTOCOL_SPEC.md §2) and disposal follows
 * the `ERROR_DISPOSITION` matrix (PROTOCOL_SPEC.md §12): `fatal` closes the
 * connection, `request` / `ignore` leave it open.
 */
export function sendError(
  conn: Connection,
  session: Session | null,
  code: ErrorCode,
  message: string,
  inReplyTo: string | null,
): void {
  const envelope = makeError(code, message, inReplyTo);
  if (session) {
    envelope.session_id = session.id;
    envelope.user_id = session.userId;
  }
  conn.send(envelope);
  if (ERROR_DISPOSITION[code] === "fatal") conn.close();
}
