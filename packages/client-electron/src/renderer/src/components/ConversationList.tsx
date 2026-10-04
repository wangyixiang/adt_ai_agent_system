import { useState } from "react";

import type { UiConversation } from "../conversations";
import { Icon, type IconName } from "./Icon";

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

const STATE_TEXT: Record<UiConversation["state"], string> = {
  running: "进行中",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

const STATE_ICON: Record<UiConversation["state"], IconName> = {
  running: "hourglass",
  COMPLETED: "check",
  FAILED: "error",
  CANCELLED: "block",
};

type Filter = "all" | "live" | "archive";

export interface ConversationListProps {
  conversations: UiConversation[];
  selected: string | null;
  onSelect(workflowId: string): void;
  /** Re-fetch the Record list (live runs come from the event stream). */
  onRefresh?(): void;
}

export function ConversationList({
  conversations,
  selected,
  onSelect,
  onRefresh,
}: ConversationListProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const live = conversations.filter((conversation) => conversation.live);
  const archive = conversations.filter((conversation) => !conversation.live);
  const shown = filter === "all" ? conversations : filter === "live" ? live : archive;

  return (
    <nav className="conversations" data-testid="conversation-list">
      <header className="conversation-header">
        <span className="conversation-heading">
          <Icon name="history" />
          会话历史
          <span className="conversation-count">{conversations.length}</span>
        </span>
        {onRefresh !== undefined && (
          <button
            type="button"
            className="conversation-refresh"
            aria-label="刷新"
            onClick={onRefresh}
          >
            <Icon name="refresh" />
          </button>
        )}
      </header>

      <div className="conversation-filters">
        {(
          [
            ["all", "ALL", conversations.length],
            ["live", "LIVE", live.length],
            ["archive", "ARCHIVE", archive.length],
          ] as const
        ).map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            className={filter === key ? "filter active" : "filter"}
            onClick={() => setFilter(key)}
          >
            {label} ({count})
          </button>
        ))}
      </div>

      <div className="conversation-items">
        {shown.length === 0 ? (
          <p className="empty">还没有对话，提交一次请求开始。</p>
        ) : (
          shown.map((conversation) => (
            <button
              key={conversation.workflowId}
              type="button"
              className={
                conversation.workflowId === selected ? "conversation selected" : "conversation"
              }
              data-state={conversation.state}
              data-live={conversation.live}
              onClick={() => onSelect(conversation.workflowId)}
            >
              <span className="conversation-row">
                <span className="conversation-id">
                  {conversation.live
                    ? conversation.workflowId
                    : (conversation.recordId ?? conversation.workflowId)}
                </span>
                <span className="conversation-chip" data-state={conversation.state}>
                  <Icon name={STATE_ICON[conversation.state]} />
                  {STATE_TEXT[conversation.state]}
                </span>
              </span>
              <span className="conversation-title">{conversation.title}</span>
              <span className="conversation-row conversation-foot">
                <span className="conversation-duration">
                  {conversation.durationMs !== undefined ? (
                    <>
                      <Icon name="timer" />
                      {formatDuration(conversation.durationMs)}
                    </>
                  ) : null}
                </span>
                <span className="conversation-meta">
                  {conversation.live ? `已走 ${conversation.stepCount ?? 0} 步` : ""}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    </nav>
  );
}
