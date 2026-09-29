export const PROTOCOL_VERSION = "0.3";

export interface Envelope {
  protocol_version: string;
  message_id: string;
  session_id: string | null;
  workflow_id: string | null;
  user_id: string | null;
  type: string;
  ts: string;
  in_reply_to: string | null;
  payload: unknown;
}

export class EnvelopeError extends Error {
  readonly code = "malformed_payload" as const;
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export function encodeEnvelope(e: Envelope): string {
  return JSON.stringify(e);
}

const UTC_ISO_END = /Z$/;

export function decodeEnvelope(raw: string | Buffer): Envelope {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EnvelopeError("invalid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnvelopeError("envelope must be an object");
  }

  const e = parsed as Record<string, unknown>;

  if (typeof e.type !== "string" || e.type.length === 0) {
    throw new EnvelopeError("type must be a non-empty string");
  }
  if (typeof e.message_id !== "string" || e.message_id.length === 0) {
    throw new EnvelopeError("message_id must be a non-empty string");
  }
  if (
    typeof e.ts !== "string" ||
    !UTC_ISO_END.test(e.ts) ||
    Number.isNaN(Date.parse(e.ts))
  ) {
    throw new EnvelopeError("ts must be a UTC ISO 8601 string ending in Z");
  }

  return {
    protocol_version:
      typeof e.protocol_version === "string" ? e.protocol_version : PROTOCOL_VERSION,
    message_id: e.message_id,
    session_id: typeof e.session_id === "string" ? e.session_id : null,
    workflow_id: typeof e.workflow_id === "string" ? e.workflow_id : null,
    user_id: typeof e.user_id === "string" ? e.user_id : null,
    type: e.type,
    ts: e.ts,
    in_reply_to: typeof e.in_reply_to === "string" ? e.in_reply_to : null,
    payload: e.payload ?? null,
  };
}
