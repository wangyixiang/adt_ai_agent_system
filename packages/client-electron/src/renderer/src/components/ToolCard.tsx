import type { TranscriptItem } from "../transcript";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

export function ToolCard({ item }: { item: ToolItem }) {
  return (
    <article className="tool-card" data-state={item.state}>
      <header>
        <span className="capability">{item.capability}</span>
        <span className="badge">{item.text}</span>
      </header>
      {Object.keys(item.input).length > 0 && (
        <pre className="input">{JSON.stringify(item.input, null, 2)}</pre>
      )}
      {item.requiresConfirmation && <p className="hint">这一步需要你的确认。</p>}
      {item.evidenceSummary !== null && <pre className="evidence">{item.evidenceSummary}</pre>}
    </article>
  );
}
