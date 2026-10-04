import { describe, it, expect } from "vitest";
import { startTestServer } from "@adt/test-support";

import { DaemonConnection } from "../src/connection";

const credentials = { username: "alice", secret: "pw-alice" };
const clientInfo = { name: "close-test", platform: "test" };

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe("DaemonConnection close notification", () => {
  it("fires onClose when the transport drops", async () => {
    const srv = await startTestServer({});
    let closed = 0;
    const connection = await DaemonConnection.connect({
      url: srv.url,
      credentials,
      clientInfo,
      capabilities: [],
    });
    connection.onClose(() => {
      closed++;
    });

    await srv.close();
    await tick();
    expect(closed).toBeGreaterThan(0);
  });

  it("does not fire on a deliberate close()", async () => {
    const srv = await startTestServer({});
    let closed = 0;
    const connection = await DaemonConnection.connect({
      url: srv.url,
      credentials,
      clientInfo,
      capabilities: [],
    });
    connection.onClose(() => {
      closed++;
    });

    await connection.close();
    await tick();
    expect(closed).toBe(0);
    await srv.close();
  });

  it("reports isClosed after a deliberate close", async () => {
    const srv = await startTestServer({});
    const connection = await DaemonConnection.connect({
      url: srv.url,
      credentials,
      clientInfo,
      capabilities: [],
    });
    expect(connection.isClosed()).toBe(false);
    await connection.close();
    expect(connection.isClosed()).toBe(true);
    await srv.close();
  });
});
