import { makeError } from "@adt/shared";
import type { MessageRouter } from "../ws/messageRouter";
import type { CapabilitySyncPayload } from "./capabilityRegistry";

export interface CapabilitySyncDeps {
  known: ReadonlySet<string>;
}

/**
 * `capability.sync` has no protocol-level ack (PROTOCOL_SPEC.md §6):
 * the handler applies the payload and records warnings on the connection.
 */
export function registerCapabilitySync(
  router: MessageRouter,
  deps: CapabilitySyncDeps,
): void {
  router.register("capability.sync", ({ conn, session }, env) => {
    if (!session) {
      conn.warn("capability.sync received before handshake");
      return;
    }

    const payload = env.payload as Partial<CapabilitySyncPayload> | null;
    const validMode = payload?.mode === "full" || payload?.mode === "incremental";
    if (!payload || !validMode || typeof payload.revision !== "number") {
      conn.send(
        makeError("malformed_payload", "invalid capability.sync payload", env.message_id),
      );
      return;
    }

    const result = session.capabilities.apply(payload as CapabilitySyncPayload);
    for (const warning of result.warnings) conn.warn(warning);
    void deps.known;
  });
}
