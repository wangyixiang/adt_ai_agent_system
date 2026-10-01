import type { IncomingAttachment } from "../../shared/contract";

/** Base64 across chunks — `String.fromCharCode(...bytes)` overflows on big files. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** A pasted block of text becomes a plain-text attachment. */
export function textToIncoming(text: string, name = "pasted.txt"): IncomingAttachment {
  return { name, mediaType: "text/plain", dataBase64: toBase64(new TextEncoder().encode(text)) };
}

/** Read a file's bytes. `FileReader` (not `File.arrayBuffer`) — jsdom has only the former. */
function readBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error("could not read the file"));
    reader.readAsArrayBuffer(file);
  });
}

/** Read a chosen/dropped file's bytes through the web File API (no Node). */
export async function fileToIncoming(file: File): Promise<IncomingAttachment> {
  const bytes = await readBytes(file);
  return {
    name: file.name,
    mediaType: file.type === "" ? "application/octet-stream" : file.type,
    dataBase64: toBase64(bytes),
  };
}
