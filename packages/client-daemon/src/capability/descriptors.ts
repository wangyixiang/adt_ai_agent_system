import type { CapabilitySpec } from "./spec";

/** The canonical declaration of one MVP capability, by name. */
export function mvpSpec(name: string): CapabilitySpec {
  const spec = mvpDescriptors().find((candidate) => candidate.name === name);
  if (!spec) throw new Error(`unknown MVP capability: ${name}`);
  return spec;
}

/**
 * The MVP capability surface (CAPABILITY_SPEC.md §5.3). All are read-only.
 * Placeholder capabilities are declared without a schema — the Server then
 * skips validation and warns (CAPABILITY_SPEC.md §5.4) — and their execution
 * reports `capability_error` (they are not implemented in this MVP).
 */
export function mvpDescriptors(): CapabilitySpec[] {
  return [
    {
      name: "git.collect_diagnostics",
      side_effect: false,
      interruptible: true,
      timeout_hint: 5000,
      output_type: "git_status",
      input_schema: {
        type: "object",
        properties: { project_path: { type: "string" } },
      },
      output_schema: {
        type: "object",
        required: ["branch"],
        properties: {
          branch: { type: "string" },
          modified_files: { type: "integer" },
          untracked_files: { type: "integer" },
        },
      },
    },
    {
      name: "filesystem.read_file",
      side_effect: false,
      interruptible: true,
      timeout_hint: 2000,
      output_type: "file_content",
      input_schema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      },
      output_schema: {
        type: "object",
        required: ["content", "encoding"],
        properties: {
          content: { type: "string" },
          encoding: { type: "string" },
          path: { type: "string" },
        },
      },
    },
    {
      name: "docker.inspect_container",
      side_effect: false,
      interruptible: true,
      timeout_hint: 5000,
      output_type: "container_info",
      input_schema: {
        type: "object",
        required: ["container"],
        properties: { container: { type: "string" } },
      },
      output_schema: {
        type: "object",
        required: ["running"],
        properties: { running: { type: "boolean" }, image: { type: "string" } },
      },
    },
    { name: "local-agent.diagnose_project", side_effect: false, interruptible: true },
    { name: "browser.open_page", side_effect: false, interruptible: true },
    {
      name: "terminal.execute_command",
      side_effect: true,
      interruptible: false,
      idempotent: false,
      timeout_hint: 30000,
      output_type: "command_result",
      input_schema: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string" },
          args: { type: "array", items: { type: "string" } },
        },
      },
      output_schema: {
        type: "object",
        required: ["exit_code"],
        properties: { exit_code: { type: "integer" }, stdout: { type: "string" } },
      },
    },
    {
      // MVP simulated side effect (CAPABILITY_SPEC.md §5.3): exercises
      // confirmation / UNKNOWN / reconciliation / idempotency without hardware.
      name: "sim_rig.trigger_reset",
      side_effect: true,
      interruptible: false,
      idempotent: false,
      timeout_hint: 30000,
      output_type: "reset_ack",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" } },
      },
      output_schema: {
        type: "object",
        required: ["reset_ack"],
        properties: { reset_ack: { type: "boolean" } },
      },
    },
    {
      // The read-only companion used to reconcile an UNKNOWN reset.
      name: "sim_rig.query_state",
      side_effect: false,
      interruptible: true,
      timeout_hint: 5000,
      output_type: "reset_state",
      input_schema: { type: "object", properties: {} },
      output_schema: {
        type: "object",
        required: ["reset_applied"],
        properties: { reset_applied: { type: "boolean" } },
      },
    },
  ];
}
