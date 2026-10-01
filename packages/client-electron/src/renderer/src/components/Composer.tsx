import { useState, type FormEvent } from "react";

export interface ComposerProps {
  disabled: boolean;
  onSubmit(text: string): void;
}

export function Composer({ disabled, onSubmit }: ComposerProps) {
  const [text, setText] = useState("");

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    if (text.trim() === "") return;
    onSubmit(text);
    setText("");
  };

  return (
    <form className="composer" onSubmit={handleSubmit}>
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
