import type { CapabilityDescriptor } from "@adt/shared";
import type { CapabilityAdapter } from "./result";
import type { CapabilitySpec } from "./spec";

/** Client-side registry of executable capabilities and their declarations. */
export class CapabilityRegistry {
  private readonly adapters = new Map<string, CapabilityAdapter>();

  register(adapter: CapabilityAdapter): void {
    this.adapters.set(adapter.spec.name, adapter);
  }

  get(name: string): CapabilityAdapter | undefined {
    return this.adapters.get(name);
  }

  specs(): CapabilitySpec[] {
    return [...this.adapters.values()].map((adapter) => adapter.spec);
  }

  /** The Manifest entries the Server receives in `session.hello` / `capability.sync`. */
  descriptors(): CapabilityDescriptor[] {
    return this.specs().map((spec) => ({
      name: spec.name,
      side_effect: spec.side_effect,
      interruptible: spec.interruptible,
      idempotent: spec.idempotent,
      timeout_hint: spec.timeout_hint,
      input_schema: spec.input_schema,
      output_schema: spec.output_schema,
    }));
  }
}
