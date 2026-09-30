/**
 * Environment parsing for the Server's tunables.
 *
 * `parseBoundedInt` is the single parser: a missing or unusable value falls back
 * rather than silently becoming something else (`Number("")` is `0`, which would
 * read as "disabled" for a retry count), and an out-of-range value falls back
 * rather than being clamped, so the value applied is always one the operator
 * could have written themselves. That is only acceptable if the operator can
 * *see* their value was discarded — pass `name` and a rejected value is
 * reported. Omitting `max` leaves the value uncapped (see `KB_TIMEOUT_MS`:
 * silently shrinking a legitimately slow value would be a worse surprise).
 *
 * `resolvePort` lives here because the listen port is the same kind of value; it
 * sanitises the explicit option and `PORT` alike.
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
 * **Both** paths are sanitised, so Node never receives a `NaN` or an
 * out-of-range port and fails at listen time with a confusing
 * `ERR_SOCKET_BAD_PORT` — `StartOptions.port` is a public API, so the explicit
 * value can be garbage too.
 */
export function resolvePort(
  explicit: number | undefined,
  env: Record<string, string | undefined>,
): number {
  if (explicit !== undefined) {
    if (Number.isInteger(explicit) && explicit >= 0 && explicit <= MAX_PORT) return explicit;
    console.warn(
      `[config] port=${explicit} is not usable (expected an integer in [0, ${MAX_PORT}]); using ${DEFAULT_PORT}.`,
    );
    return DEFAULT_PORT;
  }
  return parseBoundedInt(env.PORT, {
    fallback: DEFAULT_PORT,
    min: 1,
    max: MAX_PORT,
    name: "PORT",
  });
}
