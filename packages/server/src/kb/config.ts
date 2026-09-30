/**
 * KB outbound configuration (ADR-005 §2).
 *
 * Env-only: credentials never reach the Client, a Record, or a log line.
 */
export interface KbConfig {
  endpointUrl: string;
  authHeader: string;
  authScheme: string;
  token: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
}

const DEFAULT_AUTH_HEADER = "Authorization";
const DEFAULT_AUTH_SCHEME = "Bearer";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 500;

/**
 * A missing or unusable value falls back to the default rather than silently
 * disabling retries: `Number("")` is `0`, which would read as "retry nothing".
 */
function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * ADR-005 §5 — an unconfigured endpoint **or** missing credentials means export
 * is unavailable. Returning `null` is the honest answer; it is never a silent
 * attempt against some default.
 */
export function kbConfigFromEnv(env: Record<string, string | undefined>): KbConfig | null {
  const endpointUrl = env.KB_ENDPOINT_URL?.trim() ?? "";
  const token = env.KB_TOKEN?.trim() ?? "";
  if (endpointUrl === "" || token === "") return null;

  const authHeader = env.KB_AUTH_HEADER ?? DEFAULT_AUTH_HEADER;
  return {
    endpointUrl,
    // An empty header *name* is unusable, so it falls back; an empty scheme is
    // meaningful and kept (it means "send the raw token", for `X-API-Key`-style
    // headers).
    authHeader: authHeader.trim() === "" ? DEFAULT_AUTH_HEADER : authHeader,
    authScheme: env.KB_AUTH_SCHEME ?? DEFAULT_AUTH_SCHEME,
    token,
    timeoutMs: parseNonNegativeInt(env.KB_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxRetries: parseNonNegativeInt(env.KB_MAX_RETRIES, DEFAULT_MAX_RETRIES),
    retryBaseMs: DEFAULT_RETRY_BASE_MS,
  };
}

/**
 * Worst-case wall time one **synchronous** export can hold a connection open
 * (ADR-005 §4): every attempt gets its own timeout window, plus the backoff sum.
 *
 * Worth comparing against the heartbeat liveness threshold: the message router
 * serializes per connection, so a blocked export also blocks that connection's
 * heartbeats.
 */
export function kbWorstCaseMs(config: KbConfig): number {
  let backoff = 0;
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    backoff += config.retryBaseMs * 2 ** (attempt - 1);
  }
  return config.timeoutMs * (config.maxRetries + 1) + backoff;
}
