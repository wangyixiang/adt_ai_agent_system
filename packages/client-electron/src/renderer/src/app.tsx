import { useEffect, useState } from "react";

import type { Answer } from "@adt/shared";

import type { MainEvent, UiEvent, UiRecordListEntry, UiSnapshot, UiBlobPreview, UiConfig, IncomingAttachment } from "../../shared/contract";
import type { AdtClient } from "./api";
import { Composer } from "./components/Composer";
import { ConversationList } from "./components/ConversationList";
import { Login } from "./components/Login";
import { ProgressHeader } from "./components/ProgressHeader";
import { ReportViewer } from "./components/ReportViewer";
import { Settings } from "./components/Settings";
import { Transcript } from "./components/Transcript";
import { Workbench } from "./components/Workbench";
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
  /** The effective settings; `null` until the first `configGet` resolves. */
  const [config, setConfig] = useState<UiConfig | null>(null);
  /** The settings page was opened from the app (as opposed to first run). */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The open Report viewer: markdown on success, an error otherwise (never both). */
  const [report, setReport] = useState<{ markdown: string | null; error: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Records this session has generated a report for (enables exporting it). */
  const [reportReady, setReportReady] = useState<Set<string>>(new Set());
  /** The open blob viewer (an attachment or an evidence blob). */
  const [blob, setBlob] = useState<UiBlobPreview | null>(null);
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
    let alive = true;
    client
      .configGet()
      .then((next) => {
        if (alive) setConfig(next);
      })
      .catch((cause: unknown) => {
        if (alive) setError(messageOf(cause));
      });
    return () => {
      alive = false;
    };
  }, [client]);

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

  // An export result or an open report belongs to the conversation it came from;
  // switching conversations must not leave a stale "received" line under another.
  useEffect(() => {
    setNotice(null);
    setReport(null);
    setBlob(null);
  }, [effectiveSelected]);

  const handleLogin = (username: string, secret: string): void => {
    setError(null);
    client
      .login(username, secret)
      .then(() => client.snapshot())
      .then((snapshot) => setUi((previous) => ({ snapshot, events: previous.events })))
      .catch((cause: unknown) => setError(messageOf(cause)));
  };

  const handleSaveConfig = (serverUrl: string, workspaceRoot: string): void => {
    setError(null);
    client
      .configSet(serverUrl, workspaceRoot === "" ? undefined : workspaceRoot)
      .then((next) => {
        setConfig(next);
        setSettingsOpen(false);
      })
      .catch((cause: unknown) => setError(messageOf(cause)));
  };

  const handleSubmit = (text: string, attachments: IncomingAttachment[]): Promise<void> => {
    setError(null);
    setSubmitting(true);
    return client
      .submit(text, attachments)
      .then((workflowId) => setSelected(workflowId))
      .catch((cause: unknown) => {
        setError(messageOf(cause));
        throw cause;
      })
      .finally(() => setSubmitting(false));
  };

  const handleAnswer = (askId: string, body: Answer): void => {
    setError(null);
    client.answer(askId, body).catch((cause: unknown) => setError(messageOf(cause)));
  };

  if (!loaded) return <div className="loading">加载中…</div>;
  if (config === null) {
    // A failed config load must say so, not spin forever.
    return error !== null ? <p role="alert">{error}</p> : <div className="loading">加载中…</div>;
  }
  if (!config.configured || settingsOpen) {
    return (
      <Settings
        initial={config}
        onSave={handleSaveConfig}
        error={error}
        {...(config.configured ? { onCancel: () => setSettingsOpen(false) } : {})}
      />
    );
  }
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

  const selectedCancelling =
    effectiveSelected !== null &&
    (ui.snapshot.workflows.find((workflow) => workflow.workflowId === effectiveSelected)?.cancelling ??
      false);
  const canCancel = selectedConversation?.live === true && selectedConversation.state === "running";

  const handleCancel = (workflowId: string): Promise<void> => {
    setError(null);
    return client.cancel(workflowId).catch((cause: unknown) => {
      setError(messageOf(cause));
      throw cause;
    });
  };

  const selectedSummaryRecordId =
    effectiveSelected === null
      ? null
      : (allItems.find(
          (item): item is Extract<TranscriptItem, { kind: "summary" }> =>
            item.kind === "summary" && item.workflowId === effectiveSelected,
        )?.recordId ?? null);
  const selectedRecordId = selectedConversation?.recordId ?? selectedSummaryRecordId;

  const handleGenerateReport = (detailLevel: "summary" | "full"): void => {
    if (selectedRecordId === null) return;
    const recordId = selectedRecordId;
    setError(null);
    client
      .report(recordId, detailLevel)
      .then((result) => {
        if (result.ok) {
          setReport({ markdown: result.markdown, error: null });
          setReportReady((previous) => new Set(previous).add(recordId));
        } else {
          const detail = result.message === "" ? "" : ` · ${result.message}`;
          setReport({ markdown: null, error: `生成失败：${result.errorCode}${detail}` });
        }
      })
      .catch((cause: unknown) => setReport({ markdown: null, error: messageOf(cause) }));
  };

  const handleExport = (object: "record" | "report"): void => {
    if (selectedRecordId === null) return;
    setError(null);
    setNotice(null);
    client
      .export(selectedRecordId, object)
      .then((result) => {
        if (result.ok) {
          // Honest: accepted by the endpoint is not the same as indexed (ADR-005 §4).
          setNotice("导出：端点已接收（≠ 已被收录；是否收录由 KB 审核人员决定）");
        } else if (result.errorCode === "export_unavailable") {
          setNotice("导出失败：未配置 KB 端点");
        } else {
          const detail = result.message === null ? "" : ` · ${result.message}`;
          setNotice(`导出失败：${result.errorCode ?? "export_failed"}${detail}`);
        }
      })
      .catch((cause: unknown) => setError(messageOf(cause)));
  };

  const handleCopyReport = (): void => {
    if (report === null || report.markdown === null) return;
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) {
      setNotice("复制不可用，请手动选择文本");
      return;
    }
    clipboard.writeText(report.markdown).then(
      () => setNotice("已复制报告"),
      () => setNotice("复制失败，请手动选择文本"),
    );
  };

  const handleSaveReport = (): void => {
    if (report === null || report.markdown === null) return;
    const name = selectedRecordId === null ? "report.md" : `report-${selectedRecordId}.md`;
    client
      .saveText(name, report.markdown)
      .then((result) => {
        if (result.saved) setNotice(`已保存报告：${result.path ?? ""}`);
      })
      .catch((cause: unknown) => setError(messageOf(cause)));
  };

  const handlePreviewBlob = (contentRef: string, mediaType: string): void => {
    setError(null);
    client
      .blobPreview(contentRef, mediaType)
      .then(setBlob)
      .catch((cause: unknown) => setError(messageOf(cause)));
  };

  const handleSaveBlob = (contentRef: string, mediaType: string, name?: string): void => {
    setError(null);
    client
      .blobSave(contentRef, mediaType, name)
      .then((result) => {
        if (result.saved) setNotice(`已保存：${result.path ?? ""}`);
      })
      .catch((cause: unknown) => setError(messageOf(cause)));
  };

  return (
    <div className="app" data-testid="app">
      <ConversationList conversations={list} selected={effectiveSelected} onSelect={setSelected} />
      <main className="thread">
        <ProgressHeader items={viewItems} connection={ui.snapshot.connection} />
        <button type="button" className="open-settings" onClick={() => setSettingsOpen(true)}>
          设置
        </button>
        {error !== null && <p role="alert">{error}</p>}
        {notice !== null && <p role="status">{notice}</p>}
        {selectedConversation !== null && !selectedConversation.live && (
          <p className="past-note">往期记录</p>
        )}
        <Transcript items={viewItems} onAnswer={handleAnswer} />
        {/* The composer only opens a *new* conversation, so it is always
            available (disabled while anything is running) — including when the
            list is empty or a past record is selected. */}
        <Composer disabled={anyRunning || submitting} onSubmit={handleSubmit} />
      </main>
      <Workbench
        key={effectiveSelected ?? "none"}
        items={viewItems}
        cancelling={selectedCancelling}
        canCancel={canCancel}
        onCancel={handleCancel}
        recordId={selectedRecordId}
        reportReady={selectedRecordId !== null && reportReady.has(selectedRecordId)}
        onGenerateReport={handleGenerateReport}
        onExport={handleExport}
        onPreviewBlob={handlePreviewBlob}
        onSaveBlob={handleSaveBlob}
      />
      {blob !== null && (
        <div className="blob-viewer" data-testid="blob-viewer" role="dialog" aria-modal="true">
          <header>
            <span>附件 / 证据</span>
            <button type="button" onClick={() => setBlob(null)}>
              关闭
            </button>
          </header>
          {blob.kind === "text" && <pre className="blob-text">{blob.text}</pre>}
          {blob.kind === "image" && <img className="blob-image" src={blob.dataUrl} alt="证据" />}
          {blob.kind === "binary" && <p>这是二进制内容（{blob.size} 字节），请用「另存」保存。</p>}
        </div>
      )}
      {report !== null && (
        <ReportViewer
          markdown={report.markdown}
          error={report.error}
          onCopy={handleCopyReport}
          onSave={handleSaveReport}
          onClose={() => setReport(null)}
        />
      )}
    </div>
  );
}
