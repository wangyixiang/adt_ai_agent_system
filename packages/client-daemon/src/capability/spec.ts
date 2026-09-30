/**
 * The client-side, canonical declaration of a Capability (CAPABILITY_SPEC.md
 * §2/§3/§5). These live in the client package on purpose: the Server learns
 * capabilities from the Manifest at runtime and must not import them
 * (see the plan's Global Constraints).
 */
export interface CapabilitySpec {
  name: string;
  side_effect: boolean;
  interruptible: boolean;
  idempotent?: boolean;
  timeout_hint?: number;
  /** The Evidence `type` this capability produces (CAPABILITY_SPEC.md §5.3). */
  output_type?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
}
