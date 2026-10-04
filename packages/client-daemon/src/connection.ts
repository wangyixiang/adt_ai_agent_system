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
import type { StepDispatchPayload } from "./stepRunner";

export interface ClientConfig {
  url: string;
  credentials: { username: string; secret: string };
  capabilities: CapabilityDescriptor[];
  clientInfo: { name: string; platform: string };
  /**
   * The logical session to resume, if this daemon had one. When resume is
   * refused (expired session, server restart) the connection falls back to a
   * fresh handshake — a new session — rather than failing (PROTOCOL_SPEC.md §5.2).
   */
  session?: { sessionId: string } | null;
}

interface WelcomePayload {
  protocol_version: string;
  session_id: string;
  user_id: string;
  heartbeat_interval_ms: number;
}

/** The part of `workflow.state_sync` a client acts on (PROTOCOL_SPEC.md §5.2). */
export interface StateSyncSnapshot {
  resumed: boolean;
  heartbeat_interval_ms?: number;
  workflows: Array<{
    workflow_id: string;
    workflow_status: string;
    pending_step: StepDispatchPayload | null;
  }>;
}

export class DaemonConnection {
  private readonly listeners = new Map<string, Array<(env: Envelope) => void>>();
  private readonly closeHandlers: Array<() => void> = [];
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** Set by a deliberate `close()`, so its socket close is not a "drop". */
  private closing = false;

  private constructor(
    private readonly ws: WebSocket,
    readonly sessionId: string,
    readonly userId: string,
    readonly heartbeatIntervalMs: number,
  ) {
    ws.on("message", (data: WebSocket.RawData) => {
      const env = decodeEnvelope(data.toString());
      // Iterate a copy: a handler may remove itself (a completed `request()`),
      // which would otherwise shift the array under this loop.
      for (const handler of [...(this.listeners.get(env.type) ?? [])]) handler(env);
    });
    // A socket can fail at any time. Without a listener Node treats an 'error'
    // event as unhandled and throws it out of the event loop, which would take
    // the daemon down with it.
    ws.on("error", (error: Error) => {
      console.warn(`[daemon] socket error: ${error.message}`);
    });
    // A close nobody asked for is a dropped transport (the host reconnects).
    ws.on("close", () => {
      if (this.closing) return;
      for (const handler of this.closeHandlers) handler();
    });
  }

  static connect(
    cfg: ClientConfig,
    onReady?: (connection: DaemonConnection, stateSync?: StateSyncSnapshot) => void,
  ): Promise<DaemonConnection> {
    /**
     * One handshake attempt. A refused resume is answered with a *fatal*
     * `protocol.error` (the Server closes the socket), so falling back means a
     * fresh connection — reusing this one would write into a closing socket.
     */
    const attempt = (session: { sessionId: string } | null): Promise<DaemonConnection> =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(cfg.url);
        const resuming = session !== null;
        const timer = setTimeout(() => {
          teardown();
          reject(new Error("handshake timed out"));
        }, 10000);

        const teardown = (): void => {
          clearTimeout(timer);
          ws.off("message", onMessage);
          ws.off("error", fail);
        };

        const fail = (error: Error): void => {
          teardown();
          // Do not leak the socket when the handshake is rejected.
          try {
            ws.close();
          } catch {
            // already closing/closed
          }
          reject(error);
        };

        const sendHello = (): void => {
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
        };

        const sendResume = (): void => {
          ws.send(
            encodeEnvelope({
              protocol_version: PROTOCOL_VERSION,
              message_id: newMessageId(),
              session_id: session!.sessionId,
              workflow_id: null,
              user_id: null,
              type: "session.resume",
              ts: nowUtcIso(),
              in_reply_to: null,
              payload: {
                session_id: session!.sessionId,
                auth: cfg.credentials,
                // Only terminal workflows are reconciled from this list; live
                // ones (the ones with a `pending_step`) are always sent — so a
                // daemon that tracks nothing still gets its unfinished work back.
                known_workflows: [],
              },
            }),
          );
        };

        const finish = (
          sessionId: string,
          userId: string,
          heartbeatIntervalMs: number,
          stateSync?: StateSyncSnapshot,
        ): void => {
          teardown();
          const connection = new DaemonConnection(ws, sessionId, userId, heartbeatIntervalMs);

          // A resumed session already holds the capabilities it declared, and
          // the manifest is revision-guarded; re-sending a full sync at
          // revision 0 would only be dropped as stale.
          if (!stateSync) {
            const sync: CapabilitySyncPayload = {
              mode: "full",
              revision: 0,
              added: cfg.capabilities,
              removed: [],
            };
            connection.send("capability.sync", sync);
          }

          connection.startHeartbeat();
          // Attach listeners (e.g. the step runner) before resolving, so a
          // dispatch arriving right after the handshake cannot be dropped.
          onReady?.(connection, stateSync);
          resolve(connection);
        };

        ws.once("error", fail);
        ws.once("open", () => {
          if (resuming) sendResume();
          else sendHello();
        });

        const onMessage = (data: WebSocket.RawData) => {
          const env = decodeEnvelope(data.toString());

          if (env.type === "session.welcome" && !resuming) {
            const payload = env.payload as WelcomePayload;
            finish(payload.session_id, payload.user_id, payload.heartbeat_interval_ms);
            return;
          }

          if (env.type === "workflow.state_sync" && resuming) {
            const payload = env.payload as StateSyncSnapshot;
            finish(
              env.session_id ?? session!.sessionId,
              env.user_id ?? "",
              payload.heartbeat_interval_ms ?? 15000,
              payload,
            );
            return;
          }

          if (env.type === "protocol.error") {
            const payload = env.payload as { code: string; message: string };
            if (resuming) {
              // Refused (expired, unknown, or the Server restarted): start over.
              teardown();
              try {
                ws.close();
              } catch {
                // already closing/closed
              }
              resolve(attempt(null));
              return;
            }
            fail(new Error(`${payload.code}: ${payload.message}`));
          }
        };

        ws.on("message", onMessage);
      });

    return attempt(cfg.session ?? null);
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

  /** Notified when the transport drops (never on a deliberate `close()`). */
  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  private off(type: string, handler: (env: Envelope) => void): void {
    const handlers = this.listeners.get(type);
    if (!handlers) return;
    const index = handlers.indexOf(handler);
    if (index >= 0) handlers.splice(index, 1);
  }

  private sendWithId(type: string, payload: unknown, messageId: string): void {
    this.ws.send(
      encodeEnvelope({
        protocol_version: PROTOCOL_VERSION,
        message_id: messageId,
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

  send(type: string, payload: unknown): void {
    this.sendWithId(type, payload, newMessageId());
  }

  /**
   * Sends a request and waits for the reply that quotes it. `protocol.error`
   * is watched too, because a refusal arrives under its own type — matching on
   * `in_reply_to` is what keeps concurrent requests apart.
   */
  request(
    type: string,
    payload: unknown,
    replyType: string,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    const messageId = newMessageId();

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const onReply = (env: Envelope): void => {
        if (env.in_reply_to !== messageId) return;
        done();
        if (env.type === "protocol.error") {
          const failure = (env.payload ?? {}) as { code?: string; message?: string };
          reject(new Error(`${failure.code ?? "error"}: ${failure.message ?? ""}`));
          return;
        }
        resolve((env.payload ?? {}) as Record<string, unknown>);
      };

      const timer = setTimeout(() => {
        done();
        reject(new Error(`timed out waiting for ${replyType}`));
      }, timeoutMs);

      const done = (): void => {
        clearTimeout(timer);
        this.off(replyType, onReply);
        this.off("protocol.error", onReply);
      };

      this.on(replyType, onReply);
      this.on("protocol.error", onReply);
      this.sendWithId(type, payload, messageId);
    });
  }

  close(): Promise<void> {
    this.closing = true;
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
