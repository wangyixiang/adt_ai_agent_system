import type { AdtBridge } from "../../shared/contract";

/** The renderer's whole client: the preload bridge, nothing else. */
export type AdtClient = AdtBridge;

export function appClient(): AdtClient {
  return window.adt;
}
