import type {
  CapabilityDescriptor,
  CapabilitySyncPayload,
  NormalizedCapability,
} from "@adt/shared";

export type { CapabilityDescriptor, CapabilitySyncPayload, NormalizedCapability };

function normalize(descriptor: CapabilityDescriptor): NormalizedCapability {
  return {
    name: descriptor.name,
    // Conservative defaults (CAPABILITY_SPEC.md §2.1–§2.3).
    side_effect: descriptor.side_effect ?? true,
    interruptible: descriptor.interruptible ?? false,
    idempotent: descriptor.idempotent ?? false,
    timeout_hint: descriptor.timeout_hint,
    input_schema: descriptor.input_schema,
    output_schema: descriptor.output_schema,
  };
}

export class CapabilityRegistry {
  /** Baseline is -1 so the initial full sync at revision 0 is accepted. */
  private current = -1;
  private readonly items = new Map<string, NormalizedCapability>();

  constructor(private readonly known: ReadonlySet<string>) {}

  get revision(): number {
    return this.current;
  }

  has(name: string): boolean {
    return this.items.has(name);
  }

  get(name: string): NormalizedCapability | undefined {
    return this.items.get(name);
  }

  asMap(): Map<string, NormalizedCapability> {
    return new Map(this.items);
  }

  apply(payload: CapabilitySyncPayload): { applied: boolean; warnings: string[] } {
    const warnings: string[] = [];

    if (typeof payload.revision !== "number" || Number.isNaN(payload.revision)) {
      return { applied: false, warnings: ["revision must be a number"] };
    }
    if (payload.revision <= this.current) {
      return {
        applied: false,
        warnings: [`stale revision ${payload.revision} <= ${this.current}`],
      };
    }

    const added = Array.isArray(payload.added) ? payload.added : [];
    const removed = Array.isArray(payload.removed) ? payload.removed : [];

    if (payload.mode === "full") this.items.clear();
    for (const name of removed) this.items.delete(name);

    for (const descriptor of added) {
      if (!descriptor || typeof descriptor.name !== "string") {
        warnings.push("descriptor without a name ignored");
        continue;
      }
      if (!this.known.has(descriptor.name)) {
        warnings.push(`unregistered capability ignored: ${descriptor.name}`);
        continue;
      }
      this.items.set(descriptor.name, normalize(descriptor));
    }

    this.current = payload.revision;
    return { applied: true, warnings };
  }
}
