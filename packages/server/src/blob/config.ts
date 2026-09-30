import { randomBytes } from "node:crypto";

export interface BlobConfig {
  /** Where the signed URLs point; a function so it can be resolved after listen. */
  baseUrl: () => string;
  dataDir: string;
  secret: string;
  /** How long an issued URL stays usable. */
  tokenTtlMs: number;
  /** How long a blob is kept before it becomes eligible for collection. */
  retentionMs: number;
  maxBlobBytes: number;
  /** Registered, NOT enforced (see the plan): the client chooses to offload. */
  inlineThresholdBytes: number;
  allowedMediaTypes: ReadonlySet<string>;
}

/**
 * The media types an MVP diagnosis produces: logs, structured dumps, archives,
 * screenshots. `application/octet-stream` is included on purpose — a provider
 * that cannot name its format still has to be able to send it, and the channel
 * is not the place to guess.
 */
export const DEFAULT_ALLOWED_MEDIA_TYPES: ReadonlySet<string> = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "application/json",
  "application/zip",
  "application/gzip",
  "application/octet-stream",
  "image/png",
  "image/jpeg",
]);

export const DEFAULT_BLOB_CONFIG: BlobConfig = {
  baseUrl: () => "http://127.0.0.1:8080",
  dataDir: ".adt/blobs",
  secret: "",
  tokenTtlMs: 15 * 60 * 1000,
  retentionMs: 30 * 24 * 60 * 60 * 1000,
  maxBlobBytes: 512 * 1024 * 1024,
  inlineThresholdBytes: 64 * 1024,
  allowedMediaTypes: DEFAULT_ALLOWED_MEDIA_TYPES,
};

/**
 * Reads the BLOB_* environment. A missing secret is generated per boot and
 * warned about: a hard-coded default would be worse (it would make every
 * deployment's URLs forgeable), and the only cost is that URLs do not survive a
 * restart.
 */
export function blobConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BlobConfig {
  const generated = env.BLOB_SECRET ? null : randomBytes(32).toString("hex");
  if (generated) {
    console.warn(
      "[blob] BLOB_SECRET is not set; signing tokens with an ephemeral secret (issued URLs will not survive a restart)",
    );
  }

  const base = env.BLOB_BASE_URL ?? DEFAULT_BLOB_CONFIG.baseUrl();
  const int = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    ...DEFAULT_BLOB_CONFIG,
    baseUrl: () => base,
    dataDir: env.BLOB_DATA_DIR ?? DEFAULT_BLOB_CONFIG.dataDir,
    secret: env.BLOB_SECRET ?? generated!,
    tokenTtlMs: int(env.BLOB_TOKEN_TTL_MS, DEFAULT_BLOB_CONFIG.tokenTtlMs),
    retentionMs: int(env.BLOB_RETENTION_MS, DEFAULT_BLOB_CONFIG.retentionMs),
    maxBlobBytes: int(env.BLOB_MAX_BYTES, DEFAULT_BLOB_CONFIG.maxBlobBytes),
  };
}
