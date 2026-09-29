import type { AddressInfo } from "node:net";
import {
  buildServer,
  createPool,
  MessageRouter,
  migrate,
  registerHandshake,
  SessionManager,
  UserRepository,
  type Pool,
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
  warnings(sessionId: string): string[];
  close(): Promise<void>;
}

export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const pool: Pool = createPool(TEST_DATABASE_URL);
  await migrate(pool);
  await pool.query("TRUNCATE users");

  const users = new UserRepository(pool);
  await users.create("alice", "pw-alice");

  const sessions = new SessionManager();
  const router = new MessageRouter(sessions);
  registerHandshake(router, {
    users,
    sessions,
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 15000,
  });

  const app = await buildServer({ router });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}/ws`,
    deadSessions: [],
    warnings: (sessionId: string) => sessions.get(sessionId)?.connection.warnings ?? [],
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}
