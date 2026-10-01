import { describe, it, expect } from "vitest";

import { createLifecycle } from "./lifecycle";

function harness(options: { running?: boolean; confirm?: boolean } = {}) {
  const calls: string[] = [];
  const lifecycle = createLifecycle({
    hideWindow: () => void calls.push("hide"),
    hasRunningWorkflow: () => options.running ?? false,
    confirmQuit: async () => {
      calls.push("confirm");
      return options.confirm ?? true;
    },
    closeDaemon: () => {
      calls.push("close");
      return Promise.resolve();
    },
    quit: () => void calls.push("quit"),
  });
  return { lifecycle, calls };
}

describe("lifecycle", () => {
  it("closing the window hides it and keeps the daemon running", () => {
    const { lifecycle, calls } = harness();
    lifecycle.onWindowClose();
    expect(calls).toEqual(["hide"]);
  });

  it("quitting with nothing running closes the daemon and quits — no prompt", async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.onTrayQuit();
    expect(calls).toEqual(["close", "quit"]);
  });

  it("quitting with a live run asks first, and honours a cancel", async () => {
    const { lifecycle, calls } = harness({ running: true, confirm: false });
    await lifecycle.onTrayQuit();
    expect(calls).toEqual(["confirm"]);
  });

  it("quitting with a live run proceeds once confirmed", async () => {
    const { lifecycle, calls } = harness({ running: true, confirm: true });
    await lifecycle.onTrayQuit();
    expect(calls).toEqual(["confirm", "close", "quit"]);
  });
});
