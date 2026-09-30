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

/** A blob's identity in the main protocol (`PROTOCOL_SPEC.md` §7.5). */
export function newContentRefId(): string {
  return `blob_${randomUUID()}`;
}

export function nowUtcIso(): string {
  return new Date().toISOString();
}
