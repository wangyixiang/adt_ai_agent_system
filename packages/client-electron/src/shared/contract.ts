/**
 * The IPC contract between the renderer and main (ADR-006): the renderer is a
 * client of the daemon that lives in main, and this is the whole surface. No
 * Node, no Server protocol, no credentials beyond the login call.
 */
import type { Answer } from "@adt/shared";

import type { UiSnapshot } from "./ui";

export const IPC = {
  /** `renderer → main` request/response (`ipcRenderer.invoke`). */
  invoke: "adt:invoke",
  /** `main → renderer` push (`webContents.send`). */
  event: "adt:event",
} as const;

export type RendererRequest =
  | { kind: "snapshot" }
  | { kind: "login"; username: string; secret: string }
  | { kind: "submit"; text: string }
  | { kind: "answer"; askId: string; answer: Answer };

export type MainEvent = { type: "state"; snapshot: UiSnapshot } | { type: "ui"; event: import("./ui").UiEvent };

/** What preload exposes on `window.adt`. */
export interface AdtBridge {
  snapshot(): Promise<UiSnapshot>;
  login(username: string, secret: string): Promise<void>;
  submit(text: string): Promise<string>;
  answer(askId: string, answer: Answer): Promise<void>;
  onEvent(listener: (event: MainEvent) => void): () => void;
}

export type { UiEvent, UiEventInput, UiSnapshot, UiStep, UiWorkflow } from "./ui";
