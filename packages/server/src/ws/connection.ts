import { randomUUID } from "node:crypto";
import { DedupWindow, encodeEnvelope, type Envelope } from "@adt/shared";

export interface SocketLike {
  send(data: string): void;
  close(): void;
}

export class Connection {
  readonly id: string;
  /**
   * Pre-handshake dedup window. Once a session exists its lifetime window
   * (`Session.dedup`) takes over, so this one only guards messages that arrive
   * before the handshake binds a session (PROTOCOL_SPEC.md §2).
   */
  readonly dedup = new DedupWindow();
  readonly warnings: string[] = [];
  private closed = false;

  constructor(
    private readonly socket: SocketLike,
    id: string = `conn_${randomUUID()}`,
  ) {
    this.id = id;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send(envelope: Envelope): void {
    if (this.closed) return;
    this.socket.send(encodeEnvelope(envelope));
  }

  warn(message: string): void {
    this.warnings.push(message);
  }

  markClosed(): void {
    this.closed = true;
  }

  close(): void {
    this.closed = true;
    this.socket.close();
  }
}
