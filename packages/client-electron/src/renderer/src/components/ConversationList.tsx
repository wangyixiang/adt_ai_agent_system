import type { UiConversation } from "../conversations";

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}分${seconds}秒` : `${seconds}秒`;
}

export interface ConversationListProps {
  conversations: UiConversation[];
  selected: string | null;
  onSelect(workflowId: string): void;
}

export function ConversationList({ conversations, selected, onSelect }: ConversationListProps) {
  if (conversations.length === 0) {
    return <p className="empty">还没有对话，提交一次请求开始。</p>;
  }

  return (
    <nav className="conversations">
      {conversations.map((conversation) => (
        <button
          key={conversation.workflowId}
          type="button"
          className={
            conversation.workflowId === selected ? "conversation selected" : "conversation"
          }
          onClick={() => onSelect(conversation.workflowId)}
        >
          <span className="conversation-title">{conversation.title}</span>
          <span className="conversation-state">
            {conversation.state === "running" ? "进行中" : conversation.state}
          </span>
          {conversation.durationMs !== undefined && (
            <span className="conversation-duration">{formatDuration(conversation.durationMs)}</span>
          )}
        </button>
      ))}
    </nav>
  );
}
