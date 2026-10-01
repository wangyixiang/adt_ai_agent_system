import { useState, type FormEvent } from "react";

export interface SettingsProps {
  initial: { serverUrl: string; workspaceRoot: string };
  onSave(serverUrl: string, workspaceRoot: string): void;
  /** Absent on first run: there is nothing to cancel back to yet. */
  onCancel?: () => void;
  /** A failed save, shown here (the login/app error line is not on screen). */
  error?: string | null;
}

/** A server address must be a `ws://` or `wss://` URL — anything else is a typo. */
export function isValidServerUrl(value: string): boolean {
  return /^wss?:\/\/\S+$/i.test(value.trim());
}

export function Settings({ initial, onSave, onCancel, error = null }: SettingsProps) {
  const [serverUrl, setServerUrl] = useState(initial.serverUrl);
  const [workspaceRoot, setWorkspaceRoot] = useState(initial.workspaceRoot);
  const url = serverUrl.trim();
  const valid = isValidServerUrl(url);

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid) return;
    onSave(url, workspaceRoot.trim());
  };

  return (
    <form className="settings" data-testid="settings" onSubmit={handleSubmit}>
      <h1>设置</h1>
      {onCancel === undefined && <p className="hint">第一次使用，请先填写 Server 地址。</p>}
      <label htmlFor="server-url">Server 地址</label>
      <input
        id="server-url"
        value={serverUrl}
        placeholder="ws://host:8080/ws"
        onChange={(event) => setServerUrl(event.target.value)}
      />
      {url !== "" && !valid && <p role="alert">地址需以 ws:// 或 wss:// 开头</p>}
      <label htmlFor="workspace">工作区（可选）</label>
      <input
        id="workspace"
        value={workspaceRoot}
        placeholder="留空则用本机当前目录"
        onChange={(event) => setWorkspaceRoot(event.target.value)}
      />
      <button type="submit" disabled={!valid}>
        保存
      </button>
      {onCancel !== undefined && (
        <button type="button" onClick={onCancel}>
          取消
        </button>
      )}
      {error !== null && <p role="alert">{error}</p>}
    </form>
  );
}
