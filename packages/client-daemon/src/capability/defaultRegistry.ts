import { dockerInspectContainer } from "./adapters/docker";
import { filesystemReadFile } from "./adapters/filesystem";
import { gitCollectDiagnostics } from "./adapters/git";
import { placeholderAdapter } from "./adapters/placeholder";
import { mvpSpec } from "./descriptors";
import { CapabilityRegistry } from "./registry";

const PLACEHOLDER_CAPABILITIES = ["local-agent.diagnose_project", "browser.open_page"];

/**
 * The MVP registry: every capability declared by `mvpDescriptors()` has an
 * adapter here. Local command execution is injected per call via
 * `ExecutionContext.run`, so no runner is needed at construction.
 */
export function defaultRegistry(): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  registry.register(gitCollectDiagnostics(mvpSpec("git.collect_diagnostics")));
  registry.register(filesystemReadFile(mvpSpec("filesystem.read_file")));
  registry.register(dockerInspectContainer(mvpSpec("docker.inspect_container")));
  for (const name of PLACEHOLDER_CAPABILITIES) {
    registry.register(placeholderAdapter(mvpSpec(name)));
  }
  return registry;
}
