import { useState } from "react";

import type { Answer, ManualOutcome } from "@adt/shared";

import type { IncomingAttachment } from "../../../shared/contract";
import { fileToIncoming } from "../attachments";
import type { TranscriptItem } from "../transcript";

type AskItem = Extract<TranscriptItem, { kind: "ask" }>;

export interface AskCardProps {
  item: AskItem;
  onAnswer(askId: string, body: Answer): void;
  /** A past transcript: render the decision as history, with no controls. */
  readOnly: boolean;
}

/** `unknown` here is first-person: "I am not sure" — not a step's UNKNOWN. */
const OUTCOME_LABEL: Record<ManualOutcome, string> = {
  succeeded: "已成功",
  failed: "失败了",
  partially: "部分成功",
  unknown: "我说不准",
};

export function AskCard({ item, onAnswer, readOnly }: AskCardProps) {
  const ask = item.ask;
  const [observation, setObservation] = useState("");
  const [outcome, setOutcome] = useState<ManualOutcome>("succeeded");
  const [feedback, setFeedback] = useState("");
  const [note, setNote] = useState("");
  const [attachments, setAttachments] = useState<IncomingAttachment[]>([]);

  const header = (
    <header className="ask-card-head">
      <span className="ask-kind">{item.askKind ?? "问题"}</span>
      <span className="badge" data-answered={item.answered}>
        {item.answered ? "已回答" : "待你回答"}
      </span>
    </header>
  );

  if (ask === null) {
    // A reconstructed past decision: only the outcome is recorded, not the card.
    return (
      <article className="ask-card" data-ask-kind={item.askKind ?? "unknown"} data-answered={item.answered}>
        {header}
        {item.answered ? <p className="answer">{item.text}</p> : <p className="hint">{item.text}</p>}
      </article>
    );
  }

  return (
    <article className="ask-card" data-ask-kind={ask.kind} data-answered={item.answered}>
      {header}
      {item.answered && <p className="answer">{item.text}</p>}

      {!readOnly && !item.answered && ask.kind === "confirmation" && (
        <div className="decision">
          <p className="hint">这是一个有副作用的动作，需要你确认。</p>
          <button type="button" onClick={() => onAnswer(ask.askId, { kind: "confirmation", decision: "confirmed" })}>
            确认
          </button>
          <button type="button" onClick={() => onAnswer(ask.askId, { kind: "confirmation", decision: "declined" })}>
            拒绝
          </button>
        </div>
      )}

      {!readOnly && !item.answered && ask.kind === "manual_action" && (
        <form
          className="decision"
          onSubmit={(event) => {
            event.preventDefault();
            if (observation.trim() === "") return;
            const details: Record<string, unknown> = {};
            if (note.trim() !== "") details["note"] = note;
            if (attachments.length > 0) details["attachments"] = attachments;
            onAnswer(ask.askId, {
              kind: "manual_action",
              outcome,
              observation,
              ...(Object.keys(details).length === 0 ? {} : { details }),
            });
          }}
        >
          <p className="instruction">{ask.instruction}</p>
          <fieldset>
            {ask.outcomes.map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name={`outcome-${ask.askId}`}
                  checked={outcome === value}
                  onChange={() => setOutcome(value)}
                />
                {OUTCOME_LABEL[value]}
              </label>
            ))}
          </fieldset>
          <textarea
            value={observation}
            placeholder="观察到的结果（必填）"
            onChange={(event) => setObservation(event.target.value)}
          />
          <textarea
            value={note}
            placeholder="补充说明（可选）"
            onChange={(event) => setNote(event.target.value)}
          />
          <input
            type="file"
            multiple
            aria-label="添加证据附件"
            onChange={(event) => {
              const files = event.target.files;
              event.target.value = "";
              if (files === null || files.length === 0) return;
              void Promise.all(Array.from(files).map(fileToIncoming)).then((incoming) =>
                setAttachments((previous) => [...previous, ...incoming]),
              );
            }}
          />
          {attachments.length > 0 && (
            <ul className="attachments">
              {attachments.map((attachment, index) => (
                <li key={`${attachment.name}-${index}`}>
                  <span>{attachment.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachments((p) => p.filter((_, i) => i !== index))}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="submit" disabled={observation.trim() === ""}>
            提交
          </button>
        </form>
      )}

      {!readOnly && !item.answered && ask.kind === "resource_conflict" && (
        <div className="decision">
          {ask.message !== undefined && <p>{ask.message}</p>}
          <button type="button" onClick={() => onAnswer(ask.askId, { kind: "resource_conflict", answer: "wait" })}>
            等待（腾出资源）
          </button>
          <button type="button" onClick={() => onAnswer(ask.askId, { kind: "resource_conflict", answer: "stop" })}>
            停止（结束这条 workflow）
          </button>
        </div>
      )}

      {ask.kind === "completion" && <p className="completion-summary">{ask.summary}</p>}
      {!readOnly && !item.answered && ask.kind === "completion" && (
        <div className="decision">
          <textarea
            value={feedback}
            placeholder="补充说明（可选）"
            onChange={(event) => setFeedback(event.target.value)}
          />
          <button
            type="button"
            onClick={() =>
              onAnswer(ask.askId, {
                kind: "completion",
                resolution: "solved",
                ...(feedback === "" ? {} : { feedback }),
              })
            }
          >
            已解决
          </button>
          <button
            type="button"
            onClick={() =>
              onAnswer(ask.askId, {
                kind: "completion",
                resolution: "not_solved",
                ...(feedback === "" ? {} : { feedback }),
              })
            }
          >
            没解决
          </button>
        </div>
      )}
    </article>
  );
}
