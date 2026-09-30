/**
 * A missing or unusable environment value falls back to `fallback` rather than
 * silently becoming something else: `Number("")` is `0`, which would read as
 * "disabled" for a retry count.
 *
 * An out-of-range value also falls back instead of being clamped, so the value
 * actually applied is always one the operator could have written themselves.
 * Omit `max` to leave the value uncapped (see `KB_TIMEOUT_MS`: silently
 * shrinking a legitimately slow value to the default would be a worse surprise).
 */
export function parseBoundedInt(
  value: string | undefined,
  { fallback, min = 0, max = Number.MAX_SAFE_INTEGER }: { fallback: number; min?: number; max?: number },
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}
