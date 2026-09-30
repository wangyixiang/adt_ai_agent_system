import { describe, it, expect } from "vitest";
import { createHttpDepositor } from "../../src/kb/depositor";
import { kbConfigFromEnv, kbWorstCaseMs } from "../../src/kb/config";
import type { DepositPayload } from "../../src/kb/deposit";

const payload = { deposit_id: "dep_1" } as unknown as DepositPayload;
const config = {
  endpointUrl: "http://kb.test/deposit",
  authHeader: "Authorization",
  authScheme: "Bearer",
  token: "s3cret",
  timeoutMs: 50,
  maxRetries: 2,
  retryBaseMs: 500,
};

function depositorWith(responses: Array<Response | Error>, over: Record<string, unknown> = {}) {
  let attempts = 0;
  const sleeps: number[] = [];
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const depositor = createHttpDepositor(
    { ...config, ...over },
    {
      sleep: async (ms) => { sleeps.push(ms); },
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        const next = responses[Math.min(attempts, responses.length - 1)]!;
        attempts++;
        if (next instanceof Error) throw next;
        return next;
      }) as unknown as typeof fetch,
    },
  );
  return { depositor, attempts: () => attempts, sleeps, seen };
}

describe("HttpKnowledgeDepositor", () => {
  it("posts the deposit with the configured auth", async () => {
    const h = depositorWith([new Response(null, { status: 202 })]);

    expect(await h.depositor.deposit(payload)).toEqual({ status: "ok" });
    expect(h.seen[0]!.url).toBe("http://kb.test/deposit");
    expect((h.seen[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer s3cret");
    expect(h.seen[0]!.init.body).toBe(JSON.stringify(payload));
  });

  it("retries a 5xx and a network error, then succeeds", async () => {
    const h = depositorWith([
      new Response("boom", { status: 503 }),
      new TypeError("fetch failed"),
      new Response(null, { status: 200 }),
    ]);

    expect(await h.depositor.deposit(payload)).toEqual({ status: "ok" });
    expect(h.attempts()).toBe(3);
    expect(h.sleeps).toEqual([500, 1000]);
  });

  it("does not retry a 4xx and explains it", async () => {
    const h = depositorWith([new Response("bad format", { status: 422 })]);

    const outcome = await h.depositor.deposit(payload);
    expect(outcome).toMatchObject({ status: "failed", error_code: "export_failed" });
    expect(h.attempts()).toBe(1);
  });

  it("gives up after the configured attempts", async () => {
    const h = depositorWith([new Response("boom", { status: 500 })], { maxRetries: 1 });

    expect(await h.depositor.deposit(payload)).toMatchObject({
      status: "failed",
      error_code: "export_failed",
    });
    expect(h.attempts()).toBe(2);
  });

  it("never leaks the token in a failure message", async () => {
    const h = depositorWith([new Response("denied", { status: 401 })]);

    const outcome = await h.depositor.deposit(payload);
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain("s3cret");
  });

  it("scrubs the token even when the endpoint echoes it back", async () => {
    const h = depositorWith([new Response("denied for s3cret", { status: 401 })]);

    const outcome = await h.depositor.deposit(payload);
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain("s3cret");
  });

  it("never leaks a credential embedded in the endpoint URL", async () => {
    // Node's fetch rejects a URL with userinfo, and its message quotes the URL.
    const h = depositorWith(
      [
        new TypeError(
          "Request cannot be constructed from a URL that includes credentials: http://user:hunter2@kb.test/deposit",
        ),
      ],
      { endpointUrl: "http://user:hunter2@kb.test/deposit" },
    );

    const outcome = await h.depositor.deposit(payload);
    expect(outcome.status).toBe("failed");
    expect(JSON.stringify(outcome)).not.toContain("hunter2");
  });

  it("does not retry a 429, because ADR-005 §5 lists only network errors, timeouts and 5xx", async () => {
    const h = depositorWith([new Response("slow down", { status: 429 })]);

    const outcome = await h.depositor.deposit(payload);
    expect(outcome).toMatchObject({ status: "failed", error_code: "export_failed" });
    expect(h.attempts()).toBe(1);
  });

  it("retries a timeout, because ADR-005 §5 lists it as retryable", async () => {
    // Deliberately different from the LLM provider, which does not retry its own
    // timeout; here the contract says to retry, so the worst case is bounded by
    // the documented `timeout × (maxRetries + 1)`.
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const h = depositorWith([timeout, new Response(null, { status: 200 })]);

    expect(await h.depositor.deposit(payload)).toEqual({ status: "ok" });
    expect(h.attempts()).toBe(2);
  });
});

describe("kbConfigFromEnv", () => {
  it("is unavailable without an endpoint or without credentials", () => {
    expect(kbConfigFromEnv({})).toBeNull();
    expect(kbConfigFromEnv({ KB_ENDPOINT_URL: "http://kb.test" })).toBeNull();
    expect(kbConfigFromEnv({ KB_TOKEN: "t" })).toBeNull();
    expect(kbConfigFromEnv({ KB_ENDPOINT_URL: "", KB_TOKEN: "t" })).toBeNull();
  });

  it("falls back when the retry count is above the cap", () => {
    const env = { KB_ENDPOINT_URL: "http://kb.test", KB_TOKEN: "t" };

    expect(kbConfigFromEnv({ ...env, KB_MAX_RETRIES: "11" })!.maxRetries).toBe(2);
    expect(kbConfigFromEnv({ ...env, KB_MAX_RETRIES: "1000000000" })!.maxRetries).toBe(2);
  });

  it("applies the documented defaults and honours overrides", () => {
    const base = kbConfigFromEnv({ KB_ENDPOINT_URL: "http://kb.test", KB_TOKEN: "t" })!;
    expect(base).toMatchObject({
      authHeader: "Authorization",
      authScheme: "Bearer",
      timeoutMs: 10_000,
      maxRetries: 2,
    });

    const custom = kbConfigFromEnv({
      KB_ENDPOINT_URL: "http://kb.test",
      KB_TOKEN: "t",
      KB_AUTH_HEADER: "X-API-Key",
      KB_AUTH_SCHEME: "",
      KB_TIMEOUT_MS: "3000",
      KB_MAX_RETRIES: "0",
    })!;
    expect(custom).toMatchObject({
      authHeader: "X-API-Key",
      authScheme: "",
      timeoutMs: 3000,
      maxRetries: 0,
    });
  });
});

describe("kbWorstCaseMs", () => {
  it("bounds a synchronous export by timeout × attempts plus the backoff sum", () => {
    const config = kbConfigFromEnv({ KB_ENDPOINT_URL: "http://kb.test", KB_TOKEN: "t" })!;

    // 10_000 × (2 + 1) attempts + (500 + 1000) backoff.
    expect(kbWorstCaseMs(config)).toBe(31_500);
  });

  it("shrinks as retries are disabled", () => {
    const config = kbConfigFromEnv({ KB_ENDPOINT_URL: "http://kb.test", KB_TOKEN: "t" })!;

    expect(kbWorstCaseMs({ ...config, maxRetries: 0 })).toBe(10_000);
  });
});
