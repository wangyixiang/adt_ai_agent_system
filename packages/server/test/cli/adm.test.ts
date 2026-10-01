import { describe, it, expect } from "vitest";

import { runAdm, type AdmUsers } from "../../src/cli/adm";

function fakeUsers(): AdmUsers & { rows: Map<string, { disabled: boolean; secret: string }> } {
  const rows = new Map<string, { disabled: boolean; secret: string }>();
  return {
    rows,
    create: async (username, secret) => {
      if (rows.has(username)) throw new Error("exists");
      rows.set(username, { disabled: false, secret });
    },
    list: async () => [...rows].map(([username, row]) => ({ username, disabled: row.disabled })),
    setDisabled: async (username, disabled) => {
      const row = rows.get(username);
      if (!row) return false;
      row.disabled = disabled;
      return true;
    },
    changePassword: async (username, secret) => {
      const row = rows.get(username);
      if (!row) return false;
      row.secret = secret;
      return true;
    },
  };
}

function capture(): { io: { out: (l: string) => void; err: (l: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } };
}

describe("adm", () => {
  it("adds an account, then lists it", async () => {
    const users = fakeUsers();
    const { io, out } = capture();
    expect(await runAdm(["user", "add", "alice"], users, io, "pw-alice")).toBe(0);
    expect(await runAdm(["user", "list"], users, io)).toBe(0);
    expect(out.join("\n")).toContain("alice");
  });

  it("never prints the secret or a hash", async () => {
    const users = fakeUsers();
    const { io, out, err } = capture();
    await runAdm(["user", "add", "alice", "--secret", "s3cr3t"], users, io);
    await runAdm(["user", "list"], users, io);
    const printed = [...out, ...err].join("\n");
    expect(printed).not.toContain("s3cr3t");
    expect(printed).not.toContain("hash");
  });

  it("disables and enables an account", async () => {
    const users = fakeUsers();
    const { io } = capture();
    await runAdm(["user", "add", "alice", "--secret", "x"], users, io);
    expect(await runAdm(["user", "disable", "alice"], users, io)).toBe(0);
    expect(users.rows.get("alice")!.disabled).toBe(true);
    expect(await runAdm(["user", "enable", "alice"], users, io)).toBe(0);
    expect(users.rows.get("alice")!.disabled).toBe(false);
  });

  it("changes a password, and reports an unknown user", async () => {
    const users = fakeUsers();
    const { io } = capture();
    await runAdm(["user", "add", "alice", "--secret", "old"], users, io);
    expect(await runAdm(["user", "passwd", "alice"], users, io, "new")).toBe(0);
    expect(users.rows.get("alice")!.secret).toBe("new");
    expect(await runAdm(["user", "passwd", "ghost"], users, io, "x")).toBe(1);
  });

  it("returns 2 on usage errors (unknown command, missing secret)", async () => {
    const users = fakeUsers();
    const { io } = capture();
    expect(await runAdm(["user", "frobnicate"], users, io)).toBe(2);
    expect(await runAdm(["user", "add", "bob"], users, io)).toBe(2);
  });

  it("refuses to silently overwrite an existing account", async () => {
    const users = fakeUsers();
    const { io } = capture();
    await runAdm(["user", "add", "alice", "--secret", "one"], users, io);
    expect(await runAdm(["user", "add", "alice", "--secret", "two"], users, io)).toBe(1);
    expect(users.rows.get("alice")!.secret).toBe("one");
  });
});
