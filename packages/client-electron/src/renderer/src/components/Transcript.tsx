import type { Answer } from "@adt/shared";

import type { TranscriptItem } from "../transcript";
import { AskCard } from "./AskCard";
import { Notice } from "./Notice";
import { Summary } from "./Summary";
import { ToolCard } from "./ToolCard";

export function Transcript({
  items,
  onAnswer,
  onPreviewBlob,
  onSaveBlob,
  onLocate,
  readOnly,
}: {
  items: TranscriptItem[];
  onAnswer(askId: string, body: Answer): void;
  onPreviewBlob(contentRef: string, mediaType: string): void;
  onSaveBlob(contentRef: string, mediaType: string, name?: string): void;
  onLocate(stepId: string): void;
  /** A reconstructed past transcript: decisions are history, not answers. */
  readOnly: boolean;
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
                <p className="bubble-text">{item.text}</p>
                {item.attachments.length > 0 && (
                  <ul className="bubble-attachments">
                    {item.attachments.map((attachment, index) => (
                      <li
                        key={`${index}-${attachment.name}`}
                        className="bubble-attachment"
                      >
                        <span className="attachment-name">{attachment.name}</span>
                        <span className="attachment-mode">
                          {attachment.mode === "inline" ? "内联" : "blob"}
                        </span>
                        {attachment.mode === "blob" && (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                onPreviewBlob(attachment.content_ref, attachment.media_type)
                              }
                            >
                              预览
                            </button>
                            <button
                              type="button"
                              onClick={() =>
                                onSaveBlob(attachment.content_ref, attachment.media_type, attachment.name)
                              }
                            >
                              另存
                            </button>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          case "tool":
            return <ToolCard key={item.key} item={item} onLocate={onLocate} />;
          case "ask":
            return <AskCard key={item.key} item={item} onAnswer={onAnswer} readOnly={readOnly} />;
          case "notice":
            return <Notice key={item.key} item={item} />;
          case "summary":
            return <Summary key={item.key} item={item} />;
        }
      })}
    </div>
  );
}
