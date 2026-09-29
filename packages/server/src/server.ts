import type { FastifyInstance } from "fastify";
import type { Pool } from "./db/pool";
import { buildServer } from "./http/app";
import { KNOWN_CAPABILITIES } from "./capability/known";
import { registerCapabilitySync } from "./capability/handler";
import { registerHandshake } from "./session/handshake";
import { SessionManager } from "./session/sessionManager";
import { UserRepository } from "./auth/userRepository";
import { HeartbeatMonitor, registerHeartbeat } from "./ws/heartbeat";
import { MessageRouter } from "./ws/messageRouter";

export interface CreateServerOptions {
  pool: Pool;
  heartbeatIntervalMs?: number;
  maxMissed?: number;
  /** How long a disconnected session stays resumable (PROTOCOL_SPEC.md §5.2). */
  sessionTtlMs?: number;
  onSessionDead?: (sessionId: string) => void;
  /** Heartbeat activity revived a session (cancel a pending reclamation). */
  onSessionAlive?: (sessionId: string) => void;
  knownCapabilities?: ReadonlySet<string>;
}

export interface CreatedServer {
  app: FastifyInstance;
  router: MessageRouter;
  sessions: SessionManager;
  monitor: HeartbeatMonitor;
  close(): Promise<void>;
}

/**
 * Single place where the server's handlers are wired, shared by the
 * production entry point and the test harness so they cannot drift.
 */
export async function createServer(opts: CreateServerOptions): Promise<CreatedServer> {
  const heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 15000;
  const maxMissed = opts.maxMissed ?? 3;
  const notifyDead = opts.onSessionDead ?? (() => {});
  const notifyAlive = opts.onSessionAlive ?? (() => {});

  const sessions = new SessionManager({
    knownCapabilities: opts.knownCapabilities ?? KNOWN_CAPABILITIES,
    ttlMs: opts.sessionTtlMs,
  });
  const router = new MessageRouter(sessions);

  registerHandshake(router, {
    users: new UserRepository(opts.pool),
    sessions,
    heartbeatIntervalMs,
  });
  registerCapabilitySync(router);
  registerHeartbeat(router, sessions, notifyAlive);

  const monitor = new HeartbeatMonitor(sessions, {
    intervalMs: heartbeatIntervalMs,
    maxMissed,
    onDead: (sessionId) => {
      // A missed-heartbeat session is disconnected but stays resumable.
      sessions.markDisconnected(sessionId);
      notifyDead(sessionId);
    },
  });
  monitor.start();

  const app = await buildServer({
    router,
    onConnectionClosed: (conn) => {
      const session = sessions.detach(conn.id);
      if (session) notifyDead(session.id);
    },
  });

  return {
    app,
    router,
    sessions,
    monitor,
    close: async () => {
      monitor.stop();
      await app.close();
    },
  };
}
