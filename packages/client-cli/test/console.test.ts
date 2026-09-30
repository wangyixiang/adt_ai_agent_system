import { describe, it, expect } from "vitest";
import { createPromptQueue, buildHostCallbacks, parseArgs } from "../src/console";

function scripted(lines: string[]) {
  const asked: string[] = [];
  const printed: string[] = [];
  const prompter = {
    ask: async (q: string) => {
      asked.push(q);
      return lines.shift() ?? "";
    },
    print: (l: string) => void printed.push(l),
  };
  return { prompter, asked, printed };
}

describe("createPromptQueue", () => {
  it("never lets two questions be pending at once", async () => {
    const { prompter, asked } = scripted(["first", "second"]);
    const queue = createPromptQueue(prompter);

    const [a, b] = await Promise.all([queue.ask("q1? "), queue.ask("q2? ")]);
    expect([a, b]).toEqual(["first", "second"]);
    expect(asked).toEqual(["q1? ", "q2? "]);
  });
});

describe("buildHostCallbacks", () => {
  it("re-asks an unparseable confirmation instead of assuming yes", async () => {
    const { prompter, asked, printed } = scripted(["maybe", "y"]);
    const callbacks = buildHostCallbacks(createPromptQueue(prompter), (l) => void printed.push(l));

    const approved = await callbacks.onConfirmationRequired!({
      workflowId: "wf_1",
      stepId: "st_1",
      capability: "sim_rig.trigger_reset",
      objective: "复位",
      input: {},
    });

    expect(approved).toBe(true);
    expect(asked).toHaveLength(2); // asked once, refused to guess, asked again
  });

  it("declines on EOF rather than approving", async () => {
    const { prompter } = scripted([]); // immediately empty ⇒ EOF
    const callbacks = buildHostCallbacks(createPromptQueue(prompter), () => {});

    const approved = await callbacks.onConfirmationRequired!({
      workflowId: "wf_1",
      stepId: "st_1",
      capability: "sim_rig.trigger_reset",
      objective: "复位",
      input: {},
    });

    expect(approved).toBe(false);
  });

  it("defaults a resource conflict to stop", async () => {
    const { prompter } = scripted([]);
    const callbacks = buildHostCallbacks(createPromptQueue(prompter), () => {});

    const answer = await callbacks.onResourceConflict!({
      workflowId: "wf_1",
      stepId: "st_1",
      capability: "sim_rig.trigger_reset",
      objective: "复位",
    });

    expect(answer).toBe("stop");
  });

  it("shows the human what they are being asked to approve", async () => {
    const { prompter, asked } = scripted(["y"]);
    const callbacks = buildHostCallbacks(createPromptQueue(prompter), () => {});

    await callbacks.onConfirmationRequired!({
      workflowId: "wf_1",
      stepId: "st_1",
      capability: "sim_rig.trigger_reset",
      objective: "复位测试台",
      input: { rig: "A" },
    });

    // Approving without knowing what you are approving is not consent.
    expect(asked[0]).toContain("复位测试台");
    expect(asked[0]).toContain("sim_rig.trigger_reset");
    expect(asked[0]).toContain("A");
  });

  it("passes manual feedback through, and gives none when the human says nothing", async () => {
    const { prompter } = scripted(["succeeded: 灯变绿"]);
    const callbacks = buildHostCallbacks(createPromptQueue(prompter), () => {});

    expect(
      await callbacks.onUserInput!({
        workflowId: "wf_1",
        stepId: "st_1",
        capability: "human.manual_action",
        objective: "手动复位",
        input: {},
      }),
    ).toEqual({ outcome: "succeeded", observation: "灯变绿" });

    // The daemon's contract is `undefined` = "no feedback"; the parser's `null`
    // must not leak through as a made-up outcome.
    const quiet = buildHostCallbacks(createPromptQueue(scripted([]).prompter), () => {});
    expect(
      await quiet.onUserInput!({
        workflowId: "wf_1",
        stepId: "st_1",
        capability: "human.manual_action",
        objective: "手动复位",
        input: {},
      }),
    ).toBeUndefined();
  });
});

describe("parseArgs", () => {
  it("reads the flags, and falls back to the environment for the secret", () => {
    const args = parseArgs(
      [
        "--url",
        "ws://elsewhere/ws",
        "--user",
        "alice",
        "--workspace",
        "D:/ws",
        "--ledger",
        "l.db",
        "--session",
        "s.json",
      ],
      { ADT_SECRET: "from-env" },
    );

    expect(args).toMatchObject({
      url: "ws://elsewhere/ws",
      username: "alice",
      secret: "from-env",
      ledgerPath: "l.db",
      sessionPath: "s.json",
    });
  });

  it("prefers an explicit secret, and reports a missing one as null", () => {
    expect(parseArgs(["--user", "alice", "--secret", "typed"], { ADT_SECRET: "env" }).secret).toBe(
      "typed",
    );
    // `null` means "ask without echoing" — never "no secret".
    expect(parseArgs(["--user", "alice"], {}).secret).toBeNull();
  });

  it("defaults to the local server and file-backed stores", () => {
    const args = parseArgs(["--user", "alice"], {});

    expect(args.url).toBe("ws://127.0.0.1:8080/ws");
    expect(args.ledgerPath).toBe(".adt/client-cli/ledger.db");
    expect(args.sessionPath).toBe(".adt/client-cli/session.json");
    expect(args.workspaceRoot).toBe(process.cwd());
  });

  it("ignores a bare -- separator instead of eating the next flag", () => {
    // `pnpm -C packages/client-cli start -- --user x` hands tsx a literal "--".
    expect(parseArgs(["--", "--user", "alice"], {}).username).toBe("alice");
  });
});
