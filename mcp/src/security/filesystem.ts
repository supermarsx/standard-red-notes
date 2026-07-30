import { promises as fs } from "node:fs";
import path from "node:path";

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

async function canonicalRoots(roots: readonly string[]): Promise<string[]> {
  const resolved: string[] = [];
  for (const root of roots) {
    if (!path.isAbsolute(root)) {
      throw new Error(`filesystem allowlist root must be absolute: ${root}`);
    }
    resolved.push(await fs.realpath(root));
  }
  return resolved;
}

export function rootsFromEnvironment(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }
  return value
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Resolve an existing regular file against explicit, canonical roots. The
 * realpath check prevents both `..` traversal and symlink escapes.
 */
export async function resolveAllowedInputFile(
  requestedPath: string,
  roots: readonly string[],
): Promise<{ path: string; size: number }> {
  if (roots.length === 0) {
    throw new Error(
      "filesystem access is disabled; configure STANDARD_RED_NOTES_FILE_ROOTS",
    );
  }
  if (!path.isAbsolute(requestedPath)) {
    throw new Error("file path must be absolute");
  }

  const [candidate, allowedRoots] = await Promise.all([
    fs.realpath(requestedPath),
    canonicalRoots(roots),
  ]);
  if (!allowedRoots.some((root) => isWithin(root, candidate))) {
    throw new Error("file path is outside the configured allowlist");
  }
  const stat = await fs.stat(candidate);
  if (!stat.isFile()) {
    throw new Error("file path must identify a regular file");
  }
  return { path: candidate, size: stat.size };
}

/**
 * Resolve a not-yet-created output path by canonicalizing its existing parent.
 * This prevents traversal and parent-directory symlink escapes.
 */
export async function resolveAllowedOutputFile(
  requestedPath: string,
  roots: readonly string[],
): Promise<string> {
  if (roots.length === 0) {
    throw new Error(
      "export filesystem access is disabled; configure STANDARD_RED_NOTES_EXPORT_ROOTS",
    );
  }
  if (!path.isAbsolute(requestedPath)) {
    throw new Error("export path must be absolute");
  }

  const [parent, allowedRoots] = await Promise.all([
    fs.realpath(path.dirname(requestedPath)),
    canonicalRoots(roots),
  ]);
  const candidate = path.join(parent, path.basename(requestedPath));
  if (!allowedRoots.some((root) => isWithin(root, candidate))) {
    throw new Error("export path is outside the configured allowlist");
  }
  return candidate;
}
