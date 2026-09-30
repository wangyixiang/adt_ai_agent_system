import { DedupWindow, newSessionId } from "@adt/shared";
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
  /**
   * The physical connection currently bound to this logical session, or
   * `null` while the session is detached (disconnected but retained for
   * `session.resume`, PROTOCOL_SPEC.md §5.2).
   */
  connection: Connection | null;
  lastSeenAt: number;
  disconnectedAt: number | null;
  capabilities: CapabilityRegistry;
  /** Session-lifetime dedup window; survives reconnects (PROTOCOL_SPEC.md §2). */
  dedup: DedupWindow;
  /** `client_request_id` -> `workflow_id`, scoped to this session (PROTOCOL_SPEC.md §7.1). */
  clientRequests: Map<string, string>;
}

export interface SessionManagerOptions {
  /** Monotonic clock (PROTOCOL_SPEC.md §2/§9); defaults to `performance.now`. */
  now?: () => number;
  knownCapabilities?: ReadonlySet<string>;
  /** How long a detached session stays resumable (PROTOCOL_SPEC.md §5.2). */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 86_400_000;

/** Sentinel stored while a `client_request_id`'s workflow is being created. */
const IN_FLIGHT = "__in_flight__";

export class SessionManager implements SessionResolver {
  private readonly byId = new Map<string, Session>();
  private readonly byConn = new Map<string, Session>();
  private readonly now: () => number;
  private readonly known: ReadonlySet<string>;
  private readonly ttlMs: number;

  constructor(options: SessionManagerOptions = {}) {
    this.now = options.now ?? (() => Math.floor(performance.now()));
    this.known = options.knownCapabilities ?? KNOWN_CAPABILITIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  create(userId: string, connection: Connection): Session {
    // Re-handshake on the same connection replaces the old session rather
    // than orphaning it.
    const existing = this.byConn.get(connection.id);
    if (existing) this.expire(existing.id);

    const session: Session = {
      id: newSessionId(),
      userId,
      connection,
      lastSeenAt: this.now(),
      disconnectedAt: null,
      capabilities: new CapabilityRegistry(this.known),
      dedup: new DedupWindow(),
      clientRequests: new Map(),
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
    if (!session) return;
    session.lastSeenAt = this.now();
    // Activity on a bound connection means the session is alive again.
    if (session.connection) session.disconnectedAt = null;
  }

  isExpired(session: Session, now: number = this.now()): boolean {
    return session.disconnectedAt !== null && now - session.disconnectedAt > this.ttlMs;
  }

  /** Detaches the session from a closed physical connection; it stays resumable. */
  detach(connectionId: string): Session | null {
    const session = this.byConn.get(connectionId);
    if (!session) return null;
    this.byConn.delete(connectionId);
    session.connection = null;
    // Set-once: a heartbeat death may already have stamped the epoch, and the
    // later socket close must not push it forward — the session TTL and the
    // reclamation grace must count from the same moment.
    if (session.disconnectedAt === null) session.disconnectedAt = this.now();
    return session;
  }

  /** Marks a session disconnected without a socket close (heartbeat death). */
  markDisconnected(sessionId: string): void {
    const session = this.byId.get(sessionId);
    if (session && session.disconnectedAt === null) {
      session.disconnectedAt = this.now();
    }
  }

  /** Rebinds a live, non-expired session to a new connection (`session.resume`). */
  attach(sessionId: string, connection: Connection): Session | null {
    const session = this.byId.get(sessionId);
    if (!session || this.isExpired(session)) return null;

    // The connection may have been serving another session; release that one
    // so no session is left holding a connection it no longer owns.
    const occupant = this.byConn.get(connection.id);
    if (occupant && occupant.id !== session.id) {
      occupant.connection = null;
      if (occupant.disconnectedAt === null) occupant.disconnectedAt = this.now();
    }

    if (session.connection) this.byConn.delete(session.connection.id);
    session.connection = connection;
    session.disconnectedAt = null;
    session.lastSeenAt = this.now();
    this.byConn.set(connection.id, session);
    return session;
  }

  /** Removes and returns the ids of sessions past their TTL. */
  sweep(now: number = this.now()): string[] {
    const expired: string[] = [];
    for (const session of [...this.byId.values()]) {
      if (this.isExpired(session, now)) {
        this.expire(session.id);
        expired.push(session.id);
      }
    }
    return expired;
  }

  expire(id: string): void {
    const session = this.byId.get(id);
    if (!session) return;
    this.byId.delete(id);
    if (session.connection) this.byConn.delete(session.connection.id);
    session.dedup.clear();
  }

  all(): Session[] {
    return [...this.byId.values()];
  }

  capabilitiesOf(sessionId: string): Map<string, NormalizedCapability> {
    return this.byId.get(sessionId)?.capabilities.asMap() ?? new Map();
  }

  /**
   * Reserves a `client_request_id` before the async create, so two concurrent
   * requests cannot both miss and create a duplicate workflow. Returns false
   * when the id is already reserved or resolved.
   */
  tryReserveClientRequest(sessionId: string, clientRequestId: string): boolean {
    const requests = this.byId.get(sessionId)?.clientRequests;
    if (!requests || requests.has(clientRequestId)) return false;
    requests.set(clientRequestId, IN_FLIGHT);
    return true;
  }

  /** Records the workflow a `client_request_id` created (idempotency). */
  rememberClientRequest(sessionId: string, clientRequestId: string, workflowId: string): void {
    this.byId.get(sessionId)?.clientRequests.set(clientRequestId, workflowId);
  }

  /** Drops a reservation whose create failed, so a retry can succeed. */
  forgetClientRequest(sessionId: string, clientRequestId: string): void {
    this.byId.get(sessionId)?.clientRequests.delete(clientRequestId);
  }

  findClientRequest(sessionId: string, clientRequestId: string): string | null {
    const value = this.byId.get(sessionId)?.clientRequests.get(clientRequestId);
    return value === undefined || value === IN_FLIGHT ? null : value;
  }
}
