import { describe, it, expect } from "vitest";
import { newContentRefId } from "../../src/protocol/ids";

describe("blob protocol", () => {
  it("mints content refs with a recognisable prefix and no collisions", () => {
    const a = newContentRefId();
    const b = newContentRefId();
    expect(a).toMatch(/^blob_[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
