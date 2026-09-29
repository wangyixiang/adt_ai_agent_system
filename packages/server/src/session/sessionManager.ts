import { newSessionId } from "@adt/shared";
import type { Connection } from "../ws/connection";
import type { SessionResolver } from "../ws/messageRouter";
import {
  CapabilityRegistry,
  type NormalizedCapability,
} from "../capability/capabilityRegistry";
import { KNOWN_CAPABILITIES } from "../capability/known";

export interface Session {
  id: string;
  userId: string;
  connection: Connection;
  lastSeenAt: number;
  capabilities: CapabilityRegistry;
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
      capabilities: new CapabilityRegistry(KNOWN_CAPABILITIES),
    };
    this.byId.set(session.id, session);
    this.byConn.set(connection.id, session);
    return session;
  }

  get(id: string): Session | null {
    return this.byId.get(id) ?? null;
  }

  byConnection(connectionId: string): Session | null {
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

  capabilitiesOf(sessionId: string): Map<string, NormalizedCapability> {
    return this.byId.get(sessionId)?.capabilities.asMap() ?? new Map();
  }
}
