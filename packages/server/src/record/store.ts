import type { RecordDocument, RecordSummary } from "./types";

export interface RecordListFilters {
  timeRange?: { from: number; to: number } | null;
  keyword?: string | null;
  terminalState?: string | null;
}

export interface RecordListItem {
  record_id: string;
  workflow_id: string;
  summary: RecordSummary;
}

export interface RecordListPage {
  records: RecordListItem[];
  next_cursor: string | null;
}

export interface RecordStore {
  save(record: RecordDocument): Promise<void>;
  /** Owner-scoped: a record belonging to someone else reads as `null`. */
  get(recordId: string, ownerUserId: string): Promise<RecordDocument | null>;
  listByOwner(
    ownerUserId: string,
    filters: RecordListFilters,
    cursor: string | null,
    pageSize: number,
  ): Promise<RecordListPage>;
  findByWorkflow(workflowId: string): Promise<RecordDocument | null>;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
