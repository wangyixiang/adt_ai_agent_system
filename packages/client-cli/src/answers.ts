import type { ManualActionFeedback } from "@adt/client-daemon";

/**
 * Turning the human's line into a decision. The rule throughout: accept what is
 * unambiguous (whitespace and case are noise), and return `null` for anything
 * else so the caller can ask again. Nothing here ever guesses — a side-effect
 * confirmation that defaulted to yes would be the worst bug this program could
 * have.
 */

const YES = new Set(["y", "yes", "是", "好", "确认"]);
const NO = new Set(["n", "no", "否", "不"]);

export function parseConfirmation(line: string): boolean | null {
  const answer = line.trim().toLowerCase();
  if (YES.has(answer)) return true;
  if (NO.has(answer)) return false;
  return null;
}

const WAIT = new Set(["wait", "w", "等", "等待"]);
const STOP = new Set(["stop", "s", "停", "停止"]);

export function parseResourceConflict(line: string): "wait" | "stop" | null {
  const answer = line.trim().toLowerCase();
  if (WAIT.has(answer)) return "wait";
  if (STOP.has(answer)) return "stop";
  return null;
}

const OUTCOMES = new Set<ManualActionFeedback["outcome"]>([
  "succeeded",
  "failed",
  "partially",
  "unknown",
]);

/**
 * `succeeded: 复位后灯变绿` — the outcome is required, the observation optional.
 * An empty answer means "no feedback", which the daemon reads as `undefined`.
 */
export function parseManualFeedback(line: string): ManualActionFeedback | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;

  const [head = "", ...rest] = trimmed.split(/[:：]/);
  const outcome = head.trim().toLowerCase();
  if (!OUTCOMES.has(outcome as ManualActionFeedback["outcome"])) return null;

  return {
    outcome: outcome as ManualActionFeedback["outcome"],
    observation: rest.join(":").trim(),
  };
}

export type Command =
  | { kind: "records" }
  | { kind: "show"; recordId: string }
  | { kind: "report"; recordId: string; detailLevel: "summary" | "full" }
  | { kind: "export"; recordId: string; object: "record" | "report" }
  | { kind: "blob"; contentRef: string; path: string }
  | { kind: "help" }
  | { kind: "quit" };

/**
 * The `:`-commands. Defaults follow the specs: `detail_level` defaults to `full`
 * (REPORT_SPEC.md §3) and `object` to `record` (PROTOCOL_SPEC.md §10.3).
 */
export function parseCommand(line: string): Command | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(":")) return null;

  const [name, ...args] = trimmed.slice(1).split(/\s+/);

  switch (name) {
    case "records":
      return args.length === 0 ? { kind: "records" } : null;
    case "help":
      return args.length === 0 ? { kind: "help" } : null;
    case "quit":
    case "q":
      return args.length === 0 ? { kind: "quit" } : null;
    case "show":
      return args.length === 1 ? { kind: "show", recordId: args[0]! } : null;
    case "report": {
      if (args.length > 2 || args[0] === undefined) return null;
      const level = args[1];
      if (level === undefined) return { kind: "report", recordId: args[0], detailLevel: "full" };
      if (level === "summary" || level === "full") {
        return { kind: "report", recordId: args[0], detailLevel: level };
      }
      return null;
    }
    case "export": {
      if (args.length > 2 || args[0] === undefined) return null;
      const object = args[1];
      if (object === undefined) return { kind: "export", recordId: args[0], object: "record" };
      if (object === "record" || object === "report") {
        return { kind: "export", recordId: args[0], object };
      }
      return null;
    }
    case "blob":
      return args.length === 2
        ? { kind: "blob", contentRef: args[0]!, path: args[1]! }
        : null;
    default:
      return null;
  }
}
