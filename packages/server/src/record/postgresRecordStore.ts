import type { Pool } from "../db/pool";
import type { RecordDocument, RecordSummary } from "./types";
import {
  MAX_PAGE_SIZE,
  type RecordListFilters,
  type RecordListItem,
  type RecordListPage,
  type RecordStore,
} from "./store";

interface RecordRow {
  document: RecordDocument;
  record_id: string;
  workflow_id: string;
}

interface ListRow {
  record_id: string;
  workflow_id: string;
  ended_at: string | number;
  summary: RecordSummary;
}

const encodeCursor = (endedAt: number, recordId: string): string =>
  Buffer.from(`${endedAt}:${recordId}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string): { endedAt: number; recordId: string } | null => {
  try {
    const [endedAtRaw, recordId] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
    const endedAt = Number(endedAtRaw);
    if (!Number.isFinite(endedAt) || !recordId) return null;
    return { endedAt, recordId };
  } catch {
    return null;
  }
};

/** Escape LIKE metacharacters so a keyword is matched literally. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (match) => `\\${match}`);

export class PostgresRecordStore implements RecordStore {
  constructor(private readonly pool: Pool) {}

  async save(record: RecordDocument): Promise<void> {
    await this.pool.query(
      `INSERT INTO records (record_id, workflow_id, owner_user_id, terminal_state, ended_at, document)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.record_id,
        record.workflow_id,
        record.owner_user_id,
        record.terminal_state,
        record.ended_at,
        JSON.stringify(record),
      ],
    );
  }

  async get(recordId: string, ownerUserId: string): Promise<RecordDocument | null> {
    const result = await this.pool.query<RecordRow>(
      "SELECT document FROM records WHERE record_id = $1 AND owner_user_id = $2",
      [recordId, ownerUserId],
    );
    return result.rows[0]?.document ?? null;
  }

  async findByWorkflow(workflowId: string): Promise<RecordDocument | null> {
    const result = await this.pool.query<RecordRow>(
      "SELECT document FROM records WHERE workflow_id = $1",
      [workflowId],
    );
    return result.rows[0]?.document ?? null;
  }

  async listByOwner(
    ownerUserId: string,
    filters: RecordListFilters,
    cursor: string | null,
    pageSize: number,
  ): Promise<RecordListPage> {
    const size = Math.max(1, Math.min(pageSize || 0, MAX_PAGE_SIZE));
    const params: unknown[] = [ownerUserId];
    const where: string[] = ["owner_user_id = $1"];

    if (filters.timeRange) {
      params.push(filters.timeRange.from, filters.timeRange.to);
      where.push(`ended_at BETWEEN $${params.length - 1} AND $${params.length}`);
    }

    if (filters.terminalState) {
      params.push(filters.terminalState);
      where.push(`terminal_state = $${params.length}`);
    }

    if (filters.keyword) {
      params.push(`%${escapeLike(filters.keyword)}%`);
      const p = `$${params.length}`;
      // Keyword matches summary text and entry narratives only (PROTOCOL_SPEC.md §10).
      where.push(`(
        document->'summary'->>'problem_short' ILIKE ${p}
        OR document->'summary'->>'result_short' ILIKE ${p}
        OR EXISTS (
          SELECT 1 FROM jsonb_array_elements(document->'entries') AS entry
          WHERE entry->>'narrative' ILIKE ${p}
        )
      )`);
    }

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (decoded) {
        params.push(decoded.endedAt, decoded.recordId);
        where.push(`(ended_at, record_id) < ($${params.length - 1}, $${params.length})`);
      }
    }

    params.push(size + 1);
    const result = await this.pool.query<ListRow>(
      `SELECT record_id, workflow_id, ended_at, document->'summary' AS summary
       FROM records
       WHERE ${where.join(" AND ")}
       ORDER BY ended_at DESC, record_id DESC
       LIMIT $${params.length}`,
      params,
    );

    const rows = result.rows.slice(0, size);
    const hasMore = result.rows.length > size;
    const last = rows.at(-1);

    return {
      records: rows.map<RecordListItem>((row) => ({
        record_id: row.record_id,
        workflow_id: row.workflow_id,
        summary: row.summary,
      })),
      next_cursor: hasMore && last ? encodeCursor(Number(last.ended_at), last.record_id) : null,
    };
  }
}
