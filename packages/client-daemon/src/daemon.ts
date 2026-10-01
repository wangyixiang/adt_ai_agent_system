import type { StepState } from "@adt/shared";

import { defaultRegistry } from "./capability/defaultRegistry";
import type { CapabilityRegistry } from "./capability/registry";
import type { CommandRunner } from "./capability/result";
import { DaemonConnection, type StateSyncSnapshot } from "./connection";
import { openLedger, type Ledger } from "./ledger";
import { openSessionStore, type SessionStore } from "./sessionStore";
import {
  attachStepRunner,
  type ConfirmationRequest,
  type ManualActionFeedback,
  type ResourceConflictRequest,
  type StepDispatcher,
  type StepDispatchPayload,
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
   * Asks the engineer what to do when a provider finds the resource busy
   * (default: stop, which ends the workflow with `resource_conflict`).
   */
  onResourceConflict?: (request: ResourceConflictRequest) => Promise<"wait" | "stop">;
  /**
   * Persistent idempotency ledger (WORKFLOW_SPEC.md §4.3). Defaults to an
   * in-memory ledger, which only protects a single process lifetime — pass a
   * file-backed one (`openLedger(path)`) in production.
   */
  ledger?: Ledger;
  /**
   * Remembers the logical session so a reconnect can resume it instead of
   * starting a new one (NFR-3). Same in-memory default, same advice: pass a
   * file-backed `openSessionStore(path)` in production.
   */
  sessionStore?: SessionStore;
  /**
   * Report each step's status **as the daemon sends it**. The Server never
   * echoes `step.status` back, so this is the only place a host can learn them
   * (a UI's tool cards need it).
   */
  onStepStatus?: (update: StepStatusUpdate) => void;
}

/** A step moving, as the daemon reported it to the Server. */
export interface StepStatusUpdate {
  workflowId: string;
  stepId: string;
  state: StepState;
  evidenceSummary?: string;
  failReason?: string;
}

/** A short, human-readable digest of an evidence object. */
function summarizeEvidence(evidence: Record<string, unknown>): string {
  const type = typeof evidence.type === "string" ? evidence.type : "evidence";
  const result = evidence.result;
  const text = typeof result === "string" ? result : JSON.stringify(result ?? {});
  return `${type}: ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`;
}

function toStepStatusUpdate(payload: unknown): StepStatusUpdate | null {
  const body = (payload ?? {}) as Record<string, unknown>;
  const stepId = body["step_id"];
  const state = body["status"];
  if (typeof stepId !== "string" || typeof state !== "string") return null;

  const evidence = body["evidence"] as Record<string, unknown> | null | undefined;
  const failReason = body["fail_reason"] as Record<string, unknown> | null | undefined;

  return {
    workflowId: typeof body["workflow_id"] === "string" ? body["workflow_id"] : "",
    stepId,
    state: state as StepState,
    ...(evidence ? { evidenceSummary: summarizeEvidence(evidence) } : {}),
    ...(failReason ? { failReason: String(failReason["code"] ?? "") } : {}),
  };
}

/**
 * A connected, step-executing client: it declares the registry's capabilities
 * to the Server, runs the steps the Server dispatches, and resumes its logical
 * session after a reconnect.
 */
export class ClientDaemon {
  private constructor(
    readonly connection: DaemonConnection,
    readonly registry: CapabilityRegistry,
    /** Set only when we created it; a caller-supplied store stays theirs. */
    private readonly ownedLedger: Ledger | null,
    private readonly ownedSessionStore: SessionStore | null,
  ) {}

  static async connect(opts: ClientDaemonOptions): Promise<ClientDaemon> {
    const registry = opts.registry ?? defaultRegistry();
    const ledger = opts.ledger ?? openLedger(":memory:");
    const sessionStore = opts.sessionStore ?? openSessionStore(":memory:");
    const remembered = sessionStore.load();

    // Resuming means the Server may hand back a step we had already begun.
    // Acting on that safely needs a ledger that outlives this process: with a
    // memory-only one, "no entry" would look like "never ran" and the side
    // effect would happen a second time.
    const resumable = remembered !== null && ledger.persistent;
    if (remembered && !ledger.persistent) {
      console.warn(
        "[daemon] not resuming: the idempotency ledger is not persistent, so a re-dispatched side effect could run twice",
      );
    }

    let connection: DaemonConnection;
    try {
      connection = await DaemonConnection.connect(
        {
          url: opts.url,
          credentials: opts.credentials,
          clientInfo: opts.clientInfo,
          capabilities: registry.descriptors(),
          session: resumable ? { sessionId: remembered!.sessionId } : null,
        },
        (ready, stateSync) => {
          // The Server does not echo step statuses back, so the only place to
          // observe them is where the daemon sends them.
          const observed: StepDispatcher = {
            on: (type, handler) => ready.on(type, handler),
            send: (type, payload) => {
              ready.send(type, payload);
              if (type === "step.status" && opts.onStepStatus) {
                const update = toStepStatusUpdate(payload);
                if (update !== null) opts.onStepStatus(update);
              }
            },
          };

          const runStep = attachStepRunner({
            connection: observed,
            registry,
            workspaceRoot: opts.workspaceRoot,
            run: opts.run,
            onConfirmationRequired: opts.onConfirmationRequired,
            onUserInput: opts.onUserInput,
            onResourceConflict: opts.onResourceConflict,
            ledger,
          });

          // Work the Server says is still ours. Sequential on purpose: two
          // pending steps must not drive the same hardware at once.
          if (stateSync) {
            const pending = stateSync.workflows
              .map((workflow) => workflow.pending_step)
              .filter((step): step is StepDispatchPayload => step !== null);
            if (pending.length > 0) {
              console.warn(`[daemon] resuming ${pending.length} pending step(s)`);
              void (async () => {
                for (const step of pending) await runStep(step);
              })();
            }
          }
        },
      );
    } catch (error) {
      // Do not leak what we created when the handshake fails; a caller-supplied
      // store stays theirs to close.
      if (!opts.ledger) ledger.close();
      if (!opts.sessionStore) sessionStore.close();
      throw error;
    }

    // Only after a successful handshake: whatever session we ended up with
    // (resumed or brand new) is the one to try next time.
    sessionStore.save({ sessionId: connection.sessionId, userId: connection.userId });

    return new ClientDaemon(
      connection,
      registry,
      opts.ledger ? null : ledger,
      opts.sessionStore ? null : sessionStore,
    );
  }

  async close(): Promise<void> {
    await this.connection.close();
    this.ownedLedger?.close();
    this.ownedSessionStore?.close();
  }
}
