/** Protocol-level capability types shared by Client and Server (CAPABILITY_SPEC.md §3). */

export interface CapabilityDescriptor {
  name: string;
  side_effect?: boolean;
  interruptible?: boolean;
  idempotent?: boolean;
  timeout_hint?: number;
  input_schema?: object;
  output_schema?: object;
}

export interface NormalizedCapability {
  name: string;
  side_effect: boolean;
  interruptible: boolean;
  idempotent: boolean;
  timeout_hint?: number;
  input_schema?: object;
  output_schema?: object;
}

export interface CapabilitySyncPayload {
  mode: "full" | "incremental";
  revision: number;
  added: CapabilityDescriptor[];
  removed: string[];
}

/**
 * The one capability every Client implicitly supports and that is therefore
 * never part of a Manifest (CAPABILITY_SPEC.md §6). The Server may dispatch it
 * as a suggestion; the Client shows `input.instruction` to the engineer and
 * reports back what they observed instead of executing anything itself.
 */
export const HUMAN_MANUAL_ACTION = "human.manual_action";

export const HUMAN_MANUAL_ACTION_CAPABILITY: NormalizedCapability = {
  name: HUMAN_MANUAL_ACTION,
  side_effect: false,
  interruptible: true,
  idempotent: false,
  input_schema: {
    type: "object",
    required: ["instruction"],
    properties: { instruction: { type: "string" } },
  },
  output_schema: {
    type: "object",
    required: ["outcome", "observation"],
    properties: {
      outcome: { type: "string", enum: ["succeeded", "failed", "partially", "unknown"] },
      observation: { type: "string" },
      details: { type: "object" },
    },
  },
};
