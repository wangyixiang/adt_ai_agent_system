import type { AdtBridge } from "../../shared/contract";

declare global {
  interface Window {
    adt: AdtBridge;
  }
}

export {};
