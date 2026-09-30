import { createHash } from "node:crypto";

import type { RecordDocument } from "../record/types";

/** ADR-005 §3 — what the submitter chose to deposit. */
export type DepositObject = "record" | "report";

/** ADR-005 §3 — the outbound deposit envelope. */
export interface DepositPayload {
  deposit_version: "1";
  deposit_id: string;
  source: "adt_ai_agent_system";
  record_id: string;
  workflow_id: string;
  owner_user_id: string;
  object: DepositObject;
  spec_versions?: Record<string, string>;
  content_sha256: string;
  submitted_at: string;
  content: unknown;
}

/**
 * JSON with a stable key order, so the same content always hashes to the same
 * digest and `deposit_id` is reproducible across processes and restarts.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Builds the deposit for one Record (default) or one Report derived from it.
 *
 * `object: "report"` deposits the report **only** — never the raw Record — so
 * choosing a report really does withhold the original evidence (ADR-005 §3).
 */
export function buildDeposit(input: {
  record: RecordDocument;
  object: DepositObject;
  report?: { format: "markdown"; content: string };
  now: () => number;
}): DepositPayload {
  const { record, object, report, now } = input;
  const content: unknown = object === "report" ? report ?? null : record;
  const contentSha = sha256Hex(canonicalJson(content));

  const payload: DepositPayload = {
    deposit_version: "1",
    deposit_id: `dep_${sha256Hex(`${record.record_id}|${object}|${contentSha}`)}`,
    source: "adt_ai_agent_system",
    record_id: record.record_id,
    workflow_id: record.workflow_id,
    owner_user_id: record.owner_user_id,
    object,
    content_sha256: contentSha,
    submitted_at: new Date(now()).toISOString(),
    content,
  };
  if (object === "record") {
    payload.spec_versions = record.spec_versions;
  }
  return payload;
}
