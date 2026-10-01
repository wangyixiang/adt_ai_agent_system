import { useEffect, useState } from "react";

import type { Answer } from "@adt/shared";

import type { MainEvent, UiEvent, UiSnapshot } from "../../shared/contract";
import type { AdtClient } from "./api";
import { Composer } from "./components/Composer";
import { Login } from "./components/Login";
import { ProgressHeader } from "./components/ProgressHeader";
import { Transcript } from "./components/Transcript";
import { applyEvent, deriveTranscript, hasRunningWorkflow, type UiState } from "./transcript";

const EMPTY: UiSnapshot = {
  connection: "disconnected",
  userId: null,
  capabilities: [],
  workflows: [],
};

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  const code = (cause as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : String(cause);
}

export function App({ client }: { client: AdtClient }) {
  const [ui, setUi] = useState<UiState>({ snapshot: EMPTY, events: [] });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    client
      .snapshot()
      .then((snapshot) => {
        if (alive) setUi((previous) => ({ snapshot, events: previous.events }));
      })
      .catch((cause: unknown) => {
        if (alive) setError(messageOf(cause));
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });

    const stop = client.onEvent((event: MainEvent) => {
      if (event.type === "state") {
        setUi((previous) => ({ snapshot: event.snapshot, events: previous.events }));
      } else {
        setUi((previous) => applyEvent(previous, event.event as UiEvent));
      }
    });
    return () => {
      alive = false;
      stop();
    };
  }, [client]);

  const handleLogin = (username: string, secret: string): void => {
    setError(null);
    client
      .login(username, secret)
      .then(() => client.snapshot())
      .then((snapshot) => setUi((previous) => ({ snapshot, events: previous.events })))
      .catch((cause: unknown) => setError(messageOf(cause)));
  };

  const handleSubmit = (text: string): void => {
    setError(null);
    setSubmitting(true);
    client
      .submit(text)
      .catch((cause: unknown) => setError(messageOf(cause)))
      .finally(() => setSubmitting(false));
  };

  const handleAnswer = (askId: string, body: Answer): void => {
    setError(null);
    client.answer(askId, body).catch((cause: unknown) => setError(messageOf(cause)));
  };

  if (!loaded) return <div className="loading">加载中…</div>;

  const signedIn = ui.snapshot.connection === "connected" && ui.snapshot.userId !== null;
  if (!signedIn) return <Login onSubmit={handleLogin} error={error} />;

  const items = deriveTranscript(ui.snapshot, ui.events);
  const running = hasRunningWorkflow(items);

  return (
    <div className="app" data-testid="app">
      <ProgressHeader items={items} connection={ui.snapshot.connection} />
      {error !== null && <p role="alert">{error}</p>}
      <Transcript items={items} onAnswer={handleAnswer} />
      <Composer disabled={running || submitting} onSubmit={handleSubmit} />
    </div>
  );
}
