import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import {
  buildHostCallbacks,
  createInFlight,
  createPromptQueue,
  parseArgs,
  readlinePrompter,
} from "../src/console";

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

  it("holds an inbound line back until the pending question is answered", async () => {
    // A dispatch that lands mid-question would otherwise print inside it.
    const lines: string[] = [];
    const resolvers: Array<(value: string) => void> = [];
    const queue = createPromptQueue({
      ask: (q: string) =>
        new Promise<string>((resolve) => {
          lines.push(`ASK ${q}`);
          resolvers.push(resolve);
        }),
      print: (line: string) => void lines.push(`OUT ${line}`),
    });

    const pending = queue.ask("继续吗？");
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the ask start
    expect(lines).toEqual(["ASK 继续吗？"]);

    queue.print("入站的一行");
    expect(lines).toEqual(["ASK 继续吗？"]); // held back, not printed inside it

    resolvers.shift()!("y");
    await pending;
    expect(lines).toEqual(["ASK 继续吗？", "OUT 入站的一行"]);
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

  it("prints a capability's input with a stable key order, like the dispatch does", async () => {
    // The same step is rendered twice (dispatch and prompt); they must read alike.
    const { prompter, asked } = scripted(["y"]);
    const callbacks = buildHostCallbacks(createPromptQueue(prompter), () => {});

    await callbacks.onConfirmationRequired!({
      workflowId: "wf_1",
      stepId: "st_1",
      capability: "sim_rig.trigger_reset",
      objective: "复位",
      input: { zeta: 1, alpha: 2 },
    });

    expect(asked[0]).toContain('{"alpha":2,"zeta":1}');
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

  it("re-asks when the feedback cannot be understood, instead of losing it", async () => {
    const { prompter, asked } = scripted(["done", "failed: 灯没变"]);
    const callbacks = buildHostCallbacks(createPromptQueue(prompter), () => {});

    expect(
      await callbacks.onUserInput!({
        workflowId: "wf_1",
        stepId: "st_1",
        capability: "human.manual_action",
        objective: "手动复位",
        input: {},
      }),
    ).toEqual({ outcome: "failed", observation: "灯没变" });
    expect(asked).toHaveLength(2);
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

  it("reports the flags it could not use, instead of dropping them silently", () => {
    const args = parseArgs(["--user", "alice", "--usr", "bob", "--url"], {});

    // A typo should say so, rather than only producing the usage line.
    expect(args.unknownFlags).toEqual(["--usr"]);
    expect(args.valuelessFlags).toEqual(["--url"]);
    expect(args.username).toBe("alice");
    expect(args.url).toBe("ws://127.0.0.1:8080/ws");
  });
});

describe("createInFlight", () => {
  it("waits for tracked work to settle before draining", async () => {
    const inFlight = createInFlight();
    let settled = false;
    inFlight.track(
      new Promise<void>((resolve) => {
        setTimeout(() => {
          settled = true;
          resolve();
        }, 20);
      }),
    );

    expect(settled).toBe(false);
    await inFlight.drain();
    expect(settled).toBe(true);
  });

  it("does not reject when the tracked work fails", async () => {
    const inFlight = createInFlight();
    inFlight.track(Promise.reject(new Error("boom")));

    await expect(inFlight.drain()).resolves.toBeUndefined();
  });
});

describe("readlinePrompter", () => {
  function harness() {
    const input = new PassThrough();
    const output = new PassThrough();
    let echoed = "";
    output.on("data", (chunk: Buffer) => {
      echoed += chunk.toString();
    });
    return {
      prompter: readlinePrompter(input, output),
      input,
      output,
      echoed: () => echoed,
    };
  }

  it("does not echo what is typed while the question is hidden", async () => {
    // A password must never reach the terminal, and — because the hidden prompt
    // shares the one readline interface — it must not be echoed by another one.
    const h = harness();
    const answer = h.prompter.askHidden("密码（不回显）：");
    h.input.write("hunter2\n");

    expect(await answer).toBe("hunter2");
    expect(h.echoed()).toContain("密码（不回显）：");
    expect(h.echoed()).not.toContain("hunter2");
    h.prompter.close();
  });

  it("echoes an ordinary question, so the human can see what they type", async () => {
    const h = harness();
    const answer = h.prompter.ask("> ");
    h.input.write(":help\n");

    expect(await answer).toBe(":help");
    expect(h.echoed()).toContain(":help");
    h.prompter.close();
  });
});
