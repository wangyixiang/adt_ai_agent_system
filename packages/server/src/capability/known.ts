/**
 * Names registered in CAPABILITY_SPEC.md §2 / §6.
 * `sim_rig.trigger_reset` is the MVP simulated side-effect capability (CAPABILITY_SPEC.md v0.7).
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
  "human.manual_action",
]);
