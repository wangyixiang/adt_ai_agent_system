import type { TranscriptItem } from "../transcript";

type NoticeItem = Extract<TranscriptItem, { kind: "notice" }>;

export function Notice({ item }: { item: NoticeItem }) {
  return (
    <p className="notice" data-level={item.level}>
      {item.text}
    </p>
  );
}
