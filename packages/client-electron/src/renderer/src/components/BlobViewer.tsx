import type { UiBlobPreview } from "../../../shared/contract";

/**
 * The modal that shows a blob (an attachment or a step's evidence): text, an
 * image, or — for bytes we will not render — a hint to save it from the thread
 * or the workbench (spec §10).
 */
export function BlobViewer({ preview, onClose }: { preview: UiBlobPreview; onClose(): void }) {
  return (
    <div className="blob-viewer" data-testid="blob-viewer" role="dialog" aria-modal="true">
      <header>
        <span>附件 / 证据</span>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </header>
      {preview.kind === "text" && <pre className="blob-text">{preview.text}</pre>}
      {preview.kind === "image" && <img className="blob-image" src={preview.dataUrl} alt="证据" />}
      {preview.kind === "binary" && (
        <p>这是二进制内容（{preview.size} 字节）；请在转录或工作栏用「另存」保存。</p>
      )}
    </div>
  );
}
