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
