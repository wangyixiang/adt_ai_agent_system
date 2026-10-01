import { useState, type ChangeEvent, type FormEvent } from "react";

import type { IncomingAttachment } from "../../../shared/contract";
import { fileToIncoming, textToIncoming } from "../attachments";

export interface ComposerProps {
  disabled: boolean;
  /** Resolve to clear the draft; reject to keep it (e.g. an over-limit set). */
  onSubmit(text: string, attachments: IncomingAttachment[]): Promise<void> | void;
}

export function Composer({ disabled, onSubmit }: ComposerProps) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<IncomingAttachment[]>([]);
  const [paste, setPaste] = useState("");

  const addFiles = async (files: FileList | null): Promise<void> => {
    if (files === null || files.length === 0) return;
    const incoming = await Promise.all(Array.from(files).map(fileToIncoming));
    setAttachments((previous) => [...previous, ...incoming]);
  };

  const handleFile = (event: ChangeEvent<HTMLInputElement>): void => {
    void addFiles(event.target.files);
    event.target.value = "";
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (text.trim() === "") return;
    // Clear only after the submit succeeds — a rejected set must not eat the draft.
    void Promise.resolve(onSubmit(text, attachments))
      .then(() => {
        setText("");
        setAttachments([]);
        setPaste("");
      })
      .catch(() => {
        // Keep the draft; the error is surfaced by App.
      });
  };

  return (
    <form
      className="composer"
      onSubmit={handleSubmit}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        void addFiles(event.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <ul className="attachments">
          {attachments.map((attachment, index) => (
            <li key={`${attachment.name}-${index}`}>
              <span className="attachment-name">{attachment.name}</span>
              <button type="button" onClick={() => setAttachments((p) => p.filter((_, i) => i !== index))}>
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        value={paste}
        placeholder="粘贴一段文本作为附件…"
        disabled={disabled}
        onChange={(event) => setPaste(event.target.value)}
      />
      <button
        type="button"
        disabled={disabled || paste.trim() === ""}
        onClick={() => {
          setAttachments((previous) => [...previous, textToIncoming(paste)]);
          setPaste("");
        }}
      >
        添加文本
      </button>
      <input type="file" multiple aria-label="添加附件" disabled={disabled} onChange={handleFile} />
      <input
        value={text}
        placeholder="输入一次请求…"
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" disabled={disabled}>
        发送
      </button>
      {disabled && <p className="hint">本工作流正在处理中</p>}
    </form>
  );
}
