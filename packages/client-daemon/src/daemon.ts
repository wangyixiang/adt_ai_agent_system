import { defaultRegistry } from "./capability/defaultRegistry";
import type { CapabilityRegistry } from "./capability/registry";
import type { CommandRunner } from "./capability/result";
import { DaemonConnection } from "./connection";
import { openLedger, type Ledger } from "./ledger";
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
  /**
   * Persistent idempotency ledger (WORKFLOW_SPEC.md §4.3). Defaults to an
   * in-memory ledger, which only protects a single process lifetime — pass a
   * file-backed one (`openLedger(path)`) in production.
   */
  ledger?: Ledger;
}

/**
 * A connected, step-executing client: it declares the registry's capabilities
 * to the Server and runs the read-only steps the Server dispatches.
 */
export class ClientDaemon {
  private constructor(
    readonly connection: DaemonConnection,
    readonly registry: CapabilityRegistry,
    /** Set only when we created it; a caller-supplied ledger stays theirs. */
    private readonly ownedLedger: Ledger | null,
  ) {}

  static async connect(opts: ClientDaemonOptions): Promise<ClientDaemon> {
    const registry = opts.registry ?? defaultRegistry();
    const ownedLedger = opts.ledger ?? openLedger(":memory:");

    let connection: DaemonConnection;
    try {
      connection = await DaemonConnection.connect(
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
            ledger: ownedLedger,
          });
        },
      );
    } catch (error) {
      // Do not leak the ledger we created when the handshake fails; a
      // caller-supplied ledger stays theirs to close.
      if (!opts.ledger) ownedLedger.close();
      throw error;
    }

    return new ClientDaemon(connection, registry, opts.ledger ? null : ownedLedger);
  }

  async close(): Promise<void> {
    await this.connection.close();
    this.ownedLedger?.close();
  }
}
