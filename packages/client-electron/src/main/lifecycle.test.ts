import { describe, it, expect } from "vitest";

import { createLifecycle } from "./lifecycle";

function harness() {
  const calls: string[] = [];
  const lifecycle = createLifecycle({
    hideWindow: () => void calls.push("hide"),
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

  it("the tray's quit closes the daemon before quitting", async () => {
    const { lifecycle, calls } = harness();
    await lifecycle.onTrayQuit();
    expect(calls).toEqual(["close", "quit"]);
  });
});
