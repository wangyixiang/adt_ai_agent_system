import { makeError, newMessageId, nowUtcIso, PROTOCOL_VERSION } from "@adt/shared";
import type { UserRepository } from "../auth/userRepository";
import type { MessageRouter } from "../ws/messageRouter";
import type { SessionManager } from "./sessionManager";

export interface HandshakeDeps {
  users: UserRepository;
  sessions: SessionManager;
  heartbeatIntervalMs: number;
}

interface HelloPayload {
  supported_protocol_versions?: unknown;
  client_info?: unknown;
  auth?: { username?: unknown; secret?: unknown };
  capabilities?: unknown;
}

export function registerHandshake(router: MessageRouter, deps: HandshakeDeps): void {
  router.register("session.hello", async ({ conn }, env) => {
    const payload = (env.payload ?? {}) as HelloPayload;

    const versions = Array.isArray(payload.supported_protocol_versions)
      ? (payload.supported_protocol_versions as string[])
      : [];
    if (!versions.includes(PROTOCOL_VERSION)) {
      conn.send(
        makeError(
          "unsupported_version",
          `server supports protocol_version ${PROTOCOL_VERSION}`,
          env.message_id,
        ),
      );
      conn.close();
      return;
    }

    const username = payload.auth?.username;
    const secret = payload.auth?.secret;
    if (typeof username !== "string" || typeof secret !== "string") {
      conn.send(makeError("auth_failed", "missing credentials", env.message_id));
      conn.close();
      return;
    }

    const user = await deps.users.verifyCredentials(username, secret);
    if (!user) {
      conn.send(makeError("auth_failed", "invalid credentials", env.message_id));
      conn.close();
      return;
    }

    const session = deps.sessions.create(user.id, conn);
    conn.send({
      protocol_version: PROTOCOL_VERSION,
      message_id: newMessageId(),
      session_id: session.id,
      workflow_id: null,
      user_id: user.id,
      type: "session.welcome",
      ts: nowUtcIso(),
      in_reply_to: env.message_id,
      payload: {
        protocol_version: PROTOCOL_VERSION,
        session_id: session.id,
        user_id: user.id,
        heartbeat_interval_ms: deps.heartbeatIntervalMs,
      },
    });
  });
}
