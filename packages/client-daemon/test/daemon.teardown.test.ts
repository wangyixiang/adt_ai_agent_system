import { describe, it, expect, vi } from "vitest";
import { startTestServer } from "@adt/test-support";

const spies = vi.hoisted(() => ({ close: vi.fn() }));

// Wrap the ledger factory so we can see the teardown without reaching into the
// daemon's internals; the real ledger still backs the daemon during the test.
vi.mock("../src/ledger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ledger")>();
  return {
    ...actual,
    openLedger: (location: string) => {
      const ledger = actual.openLedger(location);
      return {
        ...ledger,
        close: () => {
          spies.close(location);
          ledger.close();
        },
      };
    },
  };
});

const { ClientDaemon } = await import("../src/daemon");

/**
 * The daemon only owns the ledger it created itself. A handshake that fails
 * (bad credentials, server gone) must still close it — otherwise every failed
 * connect leaks a SQLite handle.
 */
describe("client daemon teardown", () => {
  it("closes the ledger it created when the handshake never completes", async () => {
    const srv = await startTestServer({});
    spies.close.mockClear();

    try {
      await expect(
        ClientDaemon.connect({
          url: srv.url,
          credentials: { username: "alice", secret: "wrong-password" },
          clientInfo: { name: "leak-check", platform: "test" },
          workspaceRoot: process.cwd(),
        }),
      ).rejects.toBeDefined();

      expect(spies.close).toHaveBeenCalledTimes(1);
    } finally {
      await srv.close();
    }
  });
});
