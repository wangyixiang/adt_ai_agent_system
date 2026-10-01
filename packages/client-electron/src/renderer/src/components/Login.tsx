import { useState, type FormEvent } from "react";

export interface LoginProps {
  onSubmit(username: string, secret: string): void;
  error: string | null;
}

export function Login({ onSubmit, error }: LoginProps) {
  const [username, setUsername] = useState("");
  const [secret, setSecret] = useState("");

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    onSubmit(username, secret);
  };

  return (
    <form className="login" onSubmit={handleSubmit}>
      <h1>登录</h1>
      <label htmlFor="username">用户名</label>
      <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <label htmlFor="password">密码</label>
      <input
        id="password"
        type="password"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
      />
      <button type="submit">登录</button>
      {error !== null && <p role="alert">{error}</p>}
    </form>
  );
}
