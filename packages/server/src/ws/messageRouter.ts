import { decodeEnvelope, type Envelope } from "@adt/shared";
import type { Connection } from "./connection";
import type { Session } from "../session/sessionManager";
import { sendError } from "./errors";

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
      sendError(conn, null, "malformed_payload", (error as Error).message, null);
      return;
    }

    if (conn.dedup.has(env.message_id)) {
      conn.warn(`duplicate message_id ${env.message_id}`);
      return;
    }
    conn.dedup.add(env.message_id);

    const session = this.resolver.byConnection(conn.id);

    // Post-handshake messages must carry the authenticated user and session
    // (ADR-003 §3, PROTOCOL_SPEC.md §2).
    if (
      session &&
      (env.user_id !== session.userId || env.session_id !== session.id)
    ) {
      sendError(
        conn,
        session,
        "malformed_payload",
        "user_id or session_id missing or does not match the authenticated session",
        env.message_id,
      );
      return;
    }

    const handler = this.handlers.get(env.type);
    if (!handler) {
      conn.warn(`unknown message type: ${env.type}`);
      sendError(
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
}
