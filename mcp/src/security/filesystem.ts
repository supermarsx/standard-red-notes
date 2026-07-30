import { randomUUID } from "node:crypto";
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

/**
 * Write a private file without ever opening an existing destination for
 * writing. Data first lands in an owner-only same-directory temporary file.
 * Linking (no-overwrite) or renaming (overwrite) changes the directory entry,
 * so a leaf symlink can never redirect bytes outside the allowlist.
 */
export async function writePrivateOutputFile(
  target: string,
  data: string | Uint8Array,
  overwrite: boolean,
): Promise<void> {
  const temporary = path.join(
    path.dirname(target),
    `.srn-export-${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    temporaryExists = true;

    if (overwrite) {
      try {
        const existing = await fs.lstat(target);
        if (existing.isSymbolicLink() || !existing.isFile()) {
          throw new Error(
            "refusing to overwrite a symlink or non-regular export target",
          );
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      // rename replaces the directory entry; it never follows the destination
      // leaf. If a platform cannot atomically replace an existing file, fail
      // closed and leave the original untouched.
      await fs.rename(temporary, target);
      temporaryExists = false;
    } else {
      // An atomic hard-link creation has O_EXCL-like destination semantics:
      // any existing file, directory, symlink, or junction makes it fail.
      await fs.link(temporary, target);
      await fs.unlink(temporary);
      temporaryExists = false;
    }

    if (process.platform !== "win32") {
      await fs.chmod(target, 0o600);
    }
  } finally {
    if (temporaryExists) {
      await fs.unlink(temporary).catch(() => {});
    }
  }
}
