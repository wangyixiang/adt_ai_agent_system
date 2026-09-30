import { describe, it, expect } from "vitest";
import { validateJsonSchema, findUnsupportedKeyword } from "../src";

describe("validateJsonSchema", () => {
  it("checks object required + property types", () => {
    const schema = {
      type: "object" as const,
      required: ["path"],
      properties: { path: { type: "string" as const } },
    };
    expect(validateJsonSchema(schema, { path: "/a" }).valid).toBe(true);
    const bad = validateJsonSchema(schema, { path: 7 });
    expect(bad.valid).toBe(false);
    expect(bad.errors.join(" ")).toMatch(/path/);
    expect(validateJsonSchema(schema, {}).valid).toBe(false);
  });

  it("checks enum, items and integer vs number", () => {
    expect(validateJsonSchema({ enum: ["a", "b"] }, "a").valid).toBe(true);
    expect(validateJsonSchema({ enum: ["a", "b"] }, "c").valid).toBe(false);
    expect(validateJsonSchema({ type: "array", items: { type: "string" } }, ["x"]).valid).toBe(true);
    expect(validateJsonSchema({ type: "array", items: { type: "string" } }, [1]).valid).toBe(false);
    expect(validateJsonSchema({ type: "integer" }, 1).valid).toBe(true);
    expect(validateJsonSchema({ type: "integer" }, 1.5).valid).toBe(false);
    expect(validateJsonSchema({ type: "number" }, 1.5).valid).toBe(true);
  });

  it("rejects unsupported keywords rather than passing them silently", () => {
    expect(findUnsupportedKeyword({ oneOf: [] })).toBe("oneOf");
    const result = validateJsonSchema({ oneOf: [] } as never, {});
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/unsupported/i);
  });
});
