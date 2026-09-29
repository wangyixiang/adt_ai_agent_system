import { newSessionId } from "@adt/shared";
import type { Connection } from "../ws/connection";
import type { RouterSession, SessionResolver } from "../ws/messageRouter";

export interface Session {
  id: string;
  userId: string;
  connection: Connection;
  lastSeenAt: number;
}

export class SessionManager implements SessionResolver {
  private readonly byId = new Map<string, Session>();
  private readonly byConn = new Map<string, Session>();

  create(userId: string, connection: Connection): Session {
    const session: Session = {
      id: newSessionId(),
      userId,
      connection,
      lastSeenAt: Date.now(),
    };
    this.byId.set(session.id, session);
    this.byConn.set(connection.id, session);
    return session;
  }

  get(id: string): Session | null {
    return this.byId.get(id) ?? null;
  }

  byConnection(connectionId: string): RouterSession | null {
    return this.byConn.get(connectionId) ?? null;
  }

  touch(id: string): void {
    const session = this.byId.get(id);
    if (session) session.lastSeenAt = Date.now();
  }

  expire(id: string): void {
    const session = this.byId.get(id);
    if (!session) return;
    this.byId.delete(id);
    this.byConn.delete(session.connection.id);
    session.connection.dedup.clear();
  }

  all(): Session[] {
    return [...this.byId.values()];
  }
}
