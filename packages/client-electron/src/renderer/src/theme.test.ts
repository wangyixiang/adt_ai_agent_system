import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");

const REQUIRED_VARS = [
  "--color-bg",
  "--color-surface-lowest",
  "--color-surface-low",
  "--color-surface",
  "--color-surface-high",
  "--color-surface-highest",
  "--color-on-surface",
  "--color-on-surface-variant",
  "--color-outline-variant",
  "--color-primary",
  "--color-primary-container",
  "--color-on-primary",
  "--color-secondary",
  "--color-tertiary",
  "--color-error",
  "--color-warning",
  "--font-sans",
  "--font-mono",
];

const FONT_FILES = [
  "inter-latin-400-normal.woff2",
  "inter-latin-500-normal.woff2",
  "inter-latin-600-normal.woff2",
  "jetbrains-mono-latin-400-normal.woff2",
  "jetbrains-mono-latin-500-normal.woff2",
];

describe("the design tokens", () => {
  it("declares every spec token", () => {
    for (const name of REQUIRED_VARS) expect(css).toContain(`${name}:`);
  });

  it("vendors the two font families locally", () => {
    for (const file of FONT_FILES) {
      expect(existsSync(new URL(`./assets/fonts/${file}`, import.meta.url))).toBe(true);
    }
    expect(css).toContain('font-family: "Inter"');
    expect(css).toContain('font-family: "JetBrains Mono"');
  });

  it("keeps the smallest type at 11px", () => {
    expect(css).not.toMatch(/font-size:\s*(9|10)px/);
  });
});
