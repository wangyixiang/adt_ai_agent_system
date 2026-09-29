import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { Connection } from "../ws/connection";
import type { MessageRouter } from "../ws/messageRouter";

export interface ServerDeps {
  router: MessageRouter;
  /** Called after a socket closes so the session can be detached (not dropped). */
  onConnectionClosed?: (conn: Connection) => void;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  app.get("/health", async () => ({ ok: true }));

  app.get("/ws", { websocket: true }, (socket) => {
    const conn = new Connection({
      send: (data) => socket.send(data),
      close: () => socket.close(),
    });

    socket.on("message", (data: unknown) => {
      void deps.router.handle(conn, data as Buffer | string);
    });
    socket.on("close", () => {
      conn.markClosed();
      deps.onConnectionClosed?.(conn);
    });
  });

  return app;
}
