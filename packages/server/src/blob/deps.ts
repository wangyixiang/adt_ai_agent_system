import type { BlobConfig } from "./config";
import type { BlobRepository } from "./repository";
import type { BlobStore } from "./store";
import type { BlobTokenSigner } from "./token";

/**
 * Everything the blob channel needs, in one object: the WS allocation handler
 * and the HTTP transfer routes take the same set, so they cannot drift apart
 * (or grow two half-populated variants).
 */
export interface BlobDeps {
  repository: BlobRepository;
  store: BlobStore;
  signer: BlobTokenSigner;
  config: BlobConfig;
  /** How often the expiry sweeper runs (default 10 minutes). */
  lifecycleIntervalMs?: number;
}
