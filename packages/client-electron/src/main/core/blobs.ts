import type { UiBlobPreview } from "../../shared/contract";

/** Text larger than this is not worth inlining into the DOM. */
const TEXT_CAP_BYTES = 256 * 1024;
/** Images larger than this are offered as a download instead. */
const IMAGE_CAP_BYTES = 4 * 1024 * 1024;

/**
 * How to show a blob's bytes: text, an image data-URL, or "too big / not a type
 * we render — offer a save". The bytes are already verified (sha256) upstream.
 */
export function classifyBlob(bytes: Uint8Array, mediaType: string): UiBlobPreview {
  if (mediaType.startsWith("text/") || mediaType === "application/json") {
    if (bytes.length > TEXT_CAP_BYTES) return { kind: "binary", mediaType, size: bytes.length };
    return { kind: "text", mediaType, text: Buffer.from(bytes).toString("utf8") };
  }
  if (mediaType.startsWith("image/")) {
    if (bytes.length > IMAGE_CAP_BYTES) return { kind: "binary", mediaType, size: bytes.length };
    return {
      kind: "image",
      mediaType,
      dataUrl: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
    };
  }
  return { kind: "binary", mediaType, size: bytes.length };
}
