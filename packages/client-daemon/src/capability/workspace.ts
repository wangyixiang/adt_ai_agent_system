import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolves `target` against `root` and returns it only if it stays inside
 * `root`; otherwise null. This is the filesystem confinement boundary — an
 * escaping path must never be opened.
 */
export function resolveWithinWorkspace(root: string, target: string): string | null {
  const base = resolve(root);
  const candidate = resolve(base, target);
  const rel = relative(base, candidate);

  if (rel === "") return candidate;
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}
