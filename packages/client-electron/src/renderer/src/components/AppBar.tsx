import type { UiSnapshot } from "../../../shared/contract";

/** The connection states the app bar can show (spec §7; `reconnecting` is UI-4). */
const CONNECTION_TEXT: Record<UiSnapshot["connection"], string> = {
  connected: "已连接",
  disconnected: "已断开",
};

export function AppBar({
  connection,
  userId,
  onOpenSettings,
}: {
  connection: UiSnapshot["connection"];
  userId: string | null;
  onOpenSettings(): void;
}) {
  return (
    <header className="app-bar" data-testid="app-bar">
      <span className="app-name">ADT</span>
      <span className="app-connection" data-connection={connection}>
        {CONNECTION_TEXT[connection]}
      </span>
      {userId !== null && <span className="app-user">{userId}</span>}
      <button type="button" className="app-settings" onClick={onOpenSettings}>
        设置
      </button>
    </header>
  );
}
