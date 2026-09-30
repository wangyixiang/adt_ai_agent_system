/**
 * A missing or unusable environment value falls back to `fallback` rather than
 * silently becoming something else: `Number("")` is `0`, which would read as
 * "disabled" for a retry count.
 *
 * An out-of-range value also falls back instead of being clamped, so the value
 * actually applied is always one the operator could have written themselves.
 * That is only acceptable if the operator can *see* that their value was
 * discarded — pass `name` and a rejected value is reported on stderr. Omitting
 * `max` leaves the value uncapped (see `KB_TIMEOUT_MS`: silently shrinking a
 * legitimately slow value to the default would be a worse surprise).
 */
export function parseBoundedInt(
  value: string | undefined,
  {
    fallback,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
    name,
  }: { fallback: number; min?: number; max?: number; name?: string },
): number {
  if (value === undefined || value.trim() === "") return fallback;

  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= min && parsed <= max) return parsed;

  if (name) {
    const expected =
      max === Number.MAX_SAFE_INTEGER ? `an integer >= ${min}` : `an integer in [${min}, ${max}]`;
    console.warn(
      `[config] ${name}="${value}" is not usable (expected ${expected}); using ${fallback}.`,
    );
  }
  return fallback;
}

/** The default listen port when neither an option nor a usable `PORT` is given. */
const DEFAULT_PORT = 8080;
const MAX_PORT = 65_535;

/**
 * The listen port: an explicit option wins (including `0`, "any free port").
 *
 * A missing or unusable `PORT` degrades to the default and says so, instead of
 * handing Node a `NaN` that fails at listen time with `ERR_SOCKET_BAD_PORT`.
 */
export function resolvePort(
  explicit: number | undefined,
  env: Record<string, string | undefined>,
): number {
  if (explicit !== undefined) return explicit;
  return parseBoundedInt(env.PORT, {
    fallback: DEFAULT_PORT,
    min: 1,
    max: MAX_PORT,
    name: "PORT",
  });
}
