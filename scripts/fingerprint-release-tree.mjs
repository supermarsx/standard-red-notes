#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  createReadStream,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FINGERPRINT_SCHEMA = "srn-release-tree-v1";
const NORMALIZED_JSON_VALUE = "__srn_release_fingerprint_normalized__";

function compareText(left, right) {
  return left === right ? 0 : left < right ? -1 : 1;
}

export class ReleaseTreeFingerprintError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseTreeFingerprintError";
  }
}

function normalizeRelativePath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  return normalized === "." ? "" : normalized.replace(/\/+$/, "");
}

function resolveInsideRoot(root, relativePath) {
  const absolute = path.resolve(root, relativePath || ".");
  const relation = path.relative(root, absolute);
  if (
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new ReleaseTreeFingerprintError(
      `fingerprint path escapes the selected root: ${relativePath}`,
    );
  }
  return absolute;
}

function isExcluded(relativePath, exclusions) {
  return exclusions.some(
    (excluded) =>
      relativePath === excluded ||
      (excluded && relativePath.startsWith(`${excluded}/`)),
  );
}

function collectEntries({ absolutePath, relativePath, exclusions, entries }) {
  if (isExcluded(relativePath, exclusions)) {
    return;
  }

  const stats = lstatSync(absolutePath);
  if (stats.isDirectory()) {
    entries.set(relativePath, {
      absolutePath,
      relativePath,
      type: "directory",
    });
    for (const name of readdirSync(absolutePath).sort(compareText)) {
      const childRelative = normalizeRelativePath(
        relativePath ? `${relativePath}/${name}` : name,
      );
      collectEntries({
        absolutePath: path.join(absolutePath, name),
        relativePath: childRelative,
        exclusions,
        entries,
      });
    }
    return;
  }

  if (stats.isFile()) {
    entries.set(relativePath, {
      absolutePath,
      relativePath,
      size: stats.size,
      type: "file",
    });
    return;
  }

  if (stats.isSymbolicLink()) {
    const target = readlinkSync(absolutePath);
    entries.set(relativePath, {
      absolutePath,
      content: Buffer.from(target),
      relativePath,
      type: "symlink",
    });
    return;
  }

  throw new ReleaseTreeFingerprintError(
    `release surface contains an unsupported special file: ${relativePath}`,
  );
}

function updateHeader(hash, type, relativePath, size) {
  const pathBytes = Buffer.byteLength(relativePath);
  hash.update(`${type}\0${pathBytes}\0`);
  hash.update(relativePath);
  hash.update(`\0${size}\0`);
}

function parsedJsonObject(file, operation) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ReleaseTreeFingerprintError(
      `cannot ${operation} in ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new ReleaseTreeFingerprintError(
      `cannot ${operation} in ${file}: expected a JSON object`,
    );
  }
  return manifest;
}

function normalizedPackageManifest(file) {
  const manifest = parsedJsonObject(file, "normalize package version");
  if (typeof manifest.version !== "string") {
    throw new ReleaseTreeFingerprintError(
      `cannot normalize package version in ${file}: missing string version`,
    );
  }
  manifest.version = "0.0.0-release-fingerprint";
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
}

function jsonPointerParts(pointer) {
  if (!pointer.startsWith("/") || pointer === "/") {
    throw new ReleaseTreeFingerprintError(
      `normalized JSON field must be a non-root JSON pointer: ${pointer}`,
    );
  }
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function normalizedJsonDocument(file, pointers) {
  const document = parsedJsonObject(file, "normalize JSON fields");
  for (const pointer of pointers) {
    const parts = jsonPointerParts(pointer);
    let parent = document;
    for (const part of parts.slice(0, -1)) {
      if (
        !parent ||
        typeof parent !== "object" ||
        Array.isArray(parent) ||
        !Object.hasOwn(parent, part)
      ) {
        throw new ReleaseTreeFingerprintError(
          `cannot normalize JSON field ${pointer} in ${file}: field is missing`,
        );
      }
      parent = parent[part];
    }
    const key = parts.at(-1);
    if (
      !parent ||
      typeof parent !== "object" ||
      Array.isArray(parent) ||
      !Object.hasOwn(parent, key)
    ) {
      throw new ReleaseTreeFingerprintError(
        `cannot normalize JSON field ${pointer} in ${file}: field is missing`,
      );
    }
    if (typeof parent[key] !== "string") {
      throw new ReleaseTreeFingerprintError(
        `cannot normalize JSON field ${pointer} in ${file}: expected a string field`,
      );
    }
    parent[key] = NORMALIZED_JSON_VALUE;
  }
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
}

async function updateFile(
  hash,
  entry,
  normalizedPackageVersions,
  normalizedJsonFields,
) {
  const jsonFields = normalizedJsonFields.get(entry.relativePath);
  if (jsonFields) {
    const content = normalizedJsonDocument(entry.absolutePath, jsonFields);
    updateHeader(hash, "file", entry.relativePath, content.length);
    hash.update(content);
    return;
  }
  if (normalizedPackageVersions.has(entry.relativePath)) {
    const content = normalizedPackageManifest(entry.absolutePath);
    updateHeader(hash, "file", entry.relativePath, content.length);
    hash.update(content);
    return;
  }

  updateHeader(hash, "file", entry.relativePath, entry.size);
  await new Promise((resolve, reject) => {
    const stream = createReadStream(entry.absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
}

export async function fingerprintReleaseTree({
  root,
  paths,
  exclude = [],
  normalizePackageVersion = [],
  normalizeJsonField = [],
}) {
  if (!root) {
    throw new ReleaseTreeFingerprintError("a fingerprint root is required");
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new ReleaseTreeFingerprintError(
      "at least one fingerprint path is required",
    );
  }

  const absoluteRoot = path.resolve(root);
  const exclusions = exclude.map(normalizeRelativePath).sort();
  const normalizedPackageVersions = new Set(
    normalizePackageVersion.map(normalizeRelativePath),
  );
  const normalizedJsonFields = new Map();
  for (const specification of normalizeJsonField) {
    const separator = specification.indexOf("=");
    if (separator <= 0 || separator === specification.length - 1) {
      throw new ReleaseTreeFingerprintError(
        `normalized JSON field must use <path>=<json-pointer>: ${specification}`,
      );
    }
    const relativePath = normalizeRelativePath(
      specification.slice(0, separator),
    );
    const pointer = specification.slice(separator + 1);
    const pointers = normalizedJsonFields.get(relativePath) ?? [];
    if (pointers.includes(pointer)) {
      throw new ReleaseTreeFingerprintError(
        `normalized JSON field was supplied more than once: ${specification}`,
      );
    }
    jsonPointerParts(pointer);
    pointers.push(pointer);
    pointers.sort(compareText);
    normalizedJsonFields.set(relativePath, pointers);
  }
  const entries = new Map();

  for (const requestedPath of paths) {
    const relativePath = normalizeRelativePath(requestedPath);
    collectEntries({
      absolutePath: resolveInsideRoot(absoluteRoot, relativePath),
      relativePath,
      exclusions,
      entries,
    });
  }

  for (const normalizedPath of normalizedPackageVersions) {
    const entry = entries.get(normalizedPath);
    if (!entry || entry.type !== "file") {
      throw new ReleaseTreeFingerprintError(
        `normalized package manifest is not part of the fingerprint surface: ${normalizedPath}`,
      );
    }
  }
  for (const normalizedPath of normalizedJsonFields.keys()) {
    const entry = entries.get(normalizedPath);
    if (!entry || entry.type !== "file") {
      throw new ReleaseTreeFingerprintError(
        `normalized JSON document is not part of the fingerprint surface: ${normalizedPath}`,
      );
    }
    if (normalizedPackageVersions.has(normalizedPath)) {
      throw new ReleaseTreeFingerprintError(
        `a file cannot use package-version and JSON-field normalization together: ${normalizedPath}`,
      );
    }
  }

  const hash = createHash("sha256");
  hash.update(`${FINGERPRINT_SCHEMA}\0`);
  for (const entry of [...entries.values()].sort((left, right) =>
    compareText(left.relativePath, right.relativePath),
  )) {
    if (entry.type === "directory") {
      updateHeader(hash, "directory", entry.relativePath, 0);
    } else if (entry.type === "symlink") {
      updateHeader(hash, "symlink", entry.relativePath, entry.content.length);
      hash.update(entry.content);
    } else {
      await updateFile(
        hash,
        entry,
        normalizedPackageVersions,
        normalizedJsonFields,
      );
    }
  }
  return hash.digest("hex");
}

function parseArguments(argv) {
  const repeated = new Map([
    ["--path", []],
    ["--exclude", []],
    ["--normalize-package-version", []],
    ["--normalize-json-field", []],
  ]);
  const single = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new ReleaseTreeFingerprintError(
        `expected --name value arguments; received ${argv.join(" ")}`,
      );
    }
    if (repeated.has(flag)) {
      repeated.get(flag).push(value);
    } else if (single.has(flag)) {
      throw new ReleaseTreeFingerprintError(
        `argument '${flag}' was supplied more than once`,
      );
    } else {
      single.set(flag, value);
    }
  }

  for (const flag of single.keys()) {
    if (!["--root", "--output", "--github-output"].includes(flag)) {
      throw new ReleaseTreeFingerprintError(`unknown argument '${flag}'`);
    }
  }

  return {
    exclude: repeated.get("--exclude"),
    githubOutput: single.get("--github-output"),
    normalizePackageVersion: repeated.get("--normalize-package-version"),
    normalizeJsonField: repeated.get("--normalize-json-field"),
    output: single.get("--output"),
    paths: repeated.get("--path"),
    root: single.get("--root"),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const fingerprint = await fingerprintReleaseTree(options);
  if (options.output) {
    writeFileSync(options.output, `${fingerprint}\n`);
  }
  if (options.githubOutput) {
    writeFileSync(options.githubOutput, `fingerprint=${fingerprint}\n`, {
      flag: "a",
    });
  }
  process.stdout.write(`${fingerprint}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `Release tree fingerprint failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
