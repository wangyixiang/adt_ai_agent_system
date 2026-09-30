import { defaultRegistry } from "./capability/defaultRegistry";
import type { CapabilityRegistry } from "./capability/registry";
import type { CommandRunner } from "./capability/result";
import { DaemonConnection } from "./connection";
import {
  attachStepRunner,
  type ConfirmationRequest,
  type ManualActionFeedback,
  type UserInputRequest,
} from "./stepRunner";

export interface ClientDaemonOptions {
  url: string;
  credentials: { username: string; secret: string };
  clientInfo: { name: string; platform: string };
  /** Filesystem access is confined to this root. */
  workspaceRoot: string;
  registry?: CapabilityRegistry;
  run?: CommandRunner;
  /** Asks the engineer to approve a side-effect step (default: decline). */
  onConfirmationRequired?: (request: ConfirmationRequest) => Promise<boolean>;
  /** Collects the engineer's report for a suggested manual action. */
  onUserInput?: (request: UserInputRequest) => Promise<ManualActionFeedback | undefined>;
}

/**
 * A connected, step-executing client: it declares the registry's capabilities
 * to the Server and runs the read-only steps the Server dispatches.
 */
export class ClientDaemon {
  private constructor(
    readonly connection: DaemonConnection,
    readonly registry: CapabilityRegistry,
  ) {}

  static async connect(opts: ClientDaemonOptions): Promise<ClientDaemon> {
    const registry = opts.registry ?? defaultRegistry();
    const connection = await DaemonConnection.connect(
      {
        url: opts.url,
        credentials: opts.credentials,
        clientInfo: opts.clientInfo,
        capabilities: registry.descriptors(),
      },
      (ready) => {
        attachStepRunner({
          connection: ready,
          registry,
          workspaceRoot: opts.workspaceRoot,
          run: opts.run,
          onConfirmationRequired: opts.onConfirmationRequired,
          onUserInput: opts.onUserInput,
        });
      },
    );
    return new ClientDaemon(connection, registry);
  }

  close(): Promise<void> {
    return this.connection.close();
  }
}
