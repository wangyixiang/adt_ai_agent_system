import { useState, type FormEvent } from "react";

export interface SettingsProps {
  initial: { serverUrl: string; workspaceRoot: string };
  onSave(serverUrl: string, workspaceRoot: string): void;
  /** Absent on first run: there is nothing to cancel back to yet. */
  onCancel?: () => void;
}

export function Settings({ initial, onSave, onCancel }: SettingsProps) {
  const [serverUrl, setServerUrl] = useState(initial.serverUrl);
  const [workspaceRoot, setWorkspaceRoot] = useState(initial.workspaceRoot);

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    const url = serverUrl.trim();
    if (url === "") return;
    onSave(url, workspaceRoot.trim());
  };

  return (
    <form className="settings" data-testid="settings" onSubmit={handleSubmit}>
      <h1>设置</h1>
      <p className="hint">第一次使用，请先填写 Server 地址。</p>
      <label htmlFor="server-url">Server 地址</label>
      <input
        id="server-url"
        value={serverUrl}
        placeholder="ws://host:8080/ws"
        onChange={(event) => setServerUrl(event.target.value)}
      />
      <label htmlFor="workspace">工作区（可选）</label>
      <input
        id="workspace"
        value={workspaceRoot}
        placeholder="留空则用本机当前目录"
        onChange={(event) => setWorkspaceRoot(event.target.value)}
      />
      <button type="submit" disabled={serverUrl.trim() === ""}>
        保存
      </button>
      {onCancel !== undefined && (
        <button type="button" onClick={onCancel}>
          取消
        </button>
      )}
    </form>
  );
}
