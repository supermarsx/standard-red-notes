#!/usr/bin/env node

import { appendFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import path from "node:path";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

export const WORKSPACE_ROOTS = Object.freeze({
  root: {
    directory: "",
    manifest: "package.json",
    configPaths: ["package.json", "yarn.lock", ".yarnrc.yml"],
    configPrefixes: [".yarn/releases/"],
  },
  app: {
    directory: "app",
    manifest: "app/package.json",
    configPaths: [
      "app/package.json",
      "app/yarn.lock",
      "app/.nvmrc",
      "app/.yarnrc.yml",
      "app/babel.config.js",
      "app/tsconfig.base.json",
    ],
    configPrefixes: ["app/.yarn/releases/"],
  },
  server: {
    directory: "server",
    manifest: "server/package.json",
    configPaths: [
      "server/package.json",
      "server/yarn.lock",
      "server/.nvmrc",
      "server/.yarnrc.yml",
      "server/linter.tsconfig.json",
      "server/tsconfig.json",
    ],
    configPrefixes: ["server/.yarn/releases/"],
  },
});

const appProductConfig = {
  workspaceRoot: "app",
  configPaths: [],
  configPrefixes: [],
};

const serverProductConfig = {
  workspaceRoot: "server",
  configPaths: [],
  configPrefixes: [],
};

export const RELEASE_TARGETS = Object.freeze({
  "srn-admin": {
    ...serverProductConfig,
    tagPrefix: "srn-admin-v",
    packageNames: ["@standardnotes/auth-server"],
    configPaths: [".github/workflows/srn-admin.yml"],
  },
  "srn-client": {
    tagPrefix: "srn-client-v",
    packageDirs: [
      {
        name: "@standard-red-notes/srn-client",
        directory: "cli/srn-client",
      },
    ],
    configPaths: [".github/workflows/srn-client.yml", "cli/.prettierrc"],
    configPrefixes: [],
  },
  "srn-desktop": {
    ...appProductConfig,
    tagPrefix: "srn-desktop-v",
    packageNames: ["@standardnotes/desktop"],
    configPaths: [
      ".github/workflows/srn-desktop.yml",
      "app/.github/workflows/desktop.release.reuse.yml",
    ],
  },
  "srn-home-server": {
    ...serverProductConfig,
    tagPrefix: "srn-home-server-v",
    packageNames: ["@standardnotes/home-server"],
    configPaths: [".github/workflows/srn-home-server.yml"],
  },
  "srn-mcp": {
    workspaceRoot: "root",
    tagPrefix: "srn-mcp-v",
    packageNames: ["@standard-red-notes/mcp"],
    configPaths: [".github/workflows/srn-mcp.yml"],
    configPrefixes: [],
  },
  "srn-mobile": {
    ...appProductConfig,
    tagPrefix: "@standardnotes/mobile@",
    packageNames: ["@standardnotes/mobile"],
    configPaths: [
      ".github/workflows/srn-mobile.yml",
      "app/.github/workflows/mobile.release.prod.yml",
    ],
  },
  "srn-openclaw": {
    workspaceRoot: "root",
    tagPrefix: "srn-openclaw-v",
    packageNames: ["@standard-red-notes/openclaw"],
    configPaths: [".github/workflows/srn-openclaw.yml"],
    configPrefixes: [],
  },
  "srn-server": {
    tagPrefix: "srn-server-v",
    packageDirs: [
      {
        name: "@standard-red-notes/srn-server",
        directory: "cli/srn-server",
      },
    ],
    configPaths: [".github/workflows/srn-server.yml", "cli/.prettierrc"],
    configPrefixes: [],
  },
});

export class ReleaseImpactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseImpactError";
    this.code = code;
  }
}

function normalizePath(value) {
  return value
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function git(repo, args, options = {}) {
  try {
    const output = execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    return Buffer.isBuffer(output) ? output : output.trim();
  } catch (error) {
    const stderr =
      typeof error?.stderr === "string"
        ? error.stderr.trim()
        : Buffer.isBuffer(error?.stderr)
          ? error.stderr.toString("utf8").trim()
          : "";
    throw new ReleaseImpactError(
      "git-command-failed",
      `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
}

function gitStatus(repo, args) {
  return spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ensureCompleteHistory(repo) {
  const shallow = git(repo, ["rev-parse", "--is-shallow-repository"]);
  if (shallow !== "false") {
    throw new ReleaseImpactError(
      "shallow-history",
      "Release impact cannot be determined from a shallow repository; fetch complete history and tags.",
    );
  }
}

function resolveCommit(repo, ref, label) {
  const result = gitStatus(repo, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (result.status !== 0) {
    throw new ReleaseImpactError(
      "missing-ref",
      `${label} ref '${ref}' does not resolve to a commit.`,
    );
  }
  return result.stdout.trim();
}

function numericVersion(tag, prefix) {
  if (!tag.startsWith(prefix)) {
    return undefined;
  }
  const suffix = tag.slice(prefix.length);
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      suffix,
    );
  const prerelease = match?.[4]?.split(".") ?? [];
  if (
    !match ||
    prerelease.some(
      (identifier) => /^\d+$/.test(identifier) && /^0\d+/.test(identifier),
    )
  ) {
    throw new ReleaseImpactError(
      "malformed-release-ref",
      `Release ref '${tag}' matches prefix '${prefix}' but has a malformed release version.`,
    );
  }
  return {
    core: [match[1], match[2], match[3]]
      .filter((component) => component !== undefined)
      .map(Number),
    prerelease,
  };
}

function compareVersions(left, right) {
  const width = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < width; index += 1) {
    const delta = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  const coreWidth = left.core.length - right.core.length;
  if (coreWidth !== 0) {
    return coreWidth;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length
      ? 0
      : left.prerelease.length === 0
        ? 1
        : -1;
  }
  const prereleaseWidth = Math.max(
    left.prerelease.length,
    right.prerelease.length,
  );
  for (let index = 0; index < prereleaseWidth; index += 1) {
    const leftIdentifier = left.prerelease[index];
    const rightIdentifier = right.prerelease[index];
    if (leftIdentifier === undefined || rightIdentifier === undefined) {
      return leftIdentifier === rightIdentifier
        ? 0
        : leftIdentifier === undefined
          ? -1
          : 1;
    }
    if (leftIdentifier === rightIdentifier) {
      continue;
    }
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return Number(leftIdentifier) - Number(rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftIdentifier.localeCompare(rightIdentifier);
  }
  return 0;
}

function matchingReleaseTags(repo, prefix) {
  const output = git(repo, ["tag", "--list", `${prefix}*`]);
  if (!output) {
    return [];
  }

  const parsed = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((tag) => ({ tag, version: numericVersion(tag, prefix) }));

  parsed.sort((left, right) => {
    const versionOrder = compareVersions(right.version, left.version);
    return versionOrder || left.tag.localeCompare(right.tag);
  });

  for (let index = 1; index < parsed.length; index += 1) {
    if (
      compareVersions(parsed[index - 1].version, parsed[index].version) === 0
    ) {
      throw new ReleaseImpactError(
        "ambiguous-release-history",
        `Release refs '${parsed[index - 1].tag}' and '${parsed[index].tag}' represent the same version.`,
      );
    }
  }

  return parsed;
}

function resolveBase(repo, prefix, explicitBaseRef, headSha) {
  let baseRef;
  let candidates = [];
  if (explicitBaseRef) {
    if (!numericVersion(explicitBaseRef, prefix)) {
      throw new ReleaseImpactError(
        "mismatched-release-ref",
        `Base ref '${explicitBaseRef}' does not match release prefix '${prefix}'.`,
      );
    }
    baseRef = explicitBaseRef;
  } else {
    candidates = matchingReleaseTags(repo, prefix);
    baseRef = candidates[0]?.tag;
  }

  if (!baseRef) {
    return {
      ref: null,
      sha: null,
      firstRelease: true,
      matchingRefs: [],
    };
  }

  const baseSha = resolveCommit(repo, baseRef, "Base");
  const ancestry = gitStatus(repo, [
    "merge-base",
    "--is-ancestor",
    baseSha,
    headSha,
  ]);
  if (ancestry.status !== 0) {
    throw new ReleaseImpactError(
      "divergent-release-history",
      `Latest release ref '${baseRef}' is not an ancestor of the requested head.`,
    );
  }

  for (const candidate of candidates.slice(1)) {
    const candidateSha = resolveCommit(repo, candidate.tag, "Release");
    const candidateAncestry = gitStatus(repo, [
      "merge-base",
      "--is-ancestor",
      candidateSha,
      headSha,
    ]);
    if (candidateAncestry.status !== 0) {
      throw new ReleaseImpactError(
        "ambiguous-release-history",
        `Release ref '${candidate.tag}' is outside the requested head history.`,
      );
    }
  }

  return {
    ref: baseRef,
    sha: baseSha,
    firstRelease: false,
    matchingRefs: candidates.map(({ tag }) => tag),
  };
}

function readAtRef(repo, ref, file) {
  const result = gitStatus(repo, ["show", `${ref}:${normalizePath(file)}`]);
  if (result.status !== 0) {
    return undefined;
  }
  return result.stdout;
}

function parseJsonAtRef(repo, ref, file, label) {
  const content = readAtRef(repo, ref, file);
  if (content === undefined) {
    throw new ReleaseImpactError(
      "missing-manifest",
      `${label} manifest '${file}' is missing at ${ref}.`,
    );
  }
  try {
    return JSON.parse(content);
  } catch {
    throw new ReleaseImpactError(
      "malformed-manifest",
      `${label} manifest '${file}' is not valid JSON at ${ref}.`,
    );
  }
}

function filesAtRef(repo, ref) {
  const output = git(repo, ["ls-tree", "-r", "--name-only", "-z", ref], {
    encoding: "buffer",
  });
  if (!output) {
    return [];
  }
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .sort();
}

function changedFilesBetween(repo, baseSha, headSha) {
  const output = git(
    repo,
    ["diff", "--name-only", "--diff-filter=ACDMRTUXB", "-z", baseSha, headSha],
    { encoding: "buffer" },
  );
  if (!output) {
    return [];
  }
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .sort();
}

function globPatternToRegex(pattern) {
  const normalized = normalizePath(pattern);
  let result = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === "*") {
      if (normalized[index + 1] === "*") {
        result += ".*";
        index += 1;
      } else {
        result += "[^/]*";
      }
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${result}$`);
}

function workspacePatterns(manifest) {
  if (Array.isArray(manifest.workspaces)) {
    return manifest.workspaces;
  }
  if (Array.isArray(manifest.workspaces?.packages)) {
    return manifest.workspaces.packages;
  }
  throw new ReleaseImpactError(
    "missing-workspaces",
    "Workspace root manifest does not declare a supported workspaces list.",
  );
}

function loadWorkspace(repo, ref, workspaceRootName) {
  const definition = WORKSPACE_ROOTS[workspaceRootName];
  if (!definition) {
    throw new ReleaseImpactError(
      "unknown-workspace-root",
      `Unknown workspace root '${workspaceRootName}'.`,
    );
  }

  const rootManifest = parseJsonAtRef(
    repo,
    ref,
    definition.manifest,
    "Workspace root",
  );
  const trackedFiles = filesAtRef(repo, ref);
  const manifestMatchers = workspacePatterns(rootManifest).map((pattern) => {
    const relativeManifest = `${normalizePath(pattern)}/package.json`;
    const rootedManifest = definition.directory
      ? `${definition.directory}/${relativeManifest}`
      : relativeManifest;
    return globPatternToRegex(rootedManifest);
  });

  const packageManifestPaths = trackedFiles.filter((file) =>
    manifestMatchers.some((matcher) => matcher.test(file)),
  );
  const packages = new Map();
  for (const manifestPath of packageManifestPaths) {
    const manifest = parseJsonAtRef(
      repo,
      ref,
      manifestPath,
      "Workspace package",
    );
    if (typeof manifest.name !== "string" || !manifest.name) {
      throw new ReleaseImpactError(
        "unnamed-workspace-package",
        `Workspace manifest '${manifestPath}' has no package name at ${ref}.`,
      );
    }
    if (packages.has(manifest.name)) {
      throw new ReleaseImpactError(
        "duplicate-workspace-package",
        `Workspace package '${manifest.name}' is declared more than once at ${ref}.`,
      );
    }
    packages.set(manifest.name, {
      name: manifest.name,
      manifest,
      manifestPath,
      directory: path.posix.dirname(manifestPath),
    });
  }

  return {
    definition,
    packages,
    rootManifest,
  };
}

function dependencyNames(manifest) {
  const names = new Set();
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      names.add(name);
    }
  }
  return names;
}

function transitiveWorkspacePackages(
  workspace,
  rootPackageNames,
  options = {},
) {
  const queue = [...rootPackageNames];
  const visited = new Set();
  while (queue.length > 0) {
    const packageName = queue.shift();
    if (visited.has(packageName)) {
      continue;
    }
    const workspacePackage = workspace.packages.get(packageName);
    if (!workspacePackage) {
      if (options.allowMissingRoot && rootPackageNames.includes(packageName)) {
        continue;
      }
      throw new ReleaseImpactError(
        "missing-workspace-package",
        `Workspace package '${packageName}' is not present in the selected workspace.`,
      );
    }
    visited.add(packageName);
    for (const dependencyName of dependencyNames(workspacePackage.manifest)) {
      if (workspace.packages.has(dependencyName)) {
        queue.push(dependencyName);
      }
    }
  }
  return [...visited]
    .map((name) => workspace.packages.get(name))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function mergeUnique(values) {
  return [...new Set(values.filter(Boolean).map(normalizePath))].sort();
}

function packageSurfaceForDefinition(repo, ref, definition, options = {}) {
  if (definition.packageDirs) {
    return {
      packages: definition.packageDirs
        .map((entry) => ({
          name: entry.name,
          directory: normalizePath(entry.directory),
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      workspaceConfigPaths: [],
      workspaceConfigPrefixes: [],
    };
  }

  const workspace = loadWorkspace(repo, ref, definition.workspaceRoot);
  return {
    packages: transitiveWorkspacePackages(
      workspace,
      definition.packageNames,
      options,
    ).map(({ name, directory }) => ({ name, directory })),
    workspaceConfigPaths: workspace.definition.configPaths,
    workspaceConfigPrefixes: workspace.definition.configPrefixes,
  };
}

function matchesDirectory(file, directory) {
  return file === directory || file.startsWith(`${directory}/`);
}

function classifyChangedFiles(
  changedFiles,
  packages,
  configPaths,
  configPrefixes,
  rootPackageNames,
) {
  const matchedFiles = [];
  const ignoredFiles = [];
  const reasonBuckets = new Map();

  const sortedPackages = [...packages].sort(
    (left, right) => right.directory.length - left.directory.length,
  );

  const addReasonPath = (code, file, packageName) => {
    const key = `${code}\0${packageName ?? ""}`;
    const bucket = reasonBuckets.get(key) ?? {
      code,
      ...(packageName ? { package: packageName } : {}),
      paths: [],
    };
    bucket.paths.push(file);
    reasonBuckets.set(key, bucket);
  };

  for (const file of changedFiles) {
    const workspacePackage = sortedPackages.find((entry) =>
      matchesDirectory(file, entry.directory),
    );
    const exactConfig = configPaths.includes(file);
    const prefixConfig = configPrefixes.find((prefix) =>
      file.startsWith(prefix),
    );

    if (workspacePackage) {
      matchedFiles.push(file);
      addReasonPath(
        rootPackageNames.includes(workspacePackage.name)
          ? "target-package-change"
          : "workspace-dependency-change",
        file,
        workspacePackage.name,
      );
    } else if (exactConfig || prefixConfig) {
      matchedFiles.push(file);
      addReasonPath("release-build-config-change", file);
    } else {
      ignoredFiles.push(file);
    }
  }

  return {
    ignoredFiles,
    matchedFiles,
    reasons: [...reasonBuckets.values()]
      .map((reason) => ({ ...reason, paths: reason.paths.sort() }))
      .sort((left, right) => {
        const codeOrder = left.code.localeCompare(right.code);
        return (
          codeOrder || (left.package ?? "").localeCompare(right.package ?? "")
        );
      }),
  };
}

function validateForce(force, forceReason) {
  if (force && !forceReason?.trim()) {
    throw new ReleaseImpactError(
      "unaudited-force",
      "A forced release requires a non-empty --force-reason.",
    );
  }
  if (!force && forceReason?.trim()) {
    throw new ReleaseImpactError(
      "unexpected-force-reason",
      "--force-reason was supplied without --force true.",
    );
  }
}

export function analyzeDefinitionImpact({
  repo = process.cwd(),
  definition,
  identity,
  headRef = "HEAD",
  baseRef,
  force = false,
  forceReason = "",
}) {
  validateForce(force, forceReason);
  ensureCompleteHistory(repo);
  const headSha = resolveCommit(repo, headRef, "Head");
  const base = resolveBase(repo, definition.tagPrefix, baseRef, headSha);

  const headSurface = packageSurfaceForDefinition(repo, headSha, definition);
  const baseSurface = base.sha
    ? packageSurfaceForDefinition(repo, base.sha, definition, {
        allowMissingRoot: true,
      })
    : {
        packages: [],
        workspaceConfigPaths: [],
        workspaceConfigPrefixes: [],
      };

  const packagesByName = new Map();
  for (const workspacePackage of [
    ...baseSurface.packages,
    ...headSurface.packages,
  ]) {
    packagesByName.set(workspacePackage.name, workspacePackage);
  }
  const packages = [...packagesByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  const configPaths = mergeUnique([
    ...(definition.configPaths ?? []),
    ...baseSurface.workspaceConfigPaths,
    ...headSurface.workspaceConfigPaths,
  ]);
  const configPrefixes = mergeUnique([
    ...(definition.configPrefixes ?? []),
    ...baseSurface.workspaceConfigPrefixes,
    ...headSurface.workspaceConfigPrefixes,
  ]);

  const changedFiles = base.sha
    ? changedFilesBetween(repo, base.sha, headSha)
    : [];
  const classified = classifyChangedFiles(
    changedFiles,
    packages,
    configPaths,
    configPrefixes,
    definition.packageNames ?? definition.packageDirs.map(({ name }) => name),
  );

  const reasons = [...classified.reasons];
  if (base.firstRelease) {
    reasons.unshift({
      code: "first-release",
      message: `No prior release ref matching '${definition.tagPrefix}*' exists.`,
    });
  }
  if (force) {
    reasons.unshift({
      code: "forced-release",
      message: forceReason.trim(),
    });
  }

  return {
    schemaVersion: 1,
    mode: "single",
    identity,
    tagPrefix: definition.tagPrefix,
    changed: force || base.firstRelease || classified.matchedFiles.length > 0,
    forced: force,
    forceReason: force ? forceReason.trim() : null,
    firstRelease: base.firstRelease,
    baseRef: base.ref,
    baseSha: base.sha,
    headRef,
    headSha,
    matchingReleaseRefs: base.matchingRefs,
    packages,
    configPaths,
    configPrefixes,
    changedFiles,
    matchedFiles: classified.matchedFiles,
    ignoredFiles: classified.ignoredFiles,
    reasons,
  };
}

export function analyzeProductImpact(options) {
  const definition = RELEASE_TARGETS[options.target];
  if (!definition) {
    throw new ReleaseImpactError(
      "unknown-release-target",
      `Unknown release target '${options.target}'.`,
    );
  }
  return analyzeDefinitionImpact({
    ...options,
    definition,
    identity: options.target,
  });
}

function workspaceRootForPackage(repo, headRef, packageName, requestedRoot) {
  const rootNames = requestedRoot
    ? [requestedRoot]
    : Object.keys(WORKSPACE_ROOTS);
  const matches = [];
  for (const rootName of rootNames) {
    const workspace = loadWorkspace(repo, headRef, rootName);
    if (workspace.packages.has(packageName)) {
      matches.push(rootName);
    }
  }
  if (matches.length === 0) {
    throw new ReleaseImpactError(
      "missing-workspace-package",
      `Package '${packageName}' was not found in the selected workspace roots.`,
    );
  }
  if (matches.length > 1) {
    throw new ReleaseImpactError(
      "ambiguous-workspace-package",
      `Package '${packageName}' exists in multiple workspace roots: ${matches.join(", ")}.`,
    );
  }
  return matches[0];
}

export function analyzeWorkspacePackageImpact({
  repo = process.cwd(),
  packageName,
  workspaceRoot,
  ...options
}) {
  ensureCompleteHistory(repo);
  const headSha = resolveCommit(repo, options.headRef ?? "HEAD", "Head");
  const resolvedWorkspaceRoot = workspaceRootForPackage(
    repo,
    headSha,
    packageName,
    workspaceRoot,
  );
  return analyzeDefinitionImpact({
    repo,
    ...options,
    definition: {
      workspaceRoot: resolvedWorkspaceRoot,
      packageNames: [packageName],
      tagPrefix: `${packageName}@`,
      configPaths: [],
      configPrefixes: [],
    },
    identity: packageName,
  });
}

export function analyzeAllWorkspacePackages({
  repo = process.cwd(),
  workspaceRoot,
  headRef = "HEAD",
  force = false,
  forceReason = "",
}) {
  if (!WORKSPACE_ROOTS[workspaceRoot]) {
    throw new ReleaseImpactError(
      "unknown-workspace-root",
      `Unknown workspace root '${workspaceRoot}'.`,
    );
  }
  ensureCompleteHistory(repo);
  const headSha = resolveCommit(repo, headRef, "Head");
  const workspace = loadWorkspace(repo, headSha, workspaceRoot);
  const packages = [...workspace.packages.keys()].sort().map((packageName) =>
    analyzeWorkspacePackageImpact({
      repo,
      packageName,
      workspaceRoot,
      headRef,
      force,
      forceReason,
    }),
  );

  return {
    schemaVersion: 1,
    mode: "all-workspaces",
    workspaceRoot,
    headRef,
    headSha,
    changed: packages.some((entry) => entry.changed),
    changedPackages: packages
      .filter((entry) => entry.changed)
      .map((entry) => entry.identity),
    packages,
  };
}

function parseBoolean(value, flag) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ReleaseImpactError(
    "invalid-argument",
    `${flag} must be 'true' or 'false'.`,
  );
}

function parseArguments(argv) {
  const supportedArguments = new Set([
    "--all-workspaces",
    "--base-ref",
    "--force",
    "--force-reason",
    "--github-output",
    "--head",
    "--output",
    "--package",
    "--repo",
    "--target",
    "--workspace-root",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      throw new ReleaseImpactError(
        "invalid-argument",
        `Unexpected positional argument '${argument}'.`,
      );
    }
    if (!supportedArguments.has(argument)) {
      throw new ReleaseImpactError(
        "invalid-argument",
        `Unknown argument '${argument}'.\n${usage()}`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ReleaseImpactError(
        "invalid-argument",
        `Missing value for '${argument}'.`,
      );
    }
    if (values.has(argument)) {
      throw new ReleaseImpactError(
        "invalid-argument",
        `Argument '${argument}' was supplied more than once.`,
      );
    }
    values.set(argument, value);
    index += 1;
  }
  return values;
}

function appendGithubOutputs(file, result) {
  const reasons = result.mode === "single" ? result.reasons : [];
  const changedFiles = result.mode === "single" ? result.matchedFiles : [];
  const githubSummary =
    result.mode === "single"
      ? {
          schemaVersion: result.schemaVersion,
          mode: result.mode,
          identity: result.identity,
          changed: result.changed,
          forced: result.forced,
          forceReason: result.forceReason,
          firstRelease: result.firstRelease,
          baseRef: result.baseRef,
          baseSha: result.baseSha,
          headSha: result.headSha,
          matchedFiles: result.matchedFiles,
          reasons: result.reasons,
        }
      : {
          schemaVersion: result.schemaVersion,
          mode: result.mode,
          workspaceRoot: result.workspaceRoot,
          changed: result.changed,
          changedPackages: result.changedPackages,
          headSha: result.headSha,
        };
  const outputs = {
    changed: String(result.changed),
    forced: String(
      result.mode === "single"
        ? result.forced
        : result.packages.some((entry) => entry.forced),
    ),
    base_ref: result.mode === "single" && result.baseRef ? result.baseRef : "",
    base_sha: result.mode === "single" && result.baseSha ? result.baseSha : "",
    head_sha: result.headSha,
    reason_codes: JSON.stringify(reasons.map(({ code }) => code)),
    changed_files: JSON.stringify(changedFiles),
    result_json: JSON.stringify(githubSummary),
  };
  appendFileSync(
    file,
    `${Object.entries(outputs)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n")}\n`,
  );
}

function usage() {
  return [
    "Usage:",
    "  node scripts/analyze-release-impact.mjs --target <srn-*> [options]",
    "  node scripts/analyze-release-impact.mjs --package <name> [--workspace-root root|app|server] [options]",
    "  node scripts/analyze-release-impact.mjs --all-workspaces <root|app|server> [options]",
    "",
    "Options: --repo <path> --head <ref> --base-ref <tag> --force <true|false>",
    "         --force-reason <text> --output <json-file> --github-output <file>",
  ].join("\n");
}

export function runCli(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const repo = path.resolve(args.get("--repo") ?? process.cwd());
  const headRef = args.get("--head") ?? "HEAD";
  const baseRef = args.get("--base-ref");
  const force = parseBoolean(args.get("--force") ?? "false", "--force");
  const forceReason = args.get("--force-reason") ?? "";

  const modes = [
    args.has("--target"),
    args.has("--package"),
    args.has("--all-workspaces"),
  ].filter(Boolean).length;
  if (modes !== 1) {
    throw new ReleaseImpactError(
      "invalid-argument",
      `Choose exactly one analysis mode.\n${usage()}`,
    );
  }
  if (!args.has("--package") && args.has("--workspace-root")) {
    throw new ReleaseImpactError(
      "invalid-argument",
      "--workspace-root is supported only with --package; --all-workspaces takes its workspace root as the mode value.",
    );
  }

  let result;
  if (args.has("--target")) {
    result = analyzeProductImpact({
      repo,
      target: args.get("--target"),
      headRef,
      baseRef,
      force,
      forceReason,
    });
  } else if (args.has("--package")) {
    result = analyzeWorkspacePackageImpact({
      repo,
      packageName: args.get("--package"),
      workspaceRoot: args.get("--workspace-root"),
      headRef,
      baseRef,
      force,
      forceReason,
    });
  } else {
    if (baseRef) {
      throw new ReleaseImpactError(
        "invalid-argument",
        "--base-ref is not supported with --all-workspaces because every package has its own tag.",
      );
    }
    result = analyzeAllWorkspacePackages({
      repo,
      workspaceRoot: args.get("--all-workspaces"),
      headRef,
      force,
      forceReason,
    });
  }

  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (args.has("--output")) {
    writeFileSync(path.resolve(repo, args.get("--output")), serialized);
  }
  if (args.has("--github-output")) {
    appendGithubOutputs(args.get("--github-output"), result);
  }
  process.stdout.write(serialized);
  return result;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === invokedPath) {
  try {
    runCli();
  } catch (error) {
    const code =
      error instanceof ReleaseImpactError ? error.code : "unexpected-error";
    process.stderr.write(
      `${JSON.stringify({
        schemaVersion: 1,
        changed: null,
        error: {
          code,
          message: error instanceof Error ? error.message : String(error),
        },
      })}\n`,
    );
    process.exitCode = 1;
  }
}
