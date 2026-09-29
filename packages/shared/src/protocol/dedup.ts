/**
 * Session-lifetime dedup window for `message_id` (PROTOCOL_SPEC.md §2).
 * Covers exact retransmissions only; semantic duplicate intent is the
 * `idempotency_key`'s job (WORKFLOW_SPEC.md §4.3).
 */
export class DedupWindow {
  private readonly seen = new Set<string>();

  has(messageId: string): boolean {
    return this.seen.has(messageId);
  }

  add(messageId: string): void {
    this.seen.add(messageId);
  }

  clear(): void {
    this.seen.clear();
  }
}
