export { DaemonConnection, type ClientConfig } from "./connection";
export { ClientDaemon, type ClientDaemonOptions } from "./daemon";
export { CapabilityRegistry } from "./capability/registry";
export { defaultRegistry } from "./capability/defaultRegistry";
export { mvpDescriptors, mvpSpec } from "./capability/descriptors";
export { nodeCommandRunner } from "./capability/exec";
export { resolveWithinWorkspace } from "./capability/workspace";
export {
  attachStepRunner,
  HUMAN_MANUAL_ACTION,
  type ConfirmationRequest,
  type ManualActionFeedback,
  type StepDispatcher,
  type StepRunnerDeps,
  type UserInputRequest,
} from "./stepRunner";
export {
  gitCollectDiagnostics,
} from "./capability/adapters/git";
export { filesystemReadFile } from "./capability/adapters/filesystem";
export { dockerInspectContainer } from "./capability/adapters/docker";
export { placeholderAdapter } from "./capability/adapters/placeholder";
export { terminalExecuteCommand } from "./capability/adapters/terminal";
export { simRigTriggerReset, simRigQueryState } from "./capability/adapters/simRig";
export type {
  CapabilityAdapter,
  CommandResult,
  CommandRunner,
  ExecutionContext,
  ExecutionResult,
} from "./capability/result";
export type { CapabilitySpec } from "./capability/spec";
