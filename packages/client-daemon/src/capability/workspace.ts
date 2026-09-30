import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Resolves `target` against `root` and returns it only if it stays inside
 * `root`; otherwise null. This is the lexical filesystem confinement boundary —
 * an escaping path must never be opened. Symlinks are handled by
 * `resolveRealWithinWorkspace`.
 */
export function resolveWithinWorkspace(root: string, target: string): string | null {
  const base = resolve(root);
  const candidate = resolve(base, target);
  const rel = relative(base, candidate);

  if (rel === "") return candidate;
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

/**
 * Like `resolveWithinWorkspace`, but resolves symlinks: a link *inside* the
 * workspace that points outside it is rejected too. Returns the real path to
 * open, or null.
 */
export async function resolveRealWithinWorkspace(
  root: string,
  target: string,
): Promise<string | null> {
  const lexical = resolveWithinWorkspace(root, target);
  if (lexical === null) return null;

  const realRoot = await realpath(resolve(root)).catch(() => resolve(root));

  let real: string;
  try {
    real = await realpath(lexical);
  } catch {
    // The target does not exist yet: resolve its parent, which must exist.
    const parent = await realpath(dirname(lexical)).catch(() => null);
    if (parent === null) return null;
    real = resolve(parent, basename(lexical));
  }

  const rel = relative(realRoot, real);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) return null;
  return real;
}
