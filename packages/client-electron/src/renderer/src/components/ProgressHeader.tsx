import { hasRunningWorkflow, type TranscriptItem } from "../transcript";

export function ProgressHeader({ items }: { items: TranscriptItem[] }) {
  const tools = items.filter((item) => item.kind === "tool");
  const done = tools.filter((item) => item.state === "COMPLETED").length;
  const running = hasRunningWorkflow(items);
  const anyConversation = items.some((item) => item.kind === "user");

  return (
    <header className="progress">
      <span>
        已走 {tools.length} 步（完成 {done}）
      </span>
      {running && <span>本条对话进行中</span>}
      {!running && anyConversation && <span>没有进行中的对话</span>}
    </header>
  );
}
