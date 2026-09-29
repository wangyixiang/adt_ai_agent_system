import WebSocket from "ws";
import {
  decodeEnvelope,
  encodeEnvelope,
  newMessageId,
  nowUtcIso,
  PROTOCOL_VERSION,
  type Envelope,
} from "@adt/shared";
import type { CapabilityDescriptor, CapabilitySyncPayload } from "@adt/server";

export interface HelloOptions {
  username: string;
  secret: string;
  versions?: string[];
  capabilities?: CapabilityDescriptor[];
}

export class TestClient {
  private readonly inbox: Envelope[] = [];
  private readonly waiters: Array<(e: Envelope) => void> = [];
  private closed = false;

  sessionId = "";
  userId = "";

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (data: WebSocket.RawData) => {
      this.push(decodeEnvelope(data.toString()));
    });
    ws.on("close", () => {
      this.closed = true;
    });
  }

  static connect(url: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.once("open", () => resolve(new TestClient(ws)));
      ws.once("error", reject);
    });
  }

  private push(env: Envelope): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(env);
    else this.inbox.push(env);
  }

  next(timeoutMs = 5000): Promise<Envelope> {
    const queued = this.inbox.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout;
      const waiter = (env: Envelope): void => {
        clearTimeout(timer);
        resolve(env);
      };
      timer = setTimeout(() => {
        // A timed-out waiter must be removed, otherwise it swallows the next
        // message (resolve-after-reject is a no-op and the message is lost).
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timeout waiting for a message"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  base(type: string): Envelope {
    return {
      protocol_version: PROTOCOL_VERSION,
      message_id: newMessageId(),
      session_id: this.sessionId || null,
      workflow_id: null,
      user_id: this.userId || null,
      type,
      ts: nowUtcIso(),
      in_reply_to: null,
      payload: {},
    };
  }

  sendRaw(envelope: Envelope): Promise<Envelope> {
    this.ws.send(encodeEnvelope(envelope));
    return this.next();
  }

  /** Fire-and-forget send (for messages with no reply, or duplicates). */
  send(envelope: Envelope): void {
    this.ws.send(encodeEnvelope(envelope));
  }

  /** `capability.sync` has no ack; the caller waits on server state instead. */
  sync(payload: CapabilitySyncPayload): void {
    this.ws.send(encodeEnvelope({ ...this.base("capability.sync"), payload }));
  }

  /** Application-level heartbeat; no response (PROTOCOL_SPEC.md §5.1). */
  heartbeat(): void {
    this.ws.send(encodeEnvelope({ ...this.base("session.heartbeat"), payload: {} }));
  }

  async hello(opts: HelloOptions): Promise<Envelope> {
    const res = await this.sendRaw({
      ...this.base("session.hello"),
      payload: {
        supported_protocol_versions: opts.versions ?? [PROTOCOL_VERSION],
        client_info: { name: "test-client", platform: "test" },
        auth: { username: opts.username, secret: opts.secret },
        capabilities: opts.capabilities ?? [],
      },
    });
    if (res.type === "session.welcome") {
      const payload = res.payload as { session_id: string; user_id: string };
      this.sessionId = payload.session_id;
      this.userId = payload.user_id;
    }
    return res;
  }

  /**
   * `session.resume` (PROTOCOL_SPEC.md §5.2): reconnect to a prior logical
   * session. `sessionId` is passed explicitly because the caller may be a
   * fresh client after a disconnect.
   */
  async resume(
    sessionId: string,
    opts: { username: string; secret: string; knownWorkflows?: string[] },
  ): Promise<Envelope> {
    const res = await this.sendRaw({
      ...this.base("session.resume"),
      payload: {
        session_id: sessionId,
        auth: { username: opts.username, secret: opts.secret },
        known_workflows: (opts.knownWorkflows ?? []).map((workflow_id) => ({
          workflow_id,
          last_known_step_id: null,
          last_known_status: null,
        })),
      },
    });
    if (res.type === "workflow.state_sync") {
      this.sessionId = res.session_id ?? sessionId;
      this.userId = res.user_id ?? this.userId;
    }
    return res;
  }

  waitClose(timeoutMs = 5000): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
