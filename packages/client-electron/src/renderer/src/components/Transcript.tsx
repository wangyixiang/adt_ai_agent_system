import type { Answer } from "@adt/shared";

import type { TranscriptItem } from "../transcript";
import { AskCard } from "./AskCard";
import { Notice } from "./Notice";
import { Summary } from "./Summary";
import { ToolCard } from "./ToolCard";

export function Transcript({
  items,
  onAnswer,
}: {
  items: TranscriptItem[];
  onAnswer(askId: string, body: Answer): void;
}) {
  if (items.length === 0) {
    return <p className="empty">还没有内容。提交一次请求开始。</p>;
  }

  return (
    <div className="transcript">
      {items.map((item) => {
        switch (item.kind) {
          case "user":
            return (
              <div key={item.key} className="bubble user">
                {item.text}
              </div>
            );
          case "assistant":
            return (
              <div key={item.key} className="bubble assistant">
                {item.text}
              </div>
            );
          case "tool":
            return <ToolCard key={item.key} item={item} />;
          case "ask":
            return <AskCard key={item.key} item={item} onAnswer={onAnswer} />;
          case "notice":
            return <Notice key={item.key} item={item} />;
          case "summary":
            return <Summary key={item.key} item={item} />;
        }
      })}
    </div>
  );
}
