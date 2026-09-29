import { randomUUID } from "node:crypto";

export function newMessageId(): string {
  return `msg_${randomUUID()}`;
}

export function newSessionId(): string {
  return `sess_${randomUUID()}`;
}

export function newUserId(): string {
  return `usr_${randomUUID()}`;
}

export function nowUtcIso(): string {
  return new Date().toISOString();
}
