import { useState } from "react";

import type { Answer, ManualOutcome } from "@adt/shared";

import type { TranscriptItem } from "../transcript";

type AskItem = Extract<TranscriptItem, { kind: "ask" }>;

export interface AskCardProps {
  item: AskItem;
  onAnswer(askId: string, body: Answer): void;
}

/** `unknown` here is first-person: "I am not sure" — not a step's UNKNOWN. */
const OUTCOME_LABEL: Record<ManualOutcome, string> = {
  succeeded: "已成功",
  failed: "失败了",
  partially: "部分成功",
  unknown: "我说不准",
};

export function AskCard({ item, onAnswer }: AskCardProps) {
  const ask = item.ask;
  const [observation, setObservation] = useState("");
  const [outcome, setOutcome] = useState<ManualOutcome>("succeeded");
  const [feedback, setFeedback] = useState("");

  const header = (
    <header>
      <span className="badge">{item.answered ? "已回答" : "待你回答"}</span>
      <span className="ask-kind">{item.askKind ?? "问题"}</span>
    </header>
  );

  if (ask === null) {
    return (
      <article className="ask-card" data-ask-kind={item.askKind ?? "unknown"}>
        {header}
        <p className="hint">这个问题缺少内容，无法在此回答。</p>
      </article>
    );
  }

  return (
    <article className="ask-card" data-ask-kind={ask.kind} data-answered={item.answered}>
      {header}
      {ask.kind !== "completion" && <p>{ask.objective}</p>}
      {item.answered && <p className="answer">{item.text}</p>}

      {!item.answered && ask.kind === "confirmation" && (
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

      {!item.answered && ask.kind === "manual_action" && (
        <form
          className="decision"
          onSubmit={(event) => {
            event.preventDefault();
            if (observation.trim() === "") return;
            onAnswer(ask.askId, { kind: "manual_action", outcome, observation });
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
          <button type="submit" disabled={observation.trim() === ""}>
            提交
          </button>
        </form>
      )}

      {!item.answered && ask.kind === "resource_conflict" && (
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

      {!item.answered && ask.kind === "completion" && (
        <div className="decision">
          <p>{ask.summary}</p>
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
