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

  it("keeps the offline fallback stacks", () => {
    expect(css).toContain('--font-sans: "Inter", "Segoe UI", system-ui, sans-serif');
    expect(css).toContain('--font-mono: "JetBrains Mono", "Cascadia Mono", Consolas, monospace');
  });

  it("contains scrolling inside the panes", () => {
    expect(css).toMatch(/\.app-body\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.transcript\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.transcript\s*\{[^}]*min-height:\s*0/);
  });

  it("dresses the app bar", () => {
    for (const selector of [".app-name", ".app-connection", ".app-user", ".app-settings"]) {
      expect(css).toContain(selector);
    }
  });

  it("themes the pre-shell screens", () => {
    expect(css).toMatch(/\.screen\s*\{[^}]*background:\s*var\(--color-bg\)/);
    expect(css).toMatch(/\.screen\s*\{[^}]*font-family:\s*var\(--font-sans\)/);
    expect(css).toContain(".screen .login");
    expect(css).toContain(".screen .settings");
  });

  it("themes the overlays", () => {
    expect(css).toMatch(/\.report-viewer[^{]*\{[^}]*position:\s*fixed/);
    expect(css).toContain(".blob-viewer");
    expect(css).toContain(".report-content");
  });

  it("dresses the thread and the workbench", () => {
    for (const selector of [
      ".transcript",
      ".bubble",
      ".tool-row",
      ".ask-card",
      ".notice",
      ".summary",
      ".workbench-step",
      ".step-input",
      ".needs-confirmation",
      ".completion-decision",
      ".completion-refs",
      ".reconnect-note",
      ".progress",
      ".composer",
    ]) {
      expect(css).toContain(selector);
    }
  });

  it("styles the empty, loading and error states", () => {
    expect(css).toContain(".empty");
    expect(css).toContain(".loading");
    expect(css).toMatch(/\[role="alert"\]/);
  });

  it("uses tokens, not raw colours, outside :root", () => {
    const withoutRoot = css.replace(/:root\s*\{[^}]*\}/s, "");
    expect(withoutRoot).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(withoutRoot).not.toMatch(/\brgb\(|\bhsl\(/);
  });

  it("dresses the remaining components", () => {
    for (const selector of [
      "conversation",
      "conversation-title",
      "conversation-state",
      "conversation-duration",
      "workbench-actions",
      "workbench-state",
      "workbench-steps",
      "workbench-completion",
      "workbench-conclusion",
      "objective",
      "instruction",
      "answer",
      "ask-kind",
      "decisions",
      "decision",
      "evidence-blob",
      "hint",
      "past-note",
      "record",
      "completion-summary",
      "detail-level",
      "export-object",
      "report-actions",
      "attachments",
      "attachment-name",
      "attachment-mode",
    ]) {
      expect(css).toMatch(new RegExp(`\\.${selector}\\b`));
    }
  });
});
