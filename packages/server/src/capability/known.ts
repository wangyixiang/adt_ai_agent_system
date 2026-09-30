import { HUMAN_MANUAL_ACTION } from "@adt/shared";

/**
 * Names registered in CAPABILITY_SPEC.md §2 / §6, used to sanity-check what a
 * client declares. `sim_rig.*` are the MVP simulated capabilities; the reserved
 * names come from the spec, not from a declaration (hence the allowlist).
 */
export const KNOWN_CAPABILITIES: ReadonlySet<string> = new Set([
  "filesystem.read_file",
  "terminal.execute_command",
  "docker.inspect_container",
  "git.collect_diagnostics",
  "browser.open_page",
  "local-agent.diagnose_project",
  "test_rig.read_signal_log",
  "test_rig.query_dut_info",
  "test_rig.read_fault_code",
  "test_rig.trigger_reset",
  "sim_rig.trigger_reset",
  "sim_rig.query_state",
  HUMAN_MANUAL_ACTION,
]);
