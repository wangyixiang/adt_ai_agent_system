import { useEffect, useState } from "react";

import type { Answer } from "@adt/shared";

import type { MainEvent, UiEvent, UiRecordListEntry, UiSnapshot } from "../../shared/contract";
import type { AdtClient } from "./api";
import { Composer } from "./components/Composer";
import { ConversationList } from "./components/ConversationList";
import { Login } from "./components/Login";
import { ProgressHeader } from "./components/ProgressHeader";
import { Transcript } from "./components/Transcript";
import { conversations } from "./conversations";
import { transcriptFromRecord } from "./recordTranscript";
import {
  applyEvent,
  deriveTranscript,
  type TranscriptItem,
  type UiState,
} from "./transcript";

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
  const [records, setRecords] = useState<UiRecordListEntry[]>([]);
  const [recordsTick, setRecordsTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  /** Record transcripts are immutable, so this cache never needs invalidating. */
  const [historyTranscripts, setHistoryTranscripts] = useState<Map<string, TranscriptItem[]>>(
    new Map(),
  );

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
        // A finished run becomes a Record; refresh the list so it appears.
        if (event.event.type === "workflow.terminated") setRecordsTick((tick) => tick + 1);
      }
    });
    return () => {
      alive = false;
      stop();
    };
  }, [client]);

  const signedIn = ui.snapshot.connection === "connected" && ui.snapshot.userId !== null;

  useEffect(() => {
    if (!signedIn) return;
    let alive = true;
    client
      .records()
      .then((list) => {
        if (alive) setRecords(list.records);
      })
      .catch((cause: unknown) => {
        if (alive) setError(messageOf(cause));
      });
    return () => {
      alive = false;
    };
  }, [client, signedIn, recordsTick]);

  const allItems = deriveTranscript(ui.snapshot, ui.events);
  const list = conversations(allItems, records);
  const effectiveSelected =
    selected !== null && list.some((conversation) => conversation.workflowId === selected)
      ? selected
      : (list.find((conversation) => conversation.state === "running")?.workflowId ??
        list[0]?.workflowId ??
        null);
  const selectedConversation =
    list.find((conversation) => conversation.workflowId === effectiveSelected) ?? null;
  const historyRecordId =
    selectedConversation !== null && !selectedConversation.live
      ? selectedConversation.recordId
      : null;

  useEffect(() => {
    if (historyRecordId === null || historyTranscripts.has(historyRecordId)) return;
    let alive = true;
    client
      .record(historyRecordId)
      .then((record) => {
        if (alive) {
          setHistoryTranscripts((previous) =>
            new Map(previous).set(historyRecordId, transcriptFromRecord(record)),
          );
        }
      })
      .catch((cause: unknown) => {
        if (alive) setError(messageOf(cause));
      });
    return () => {
      alive = false;
    };
  }, [client, historyRecordId, historyTranscripts]);

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
  if (!signedIn) return <Login onSubmit={handleLogin} error={error} />;

  const viewItems: TranscriptItem[] =
    selectedConversation === null
      ? []
      : selectedConversation.live
        ? allItems.filter(
            (item) => item.kind === "notice" || item.workflowId === selectedConversation.workflowId,
          )
        : (historyRecordId !== null ? (historyTranscripts.get(historyRecordId) ?? []) : []);
  const anyRunning = list.some((conversation) => conversation.state === "running");

  return (
    <div className="app" data-testid="app">
      <ConversationList conversations={list} selected={effectiveSelected} onSelect={setSelected} />
      <main className="thread">
        <ProgressHeader items={viewItems} connection={ui.snapshot.connection} />
        {error !== null && <p role="alert">{error}</p>}
        {selectedConversation !== null && !selectedConversation.live && (
          <p className="past-note">往期记录</p>
        )}
        <Transcript items={viewItems} onAnswer={handleAnswer} />
        {/* The composer only opens a *new* conversation, so it is always
            available (disabled while anything is running) — including when the
            list is empty or a past record is selected. */}
        <Composer disabled={anyRunning || submitting} onSubmit={handleSubmit} />
      </main>
    </div>
  );
}
