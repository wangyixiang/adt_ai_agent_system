export { buildServer, type ServerDeps } from "./http/app";
export { Connection, type SocketLike } from "./ws/connection";
export {
  MessageRouter,
  type MessageContext,
  type MessageHandler,
  type SessionResolver,
} from "./ws/messageRouter";
export { SessionManager, type Session } from "./session/sessionManager";
export { registerHandshake, type HandshakeDeps } from "./session/handshake";
export {
  CapabilityRegistry,
  type CapabilityDescriptor,
  type NormalizedCapability,
  type CapabilitySyncPayload,
} from "./capability/capabilityRegistry";
export { KNOWN_CAPABILITIES } from "./capability/known";
export { registerCapabilitySync, type CapabilitySyncDeps } from "./capability/handler";
export { UserRepository, type User } from "./auth/userRepository";
export { hashPassword, verifyPassword } from "./auth/password";
export { createPool, type Pool } from "./db/pool";
export { migrate, MIGRATIONS_DIR } from "./db/migrate";

import { buildServer } from "./http/app";
import { MessageRouter } from "./ws/messageRouter";

export interface StartOptions {
  port?: number;
  host?: string;
}

export async function start(
  opts: StartOptions = {},
): Promise<{ close: () => Promise<void>; url: string }> {
  const router = new MessageRouter({ byConnection: () => null });
  const app = await buildServer({ router });

  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const host = opts.host ?? "0.0.0.0";
  await app.listen({ port, host });

  const address = app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;

  return {
    url: `ws://127.0.0.1:${actualPort}/ws`,
    close: () => app.close(),
  };
}

const isMain = Boolean(process.argv[1]) && /index\.(ts|js)$/.test(process.argv[1]!);
if (isMain) {
  start()
    .then((s) => console.log(`server listening at ${s.url}`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
