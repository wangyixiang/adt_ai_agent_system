import { decodeEnvelope, makeError, type Envelope, type ErrorCode } from "@adt/shared";
import type { Connection } from "./connection";
import type { Session } from "../session/sessionManager";

export interface SessionResolver {
  byConnection(connectionId: string): Session | null;
}

export interface MessageContext {
  conn: Connection;
  session: Session | null;
}

export type MessageHandler = (
  ctx: MessageContext,
  env: Envelope,
) => Promise<void> | void;

export class MessageRouter {
  private readonly handlers = new Map<string, MessageHandler>();

  constructor(private readonly resolver: SessionResolver) {}

  register(type: string, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  async handle(conn: Connection, raw: string | Buffer): Promise<void> {
    let env: Envelope;
    try {
      env = decodeEnvelope(raw);
    } catch (error) {
      this.sendError(conn, null, "malformed_payload", (error as Error).message, null);
      return;
    }

    if (conn.dedup.has(env.message_id)) {
      conn.warn(`duplicate message_id ${env.message_id}`);
      return;
    }
    conn.dedup.add(env.message_id);

    const session = this.resolver.byConnection(conn.id);

    // Post-handshake messages must carry the authenticated user (ADR-003 §3).
    if (session && env.user_id !== session.userId) {
      this.sendError(
        conn,
        session,
        "malformed_payload",
        "user_id missing or does not match the authenticated user",
        env.message_id,
      );
      return;
    }

    const handler = this.handlers.get(env.type);
    if (!handler) {
      this.sendError(
        conn,
        session,
        "unknown_message_type",
        `no handler registered for ${env.type}`,
        env.message_id,
      );
      return;
    }

    try {
      await handler({ conn, session }, env);
    } catch (error) {
      // A handler failure must not take down the process (an unhandled
      // rejection would). Warn on the connection and keep it alive.
      const detail = error instanceof Error ? error.message : String(error);
      conn.warn(`handler error for ${env.type}: ${detail}`);
      console.error(`[router] handler for ${env.type} threw:`, error);
    }
  }

  private sendError(
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
  }
}
