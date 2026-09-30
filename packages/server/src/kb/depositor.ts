import type { KbConfig } from "./config";
import type { DepositPayload } from "./deposit";

/** ADR-005 §5 — the only two ways a deposit can fail on the way out. */
export type DepositOutcome =
  | { status: "ok" }
  | { status: "failed"; error_code: "export_unavailable" | "export_failed"; message: string };

/**
 * The outbound seam. The protocol layer depends on this, not on HTTP, so the
 * failure branches can be tested without a network.
 */
export interface KnowledgeDepositor {
  deposit(payload: DepositPayload): Promise<DepositOutcome>;
}

/**
 * A transient status is worth another attempt; a 4xx is a verdict, not a hiccup
 * (ADR-005 §5).
 */
const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

const MAX_SNIPPET = 200;

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** A short, token-free excerpt of the response body for the human to read. */
async function readSnippet(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}…` : text;
  } catch {
    return "";
  }
}

export interface HttpDepositorDeps {
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Injectable for tests, so a retry does not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * POSTs the deposit to the configured endpoint (ADR-005 §2/§3), retrying
 * network errors, timeouts and 5xx/429 with exponential backoff.
 *
 * Note this is deliberately *not* the LLM provider's policy: ADR-005 §5 lists
 * timeouts as retryable, so they are retried here. The worst case is therefore
 * `timeoutMs × (maxRetries + 1)` plus the backoff sum.
 */
export function createHttpDepositor(config: KbConfig, deps: HttpDepositorDeps = {}): KnowledgeDepositor {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const authValue = config.authScheme ? `${config.authScheme} ${config.token}` : config.token;

  return {
    async deposit(payload: DepositPayload): Promise<DepositOutcome> {
      let lastMessage = "the deposit was never attempted";

      for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
        if (attempt > 0) {
          await sleep(config.retryBaseMs * 2 ** (attempt - 1));
        }

        let response: Response;
        try {
          response = await fetchImpl(config.endpointUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [config.authHeader]: authValue,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(config.timeoutMs),
          });
        } catch (error) {
          lastMessage = `KB endpoint unreachable: ${describeError(error)}`;
          continue;
        }

        if (response.ok) return { status: "ok" };

        const snippet = await readSnippet(response);
        lastMessage = `KB endpoint responded ${response.status}${snippet ? `: ${snippet}` : ""}`;
        if (!isRetryableStatus(response.status)) break;
      }

      return { status: "failed", error_code: "export_failed", message: lastMessage };
    },
  };
}
