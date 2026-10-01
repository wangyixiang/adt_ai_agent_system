import { describe, it, expect } from "vitest";

import { installGracefulShutdown } from "../src/shutdown";

interface Harness {
  fire(signal: "SIGTERM" | "SIGINT"): void;
  readonly closes: number;
  readonly exits: number[];
  readonly errors: string[];
  resolveClose(): void;
  rejectClose(error: Error): void;
}

function harness(): Harness {
  const handlers = new Map<string, () => void>();
  let resolveClose!: () => void;
  let rejectClose!: (error: unknown) => void;
  let closes = 0;
  const exits: number[] = [];
  const errors: string[] = [];

  installGracefulShutdown({
    target: {
      close: () => {
        closes++;
        return new Promise<void>((resolve, reject) => {
          resolveClose = resolve;
          rejectClose = reject;
        });
      },
      on: (signal, handler) => handlers.set(signal, handler),
    },
    exit: (code) => exits.push(code),
    error: (message) => errors.push(message),
  });

  return {
    fire: (signal) => handlers.get(signal)?.(),
    get closes() {
      return closes;
    },
    exits,
    errors,
    resolveClose: () => resolveClose(),
    rejectClose: (error) => rejectClose(error),
  };
}

describe("installGracefulShutdown", () => {
  it("closes then exits 0 on the first signal", async () => {
    const h = harness();
    h.fire("SIGTERM");
    expect(h.closes).toBe(1);
    h.resolveClose();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.exits).toEqual([0]);
  });

  it("exits 1 immediately on a second signal", () => {
    const h = harness();
    h.fire("SIGTERM");
    h.fire("SIGINT");
    expect(h.exits).toEqual([1]);
  });

  it("still exits when close() rejects", async () => {
    const h = harness();
    h.fire("SIGTERM");
    h.rejectClose(new Error("boom"));
    await Promise.resolve();
    await Promise.resolve();
    expect(h.errors.join("\n")).toContain("boom");
    expect(h.exits).toEqual([1]);
  });
});
