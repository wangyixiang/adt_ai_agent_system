import type { AddressInfo } from "node:net";
import {
  createPool,
  createServer,
  migrate,
  UserRepository,
  type NormalizedCapability,
  type Pool,
  type SessionManager,
} from "@adt/server";

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://adt:adt@localhost:55432/adt_test";

export interface TestServerOptions {
  heartbeatIntervalMs?: number;
  maxMissed?: number;
}

export interface TestServer {
  url: string;
  deadSessions: string[];
  sessions: SessionManager;
  capabilities(sessionId: string): Map<string, NormalizedCapability>;
  warnings(sessionId: string): string[];
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const pool: Pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
  await pool.query("TRUNCATE users");

  const users = new UserRepository(pool);
  await users.create("alice", "pw-alice");

  const deadSessions: string[] = [];
  const server = await createServer({
    pool,
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 15000,
    maxMissed: opts.maxMissed ?? 3,
    onSessionDead: (sessionId) => {
      if (!deadSessions.includes(sessionId)) deadSessions.push(sessionId);
    },
  });

  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const port = (server.app.server.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    deadSessions,
    sessions: server.sessions,
    capabilities: (sessionId: string) => server.sessions.capabilitiesOf(sessionId),
    warnings: (sessionId: string) => server.sessions.get(sessionId)?.connection.warnings ?? [],
    waitFor: async (predicate: () => boolean, timeoutMs = 5000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("waitFor timed out");
    },
    close: async () => {
      await server.close();
      await pool.end();
    },
  };
}
