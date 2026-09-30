import WebSocket from "ws";
import {
  decodeEnvelope,
  encodeEnvelope,
  newMessageId,
  nowUtcIso,
  PROTOCOL_VERSION,
  type CapabilityDescriptor,
  type CapabilitySyncPayload,
  type Envelope,
} from "@adt/shared";

export interface ClientConfig {
  url: string;
  credentials: { username: string; secret: string };
  capabilities: CapabilityDescriptor[];
  clientInfo: { name: string; platform: string };
}

interface WelcomePayload {
  protocol_version: string;
  session_id: string;
  user_id: string;
  heartbeat_interval_ms: number;
}

export class DaemonConnection {
  private readonly listeners = new Map<string, Array<(env: Envelope) => void>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly ws: WebSocket,
    readonly sessionId: string,
    readonly userId: string,
    readonly heartbeatIntervalMs: number,
  ) {
    ws.on("message", (data: WebSocket.RawData) => {
      const env = decodeEnvelope(data.toString());
      for (const handler of this.listeners.get(env.type) ?? []) handler(env);
    });
  }

  static connect(
    cfg: ClientConfig,
    onReady?: (connection: DaemonConnection) => void,
  ): Promise<DaemonConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(cfg.url);
      const timer = setTimeout(
        () => reject(new Error("handshake timed out")),
        10000,
      );

      const fail = (error: Error) => {
        clearTimeout(timer);
        // Do not leak the socket when the handshake is rejected.
        try {
          ws.close();
        } catch {
          // already closing/closed
        }
        reject(error);
      };

      ws.once("error", fail);
      ws.once("open", () => {
        ws.send(
          encodeEnvelope({
            protocol_version: PROTOCOL_VERSION,
            message_id: newMessageId(),
            session_id: null,
            workflow_id: null,
            user_id: null,
            type: "session.hello",
            ts: nowUtcIso(),
            in_reply_to: null,
            payload: {
              supported_protocol_versions: [PROTOCOL_VERSION],
              client_info: cfg.clientInfo,
              auth: cfg.credentials,
              capabilities: cfg.capabilities,
            },
          }),
        );
      });

      const onMessage = (data: WebSocket.RawData) => {
        const env = decodeEnvelope(data.toString());

        if (env.type === "session.welcome") {
          ws.off("message", onMessage);
          clearTimeout(timer);
          const payload = env.payload as WelcomePayload;
          const connection = new DaemonConnection(
            ws,
            payload.session_id,
            payload.user_id,
            payload.heartbeat_interval_ms,
          );
          const sync: CapabilitySyncPayload = {
            mode: "full",
            revision: 0,
            added: cfg.capabilities,
            removed: [],
          };
          connection.send("capability.sync", sync);
          connection.startHeartbeat();
          // Attach listeners (e.g. the step runner) before resolving, so a
          // dispatch arriving right after the welcome cannot be dropped.
          onReady?.(connection);
          resolve(connection);
          return;
        }

        if (env.type === "protocol.error") {
          const payload = env.payload as { code: string; message: string };
          fail(new Error(`${payload.code}: ${payload.message}`));
        }
      };

      ws.on("message", onMessage);
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(
      () => this.send("session.heartbeat", {}),
      this.heartbeatIntervalMs,
    );
    this.heartbeatTimer.unref?.();
  }

  on(type: string, handler: (env: Envelope) => void): void {
    const handlers = this.listeners.get(type) ?? [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  send(type: string, payload: unknown): void {
    this.ws.send(
      encodeEnvelope({
        protocol_version: PROTOCOL_VERSION,
        message_id: newMessageId(),
        session_id: this.sessionId,
        workflow_id: null,
        user_id: this.userId,
        type,
        ts: nowUtcIso(),
        in_reply_to: null,
        payload,
      }),
    );
  }

  close(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
