#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const COVERAGE_FILE = "coverage-final.json";
const MANIFEST_FILE = "manifest.json";
const METRIC_NAMES = ["statements", "branches", "functions", "lines"];
export const DEFAULT_WORKSPACE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_JEST_WORKERS = 1;
const PROCESS_TERMINATION_GRACE_MS = 5 * 1000;
const EFFECTIVE_JEST_CONFIG_PREFIX = ".coverage-effective-jest-";
const FAILED_COVERAGE_DIAGNOSTIC = "Failed to collect coverage";
const JEST_CONFIG_FILES = Object.freeze([
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.json",
  "jest.config.mjs",
  "jest.config.ts",
  "jest.config.cts",
]);
const SUPPORTED_JEST_CONFIG_EXTENSIONS = new Set([".js", ".cjs", ".json"]);
const SOURCE_ROOTS = ["src", "lib"];
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  "__fixtures__",
  "__tests__",
  "build",
  "coverage",
  "dist",
  "fixture",
  "fixtures",
  "generated",
  "node_modules",
  "spec",
  "specs",
  "test",
  "tests",
  "vendor",
]);
const INSTRUMENTATION_PARSER_PLUGINS = Object.freeze([
  "decorators-legacy",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "importAttributes",
  "topLevelAwait",
]);
const TEST_DISCOVERY_EXCLUDED_DIRECTORIES = new Set([
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "vendor",
]);
const REVIEWED_SOURCE_ONLY_WORKSPACES = Object.freeze({
  app: Object.freeze({}),
  server: Object.freeze({
    "packages/domain-events":
      "Domain event contracts with no package-local Jest test/spec files.",
    "packages/predicates":
      "Predicate contracts with no package-local Jest test/spec files.",
  }),
});
const SOURCE_ONLY_APPROVAL = Symbol("reviewed source-only workspace");

function frozenInventory(entries) {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

export const EXPECTED_COVERAGE_WORKSPACES = Object.freeze({
  app: frozenInventory([
    { location: "packages/api", name: "@standardnotes/api" },
    { location: "packages/encryption", name: "@standardnotes/encryption" },
    { location: "packages/features", name: "@standardnotes/features" },
    { location: "packages/filepicker", name: "@standardnotes/filepicker" },
    { location: "packages/files", name: "@standardnotes/files" },
    { location: "packages/mobile", name: "@standardnotes/mobile" },
    { location: "packages/models", name: "@standardnotes/models" },
    { location: "packages/responses", name: "@standardnotes/responses" },
    { location: "packages/services", name: "@standardnotes/services" },
    { location: "packages/snjs", name: "@standardnotes/snjs" },
    { location: "packages/ui-services", name: "@standardnotes/ui-services" },
    { location: "packages/utils", name: "@standardnotes/utils" },
    { location: "packages/web", name: "@standardnotes/web" },
  ]),
  server: frozenInventory([
    { location: "packages/analytics", name: "@standardnotes/analytics" },
    {
      location: "packages/api-gateway",
      name: "@standardnotes/api-gateway",
    },
    { location: "packages/auth", name: "@standardnotes/auth-server" },
    { location: "packages/common", name: "@standardnotes/common" },
    { location: "packages/domain-core", name: "@standardnotes/domain-core" },
    {
      location: "packages/domain-events",
      name: "@standardnotes/domain-events",
      sourceOnlyReason:
        REVIEWED_SOURCE_ONLY_WORKSPACES.server["packages/domain-events"],
    },
    {
      location: "packages/domain-events-infra",
      name: "@standardnotes/domain-events-infra",
    },
    { location: "packages/files", name: "@standardnotes/files-server" },
    {
      location: "packages/home-server",
      name: "@standardnotes/home-server",
    },
    {
      location: "packages/predicates",
      name: "@standardnotes/predicates",
      sourceOnlyReason:
        REVIEWED_SOURCE_ONLY_WORKSPACES.server["packages/predicates"],
    },
    {
      location: "packages/revisions",
      name: "@standardnotes/revisions-server",
    },
    {
      location: "packages/scheduler",
      name: "@standardnotes/scheduler-server",
    },
    { location: "packages/security", name: "@standardnotes/security" },
    { location: "packages/settings", name: "@standardnotes/settings" },
    {
      location: "packages/sncrypto-node",
      name: "@standardnotes/sncrypto-node",
    },
    {
      location: "packages/syncing-server",
      name: "@standardnotes/syncing-server",
    },
    { location: "packages/time", name: "@standardnotes/time" },
    {
      location: "packages/websockets",
      name: "@standardnotes/websockets-server",
    },
  ]),
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function duplicateValues(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

function assertUniqueValues(values, label) {
  const duplicates = duplicateValues(values);
  if (duplicates.length > 0) {
    throw new Error(`Duplicate ${label}(s): ${duplicates.join(", ")}`);
  }
}

function fileSystemKey(file) {
  const normalized = path.resolve(file);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sourcePathKey(source) {
  return process.platform === "win32" ? source.toLowerCase() : source;
}

async function readJson(file) {
  let contents;
  try {
    contents = await fs.readFile(file, "utf8");
  } catch (error) {
    throw new Error(`Missing input: ${file}`, { cause: error });
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Malformed JSON in ${file}: ${error.message}`, {
      cause: error,
    });
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function workspacePatterns(manifest) {
  if (Array.isArray(manifest.workspaces)) {
    return manifest.workspaces;
  }
  if (
    isObject(manifest.workspaces) &&
    Array.isArray(manifest.workspaces.packages)
  ) {
    return manifest.workspaces.packages;
  }
  return [];
}

async function expandWorkspacePattern(root, pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new Error(`Invalid workspace pattern in ${root}`);
  }
  if (!pattern.includes("*")) {
    return [path.resolve(root, pattern)];
  }

  const normalized = pattern.replaceAll("\\", "/");
  if (!normalized.endsWith("/*") || normalized.slice(0, -2).includes("*")) {
    throw new Error(
      `Unsupported workspace pattern ${JSON.stringify(pattern)} in ${root}`,
    );
  }

  const parent = path.resolve(root, normalized.slice(0, -2));
  const entries = await fs.readdir(parent, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .sort();
}

async function discoverWorkspaceDirectories(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const queue = [root];
  const visited = new Set();
  const declared = new Map([[fileSystemKey(root), "<workspace root>"]]);
  const discovered = [];

  while (queue.length > 0) {
    const current = queue.shift();
    const currentKey = fileSystemKey(current);
    if (visited.has(currentKey)) {
      continue;
    }
    visited.add(currentKey);

    const manifestFile = path.join(current, "package.json");
    const manifest = await readJson(manifestFile);
    for (const pattern of workspacePatterns(manifest)) {
      for (const workspace of await expandWorkspacePattern(current, pattern)) {
        const workspaceManifest = path.join(workspace, "package.json");
        try {
          await fs.access(workspaceManifest);
        } catch {
          throw new Error(
            `Workspace ${workspace} does not contain package.json`,
          );
        }

        const workspaceKey = fileSystemKey(workspace);
        const previousDeclaration = declared.get(workspaceKey);
        if (previousDeclaration) {
          throw new Error(
            `Duplicate workspace path ${workspace} declared by ${previousDeclaration} and ${manifestFile}`,
          );
        }
        declared.set(workspaceKey, manifestFile);
        discovered.push(path.resolve(workspace));
        queue.push(path.resolve(workspace));
      }
    }
  }

  return discovered.sort();
}

export function isJestTestScript(script) {
  return (
    typeof script === "string" &&
    /(?:^|[\s;&|])jest(?:\.js)?(?:$|\s)/.test(script)
  );
}

export function workspaceSlug(location) {
  if (typeof location !== "string" || location.length === 0) {
    throw new Error("Coverage workspace location must be a non-empty string");
  }
  const slug = location.replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
  if (slug.length === 0) {
    throw new Error(
      `Coverage workspace location has no usable slug: ${location}`,
    );
  }
  return slug;
}

export function validateWorkspaceInventory(inventory, scope = "coverage") {
  if (!Array.isArray(inventory) || inventory.length === 0) {
    throw new Error(`${scope} coverage workspace inventory must not be empty`);
  }

  const validated = inventory.map((workspace, index) => {
    if (
      !isObject(workspace) ||
      typeof workspace.name !== "string" ||
      workspace.name.length === 0 ||
      typeof workspace.location !== "string" ||
      workspace.location.length === 0
    ) {
      throw new Error(`Malformed ${scope} workspace inventory entry ${index}`);
    }
    const normalizedLocation = workspace.location.replaceAll("\\", "/");
    if (
      normalizedLocation.startsWith("/") ||
      normalizedLocation.split("/").some((segment) => segment === "..")
    ) {
      throw new Error(
        `Invalid ${scope} workspace location: ${workspace.location}`,
      );
    }
    if (
      workspace.emptySourceReason !== undefined &&
      (typeof workspace.emptySourceReason !== "string" ||
        workspace.emptySourceReason.trim().length === 0)
    ) {
      throw new Error(
        `Invalid empty-source reason for ${scope}/${normalizedLocation}`,
      );
    }
    if (
      workspace.sourceOnlyReason !== undefined &&
      (typeof workspace.sourceOnlyReason !== "string" ||
        workspace.sourceOnlyReason.trim().length === 0)
    ) {
      throw new Error(
        `Invalid source-only reason for ${scope}/${normalizedLocation}`,
      );
    }
    if (
      workspace.emptySourceReason !== undefined &&
      workspace.sourceOnlyReason !== undefined
    ) {
      throw new Error(
        `Coverage workspace ${scope}/${normalizedLocation} cannot be both empty and source-only`,
      );
    }
    const slug = workspaceSlug(normalizedLocation);
    if (workspace.slug !== undefined && workspace.slug !== slug) {
      throw new Error(
        `Invalid ${scope} workspace slug for ${normalizedLocation}: ${workspace.slug}`,
      );
    }
    return {
      name: workspace.name,
      location: normalizedLocation,
      slug,
      emptySourceReason: workspace.emptySourceReason,
      sourceOnlyReason: workspace.sourceOnlyReason,
    };
  });

  assertUniqueValues(
    validated.map(({ name }) => name),
    `${scope} workspace name`,
  );
  assertUniqueValues(
    validated.map(({ location }) => location),
    `${scope} workspace location`,
  );
  assertUniqueValues(
    validated.map(({ slug }) => slug),
    `${scope} workspace slug`,
  );
  return validated.sort((left, right) =>
    left.location.localeCompare(right.location),
  );
}

function validateReviewedSourceOnlyInventory(
  inventory,
  scope,
  { requireAllReviewed = false } = {},
) {
  const reviewed = REVIEWED_SOURCE_ONLY_WORKSPACES[scope] ?? {};
  const byLocation = new Map(
    inventory.map((workspace) => [workspace.location, workspace]),
  );

  for (const workspace of inventory) {
    const reviewedReason = reviewed[workspace.location];
    if (workspace.sourceOnlyReason === undefined) {
      if (reviewedReason !== undefined) {
        throw new Error(
          `Source-only coverage inventory drift for ${scope}/${workspace.location}: missing sourceOnlyReason`,
        );
      }
      continue;
    }
    if (reviewedReason === undefined) {
      throw new Error(
        `Unexpected source-only coverage workspace ${scope}/${workspace.location}`,
      );
    }
    if (workspace.sourceOnlyReason !== reviewedReason) {
      throw new Error(
        `Source-only coverage inventory drift for ${scope}/${workspace.location}: reason does not match the reviewed inventory`,
      );
    }
  }

  if (requireAllReviewed) {
    const missing = Object.keys(reviewed).filter(
      (location) => !byLocation.has(location),
    );
    if (missing.length > 0) {
      throw new Error(
        `Source-only coverage inventory drift for ${scope}; missing reviewed workspace(s): ${missing.join(", ")}`,
      );
    }
  }
}

export async function discoverJestWorkspaces(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const directories = await discoverWorkspaceDirectories(root);
  const workspaces = [];

  for (const directory of directories) {
    const manifest = await readJson(path.join(directory, "package.json"));
    const testScript = manifest.scripts?.test;
    if (!isJestTestScript(testScript)) {
      continue;
    }

    workspaces.push({
      directory,
      location: path.relative(root, directory).split(path.sep).join("/"),
      name: manifest.name ?? path.basename(directory),
      testScript,
    });
  }

  assertUniqueValues(
    workspaces.map(({ name }) => name),
    "discovered Jest workspace name",
  );
  assertUniqueValues(
    workspaces.map(({ location }) => location),
    "discovered Jest workspace location",
  );
  return workspaces.sort((left, right) =>
    left.location.localeCompare(right.location),
  );
}

function isEligibleSourcePath(workspaceRelativePath) {
  const normalized = workspaceRelativePath.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (!SOURCE_ROOTS.includes(segments[0])) {
    return false;
  }
  if (
    segments
      .slice(1, -1)
      .some((segment) => EXCLUDED_SOURCE_DIRECTORIES.has(segment.toLowerCase()))
  ) {
    return false;
  }
  const fileName = segments.at(-1);
  if (!SOURCE_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
    return false;
  }
  if (/\.d\.(?:ts|tsx)$/i.test(fileName)) {
    return false;
  }
  return !/\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/i.test(fileName);
}

async function walkFiles(
  directory,
  excludedDirectories = EXCLUDED_SOURCE_DIRECTORIES,
) {
  const files = [];
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase())) {
          await walk(entryPath);
        }
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  await walk(directory);
  return files;
}

async function discoverPackageTestFiles(workspaceDirectory) {
  return (
    await walkFiles(workspaceDirectory, TEST_DISCOVERY_EXCLUDED_DIRECTORIES)
  )
    .filter((file) => /\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/i.test(file))
    .map((file) =>
      path.relative(workspaceDirectory, file).split(path.sep).join("/"),
    )
    .sort();
}

async function validateSourceOnlyWorkspaceEvidence(
  workspace,
  scope,
  workspaceDirectory,
) {
  if (!workspace.sourceOnlyReason) {
    return;
  }
  const testFiles = await discoverPackageTestFiles(workspaceDirectory);
  if (testFiles.length > 0) {
    throw new Error(
      `Source-only coverage inventory drift for ${scope}/${workspace.location}: found package-local test/spec file(s): ${testFiles.join(", ")}`,
    );
  }
}

export async function discoverEligibleSourceFiles(
  workspaceDirectory,
  repoRoot = process.cwd(),
) {
  const workspace = path.resolve(workspaceDirectory);
  const sources = [];
  for (const sourceRoot of SOURCE_ROOTS) {
    const sourceDirectory = path.join(workspace, sourceRoot);
    try {
      const stat = await fs.stat(sourceDirectory);
      if (!stat.isDirectory()) {
        continue;
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const absolute of await walkFiles(sourceDirectory)) {
      const workspacePath = path
        .relative(workspace, absolute)
        .split(path.sep)
        .join("/");
      if (!isEligibleSourcePath(workspacePath)) {
        continue;
      }
      sources.push({
        absolute: path.resolve(absolute),
        repositoryPath: canonicalSourcePath(absolute, repoRoot),
        workspacePath,
      });
    }
  }

  assertUniqueValues(
    sources.map(({ repositoryPath }) => sourcePathKey(repositoryPath)),
    "eligible source path",
  );
  return sources.sort((left, right) =>
    left.workspacePath.localeCompare(right.workspacePath),
  );
}

function describeInventoryDifference(expected, discovered) {
  const expectedByLocation = new Map(
    expected.map((workspace) => [workspace.location, workspace]),
  );
  const discoveredByLocation = new Map(
    discovered.map((workspace) => [workspace.location, workspace]),
  );
  const details = [];
  const missing = expected
    .filter(({ location }) => !discoveredByLocation.has(location))
    .map(({ location }) => location);
  const unexpected = discovered
    .filter(({ location }) => !expectedByLocation.has(location))
    .map(({ location }) => location);
  const renamed = expected
    .filter(({ location, name }) => {
      const actual = discoveredByLocation.get(location);
      return actual && actual.name !== name;
    })
    .map(({ location, name }) => {
      const actual = discoveredByLocation.get(location);
      return `${location} (${name} != ${actual.name})`;
    });
  if (missing.length > 0) details.push(`missing: ${missing.join(", ")}`);
  if (unexpected.length > 0) {
    details.push(`unexpected: ${unexpected.join(", ")}`);
  }
  if (renamed.length > 0) details.push(`renamed: ${renamed.join(", ")}`);
  return details.join("; ");
}

export async function resolveCoverageWorkspaces({
  repoRoot = process.cwd(),
  workspaceRoot,
  expectedWorkspaces,
}) {
  const repository = path.resolve(repoRoot);
  const workspaceDirectory = path.resolve(repository, workspaceRoot);
  if (!isInside(repository, workspaceDirectory)) {
    throw new Error(`Workspace root must be inside ${repository}`);
  }
  const scope = path
    .relative(repository, workspaceDirectory)
    .split(path.sep)
    .join("/");
  const configuredInventory =
    expectedWorkspaces ?? EXPECTED_COVERAGE_WORKSPACES[scope];
  if (!configuredInventory) {
    throw new Error(`No coverage workspace inventory is defined for ${scope}`);
  }

  const expected = validateWorkspaceInventory(configuredInventory, scope);
  validateReviewedSourceOnlyInventory(expected, scope, {
    requireAllReviewed:
      configuredInventory === EXPECTED_COVERAGE_WORKSPACES[scope],
  });
  const discovered = await discoverJestWorkspaces(workspaceDirectory);
  validateWorkspaceInventory(discovered, `discovered ${scope}`);
  const difference = describeInventoryDifference(expected, discovered);
  if (difference.length > 0) {
    throw new Error(
      `Coverage workspace inventory drift for ${scope}: ${difference}`,
    );
  }

  const discoveredByLocation = new Map(
    discovered.map((workspace) => [workspace.location, workspace]),
  );
  const workspaces = [];
  for (const inventoryEntry of expected) {
    const workspace = {
      ...discoveredByLocation.get(inventoryEntry.location),
      ...inventoryEntry,
    };
    const sourceFiles = await discoverEligibleSourceFiles(
      workspace.directory,
      repository,
    );
    if (sourceFiles.length === 0 && !workspace.emptySourceReason) {
      throw new Error(
        `${workspace.name} (${scope}/${workspace.location}) has no eligible src/lib JS/TS source; document emptySourceReason in the inventory if this is intentional`,
      );
    }
    if (sourceFiles.length > 0 && workspace.emptySourceReason) {
      throw new Error(
        `${workspace.name} (${scope}/${workspace.location}) has eligible source but is documented as empty`,
      );
    }
    await validateSourceOnlyWorkspaceEvidence(
      workspace,
      scope,
      workspace.directory,
    );
    workspaces.push({
      ...workspace,
      sourceFiles,
      [SOURCE_ONLY_APPROVAL]: workspace.sourceOnlyReason !== undefined,
    });
  }

  return { scope, workspaces };
}

function validateCounterMap(counters, label, reportFile) {
  if (!isObject(counters)) {
    throw new Error(
      `Malformed coverage report ${reportFile}: ${label} must be an object`,
    );
  }
  for (const value of Object.values(counters)) {
    const values = Array.isArray(value) ? value : [value];
    if (
      values.some(
        (counter) =>
          !Number.isFinite(counter) ||
          counter < 0 ||
          !Number.isInteger(counter),
      )
    ) {
      throw new Error(
        `Malformed coverage report ${reportFile}: ${label} has an invalid counter`,
      );
    }
  }
}

function validateMapCounterKeys(map, counters, label, reportFile) {
  const mapKeys = Object.keys(map).sort();
  const counterKeys = Object.keys(counters).sort();
  if (
    mapKeys.length !== counterKeys.length ||
    mapKeys.some((key, index) => key !== counterKeys[index])
  ) {
    throw new Error(
      `Malformed coverage report ${reportFile}: ${label} map and counters differ`,
    );
  }
}

export function validateCoverageReport(
  report,
  reportFile = "<coverage report>",
) {
  if (!isObject(report)) {
    throw new Error(
      `Malformed coverage report ${reportFile}: expected a JSON object`,
    );
  }

  for (const [source, coverage] of Object.entries(report)) {
    if (
      !isObject(coverage) ||
      typeof coverage.path !== "string" ||
      coverage.path.length === 0
    ) {
      throw new Error(
        `Malformed coverage report ${reportFile}: ${source} has no source path`,
      );
    }
    for (const mapName of ["statementMap", "fnMap", "branchMap"]) {
      if (!isObject(coverage[mapName])) {
        throw new Error(
          `Malformed coverage report ${reportFile}: ${source}.${mapName} must be an object`,
        );
      }
    }
    validateCounterMap(coverage.s, `${source}.s`, reportFile);
    validateCounterMap(coverage.f, `${source}.f`, reportFile);
    validateCounterMap(coverage.b, `${source}.b`, reportFile);
    validateMapCounterKeys(
      coverage.statementMap,
      coverage.s,
      `${source}.statements`,
      reportFile,
    );
    validateMapCounterKeys(
      coverage.fnMap,
      coverage.f,
      `${source}.functions`,
      reportFile,
    );
    validateMapCounterKeys(
      coverage.branchMap,
      coverage.b,
      `${source}.branches`,
      reportFile,
    );
  }

  return report;
}

export function validateExactCoverageSources(
  report,
  expectedSources,
  reportFile = "<coverage report>",
) {
  validateCoverageReport(report, reportFile);
  if (
    !Array.isArray(expectedSources) ||
    expectedSources.some((source) => typeof source !== "string")
  ) {
    throw new Error(`Malformed expected source inventory for ${reportFile}`);
  }

  assertUniqueValues(
    expectedSources.map(sourcePathKey),
    `${reportFile} expected coverage source`,
  );
  const expectedByKey = new Map(
    expectedSources.map((source) => [sourcePathKey(source), source]),
  );
  const actualByKey = new Map();
  const duplicates = [];
  const keyMismatches = [];

  for (const [reportKey, coverage] of Object.entries(report)) {
    const key = sourcePathKey(coverage.path);
    if (actualByKey.has(key)) {
      duplicates.push(coverage.path);
    } else {
      actualByKey.set(key, coverage.path);
    }
    if (reportKey !== coverage.path) {
      keyMismatches.push(`${reportKey} != ${coverage.path}`);
    }
  }

  const missing = [...expectedByKey.entries()]
    .filter(([key]) => !actualByKey.has(key))
    .map(([, source]) => source);
  const unexpected = [...actualByKey.entries()]
    .filter(([key]) => !expectedByKey.has(key))
    .map(([, source]) => source);
  if (
    missing.length > 0 ||
    unexpected.length > 0 ||
    duplicates.length > 0 ||
    keyMismatches.length > 0
  ) {
    throw new Error(
      `Coverage report source mismatch in ${reportFile}; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}; duplicates: ${duplicates.join(", ") || "none"}; key/path mismatches: ${keyMismatches.join(", ") || "none"}`,
    );
  }

  return report;
}

function outputDirectoryFor(workspace, outputRoot) {
  return path.join(outputRoot, workspace.slug);
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

function yarnCommand(args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "yarn", ...args],
    };
  }
  return { command: "yarn", args };
}

function tokenizePackageTestScript(testScript) {
  const tokens = [];
  let token = "";
  let quote;
  let tokenStarted = false;

  for (let index = 0; index < testScript.length; index += 1) {
    const character = testScript[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (
        quote === '"' &&
        character === "\\" &&
        ['"', "\\"].includes(testScript[index + 1])
      ) {
        index += 1;
        token += testScript[index];
      } else {
        token += character;
      }
      tokenStarted = true;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      tokenStarted = true;
    } else if (/\s/.test(character)) {
      if (tokenStarted) {
        tokens.push(token);
        token = "";
        tokenStarted = false;
      }
    } else if (
      character === "\\" &&
      /[\s'"\\]/.test(testScript[index + 1] ?? "")
    ) {
      index += 1;
      token += testScript[index];
      tokenStarted = true;
    } else {
      token += character;
      tokenStarted = true;
    }
  }

  if (quote) {
    throw new Error(
      `Unterminated quote in Jest package test script: ${testScript}`,
    );
  }
  if (tokenStarted) {
    tokens.push(token);
  }
  return tokens;
}

function packageJestArguments(testScript) {
  const tokens = tokenizePackageTestScript(testScript);
  let jestIndex = 0;
  if (tokens[jestIndex]?.toLowerCase() === "yarn") {
    jestIndex += 1;
    if (["exec", "run"].includes(tokens[jestIndex]?.toLowerCase())) {
      jestIndex += 1;
    }
  }

  const command = path.basename(tokens[jestIndex] ?? "").toLowerCase();
  if (!["jest", "jest.cmd", "jest.js"].includes(command)) {
    throw new Error(
      `Coverage collection requires a direct Jest package test script; received: ${testScript}`,
    );
  }

  const args = tokens.slice(jestIndex + 1);
  const shellOperators = new Set(["&", "&&", "|", "||", ";", ">", ">>", "<"]);
  if (args.some((argument) => shellOperators.has(argument))) {
    throw new Error(
      `Coverage collection does not support shell operators in Jest package test scripts: ${testScript}`,
    );
  }
  return args;
}

function normalizedPackageJestArguments(testScript) {
  const args = packageJestArguments(testScript);
  const collectorBooleanOptions = new Set([
    "collectcoverage",
    "coverage",
    "nocoverage",
    "passwithnotests",
    "runinband",
  ]);
  const collectorValueOptions = new Set([
    "config",
    "coveragedirectory",
    "coveragepathignorepatterns",
    "coveragereporters",
    "coveragethreshold",
    "maxworkers",
  ]);
  const normalized = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-w") {
      if (args[index + 1] === undefined) {
        throw new Error(
          `Missing value for Jest -w in package test script: ${testScript}`,
        );
      }
      index += 1;
      continue;
    }
    if (/^-w(?:=)?.+/.test(argument)) {
      continue;
    }
    if (!argument.startsWith("--")) {
      normalized.push(argument);
      continue;
    }

    const equals = argument.indexOf("=");
    const option = (equals === -1 ? argument : argument.slice(0, equals))
      .slice(2)
      .replaceAll("-", "")
      .toLowerCase();
    if (collectorBooleanOptions.has(option)) {
      continue;
    }
    if (!collectorValueOptions.has(option)) {
      normalized.push(argument);
      continue;
    }
    if (equals === -1) {
      if (args[index + 1] === undefined) {
        throw new Error(
          `Missing value for Jest --${option} in package test script: ${testScript}`,
        );
      }
      index += 1;
    }
  }
  return normalized;
}

function packageScriptConfigArgument(testScript) {
  if (typeof testScript !== "string") {
    return undefined;
  }

  const pattern =
    /(?:^|[\s;&|])--config(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  let configArgument;
  for (const match of testScript.matchAll(pattern)) {
    configArgument = match[1] ?? match[2] ?? match[3];
  }
  if (
    configArgument === undefined &&
    /(?:^|[\s;&|])--config(?:$|[\s=])/.test(testScript)
  ) {
    throw new Error(
      `Unable to parse Jest --config from package test script: ${testScript}`,
    );
  }
  return configArgument;
}

function validateLoadedJestConfig(config, description) {
  if (typeof config === "function") {
    throw new Error(
      `Unsupported Jest config export in ${description}: function and async function exports are not supported by coverage collection`,
    );
  }
  if (config && typeof config.then === "function") {
    throw new Error(
      `Unsupported Jest config export in ${description}: Promise and async exports are not supported by coverage collection`,
    );
  }
  if (!isObject(config)) {
    throw new Error(
      `Unsupported Jest config export in ${description}: expected a CJS or JSON object`,
    );
  }
  return config;
}

async function pathIsFile(file) {
  try {
    return (await fs.stat(file)).isFile();
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

let activatedPnpApi;

export async function activateWorkspacePnp(workspaceRoot) {
  const requestedPnpFile = path.join(path.resolve(workspaceRoot), ".pnp.cjs");
  if (!(await pathIsFile(requestedPnpFile))) {
    return null;
  }

  const pnpFile = await fs.realpath(requestedPnpFile);
  const pnpKey = fileSystemKey(pnpFile);
  if (activatedPnpApi) {
    if (activatedPnpApi.key !== pnpKey) {
      throw new Error(
        `Conflicting Yarn PnP roots in coverage collector: already activated ${activatedPnpApi.file}; cannot activate ${pnpFile}`,
      );
    }
    return activatedPnpApi.file;
  }

  try {
    const pnpRequire = createRequire(pathToFileURL(pnpFile));
    const pnpApi = pnpRequire(pnpFile);
    if (!pnpApi || typeof pnpApi.setup !== "function") {
      throw new Error("the module does not export setup()");
    }
    pnpApi.setup();
  } catch (error) {
    throw new Error(
      `Unable to activate Yarn PnP API ${pnpFile}: ${error.message}`,
      { cause: error },
    );
  }

  activatedPnpApi = { file: pnpFile, key: pnpKey };
  return pnpFile;
}

async function loadJestConfigFile(configFile) {
  const extension = path.extname(configFile).toLowerCase();
  if (!SUPPORTED_JEST_CONFIG_EXTENSIONS.has(extension)) {
    throw new Error(
      `Unsupported Jest config format ${configFile}; coverage collection supports CJS .js/.cjs and JSON configs`,
    );
  }

  let config;
  try {
    if (extension === ".json") {
      config = await readJson(configFile);
    } else {
      const configRequire = createRequire(pathToFileURL(configFile));
      config = configRequire(configFile);
    }
  } catch (error) {
    throw new Error(
      `Unable to load Jest config ${configFile}: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  return validateLoadedJestConfig(config, configFile);
}

function configFileExpression(configFile, effectiveConfigDirectory) {
  let relative = path
    .relative(effectiveConfigDirectory, configFile)
    .split(path.sep)
    .join("/");
  if (!relative.startsWith(".")) {
    relative = `./${relative}`;
  }
  return `require(${JSON.stringify(relative)})`;
}

async function resolveWorkspaceJestConfig(workspace) {
  const explicitConfig = packageScriptConfigArgument(workspace.testScript);
  if (explicitConfig !== undefined) {
    if (explicitConfig.trimStart().startsWith("{")) {
      let config;
      try {
        config = JSON.parse(explicitConfig);
      } catch (error) {
        throw new Error(
          `Malformed inline Jest --config in ${workspace.name}: ${error.message}`,
          { cause: error },
        );
      }
      validateLoadedJestConfig(config, `${workspace.name} inline --config`);
      return {
        directory: workspace.directory,
        expression: JSON.stringify(config, null, 2),
        description: `${workspace.name} inline --config`,
      };
    }

    const configFile = path.resolve(workspace.directory, explicitConfig);
    if (!(await pathIsFile(configFile))) {
      throw new Error(
        `Jest config from ${workspace.name} test script does not exist: ${configFile}`,
      );
    }
    await loadJestConfigFile(configFile);
    const directory = path.dirname(configFile);
    return {
      directory,
      expression: configFileExpression(configFile, directory),
      description: configFile,
    };
  }

  const configFiles = [];
  for (const name of JEST_CONFIG_FILES) {
    const candidate = path.join(workspace.directory, name);
    if (await pathIsFile(candidate)) {
      configFiles.push(candidate);
    }
  }

  let packageConfig;
  const packageFile = path.join(workspace.directory, "package.json");
  if (await pathIsFile(packageFile)) {
    const manifest = await readJson(packageFile);
    if (Object.hasOwn(manifest, "jest")) {
      packageConfig = validateLoadedJestConfig(
        manifest.jest,
        `${packageFile}#jest`,
      );
    }
  }

  if (configFiles.length + (packageConfig ? 1 : 0) > 1) {
    const descriptions = [
      ...configFiles,
      ...(packageConfig ? [`${packageFile}#jest`] : []),
    ];
    throw new Error(
      `Ambiguous Jest configuration for ${workspace.name}: ${descriptions.join(", ")}`,
    );
  }

  if (configFiles.length === 1) {
    const configFile = configFiles[0];
    await loadJestConfigFile(configFile);
    const directory = path.dirname(configFile);
    return {
      directory,
      expression: configFileExpression(configFile, directory),
      description: configFile,
    };
  }
  if (packageConfig) {
    return {
      directory: workspace.directory,
      expression: `${configFileExpression(packageFile, workspace.directory)}.jest`,
      description: `${packageFile}#jest`,
    };
  }
  return {
    directory: workspace.directory,
    expression: "{}",
    description: `${workspace.name} default Jest config`,
  };
}

function renderEffectiveJestConfig({ expression, description }) {
  const unsupportedFunction = JSON.stringify(
    `Unsupported Jest config export in ${description}: function and async function exports are not supported by coverage collection`,
  );
  const unsupportedPromise = JSON.stringify(
    `Unsupported Jest config export in ${description}: Promise and async exports are not supported by coverage collection`,
  );
  const unsupportedObject = JSON.stringify(
    `Unsupported Jest config export in ${description}: expected a CJS or JSON object`,
  );
  return [
    '"use strict";',
    "",
    `const original = ${expression};`,
    'if (typeof original === "function") {',
    `  throw new Error(${unsupportedFunction});`,
    "}",
    'if (original && typeof original.then === "function") {',
    `  throw new Error(${unsupportedPromise});`,
    "}",
    'if (!original || typeof original !== "object" || Array.isArray(original)) {',
    `  throw new Error(${unsupportedObject});`,
    "}",
    "",
    "module.exports = { ...original, collectCoverageFrom: [] };",
    "",
  ].join("\n");
}

async function createEffectiveJestConfig(workspace) {
  const resolved = await resolveWorkspaceJestConfig(workspace);
  const configFile = path.join(
    resolved.directory,
    `${EFFECTIVE_JEST_CONFIG_PREFIX}${process.pid}-${randomUUID()}.cjs`,
  );
  await fs.writeFile(configFile, renderEffectiveJestConfig(resolved), {
    encoding: "utf8",
    flag: "wx",
  });
  return configFile;
}

function hasChildExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForCompletion(completion, timeoutMs) {
  let timer;
  const result = await Promise.race([
    completion.then((outcome) => ({ completed: true, outcome })),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ completed: false }), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return result;
}

async function terminateWindowsProcessTree(pid) {
  const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const completion = new Promise((resolve) => {
    killer.once("error", (error) => resolve({ error }));
    killer.once("exit", (code) => resolve({ code }));
  });
  const outcome = await waitForCompletion(
    completion,
    PROCESS_TERMINATION_GRACE_MS,
  );
  if (!outcome.completed) {
    killer.kill("SIGKILL");
    throw new Error(`taskkill did not finish for process ${pid}`);
  }
  if (outcome.outcome.error) {
    throw outcome.outcome.error;
  }
}

async function terminateProcessTree(child, completion) {
  if (!child.pid || hasChildExited(child)) {
    return;
  }

  if (process.platform === "win32") {
    try {
      await terminateWindowsProcessTree(child.pid);
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
    const graceful = await waitForCompletion(
      completion,
      PROCESS_TERMINATION_GRACE_MS,
    );
    if (graceful.completed) {
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }

  const forced = await waitForCompletion(
    completion,
    PROCESS_TERMINATION_GRACE_MS,
  );
  if (!forced.completed && !hasChildExited(child)) {
    throw new Error(`Process tree ${child.pid} did not terminate`);
  }
}

export async function runProcessWithTimeout({
  command,
  args,
  cwd,
  env,
  stdio = "inherit",
  captureOutput = false,
  timeoutMs,
}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Process timeout must be a positive integer");
  }

  const child = spawn(command, args, {
    cwd,
    env,
    stdio: captureOutput ? ["inherit", "pipe", "pipe"] : stdio,
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  if (captureOutput) {
    child.stdout.on("data", (chunk) => {
      stdout.push(chunk.toString("utf8"));
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(chunk.toString("utf8"));
      process.stderr.write(chunk);
    });
  }
  const completion = new Promise((resolve) => {
    child.once("error", (error) => resolve({ type: "error", error }));
    child.once("close", (code, signal) =>
      resolve({ type: "exit", code: code ?? 1, signal }),
    );
  });
  const first = await waitForCompletion(completion, timeoutMs);
  if (first.completed) {
    if (first.outcome.type === "error") {
      throw first.outcome.error;
    }
    return {
      ...first.outcome,
      ...(captureOutput
        ? { stdout: stdout.join(""), stderr: stderr.join("") }
        : {}),
    };
  }

  let terminationError;
  try {
    await terminateProcessTree(child, completion);
  } catch (error) {
    terminationError = error;
  }
  const error = new Error(
    `Process timed out after ${timeoutMs} ms${terminationError ? `; termination error: ${terminationError.message}` : ""}`,
    terminationError ? { cause: terminationError } : undefined,
  );
  error.code = "ERR_COVERAGE_TIMEOUT";
  error.timeoutMs = timeoutMs;
  throw error;
}

function canonicalSourcePath(sourcePath, repoRoot, relativeBase = repoRoot) {
  const nativePath = sourcePath.replaceAll(/[\\/]/g, path.sep);
  const absolute = path.isAbsolute(nativePath)
    ? path.normalize(nativePath)
    : path.resolve(relativeBase, nativePath);
  const relative = path.relative(path.resolve(repoRoot), absolute);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Coverage source is outside the repository: ${sourcePath}`);
  }
  return relative.split(path.sep).join("/");
}

let coverageInstrumenterLibrary;

async function loadCoverageInstrumenterLibrary() {
  coverageInstrumenterLibrary ??= import("istanbul-lib-instrument").then(
    (imported) => imported.default ?? imported,
  );
  return coverageInstrumenterLibrary;
}

export async function createZeroCoverageForSource(source) {
  const { createInstrumenter } = await loadCoverageInstrumenterLibrary();
  const extension = path.extname(source.absolute).toLowerCase();
  const parserPlugins = [...INSTRUMENTATION_PARSER_PLUGINS];
  if (extension === ".ts" || extension === ".tsx") {
    parserPlugins.push("typescript");
  }
  if (extension === ".tsx" || extension === ".jsx") {
    parserPlugins.push("jsx");
  }

  const instrumenter = createInstrumenter({
    autoWrap: true,
    compact: false,
    esModules: true,
    parserPlugins,
    preserveComments: true,
  });
  const contents = await fs.readFile(source.absolute, "utf8");
  try {
    instrumenter.instrumentSync(contents, source.repositoryPath);
  } catch (error) {
    throw new Error(
      `Unable to instrument eligible source ${source.repositoryPath}: ${error.message}`,
      { cause: error },
    );
  }
  const rawCoverage = instrumenter.fileCoverage;
  const coverage = structuredClone(
    typeof rawCoverage.toJSON === "function"
      ? rawCoverage.toJSON()
      : rawCoverage,
  );
  coverage.path = source.repositoryPath;
  validateCoverageReport(
    { [source.repositoryPath]: coverage },
    source.repositoryPath,
  );
  return coverage;
}

async function readRawCoverageReport(
  reportFile,
  { allowMissingRawReport = false } = {},
) {
  let contents;
  try {
    contents = await fs.readFile(reportFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      if (allowMissingRawReport) {
        return {};
      }
      throw new Error(`Missing raw Jest coverage report: ${reportFile}`, {
        cause: error,
      });
    }
    throw new Error(`Missing input: ${reportFile}`, { cause: error });
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Malformed JSON in ${reportFile}: ${error.message}`, {
      cause: error,
    });
  }
}

export async function normalizeWorkspaceReport(
  workspace,
  reportFile,
  repository,
  { allowMissingRawReport = false } = {},
) {
  const rawReport = validateCoverageReport(
    await readRawCoverageReport(reportFile, { allowMissingRawReport }),
    reportFile,
  );
  const expectedByPath = new Map(
    workspace.sourceFiles.map((source) => [
      sourcePathKey(source.repositoryPath),
      source,
    ]),
  );
  const normalizedReport = {};
  const emittedPaths = [];

  for (const coverage of Object.values(rawReport)) {
    const canonical = canonicalSourcePath(
      coverage.path,
      repository,
      workspace.directory,
    );
    const expectedSource = expectedByPath.get(sourcePathKey(canonical));
    if (!expectedSource) {
      continue;
    }
    const source = expectedSource.repositoryPath;
    if (Object.hasOwn(normalizedReport, source)) {
      throw new Error(
        `Duplicate coverage source in ${workspace.name} report: ${source}`,
      );
    }
    const normalized = structuredClone(coverage);
    normalized.path = source;
    normalizedReport[source] = normalized;
    emittedPaths.push(sourcePathKey(source));
  }

  const emitted = new Map(emittedPaths.map((source) => [source, true]));
  const missingSources = workspace.sourceFiles
    .filter(({ repositoryPath }) => !emitted.has(sourcePathKey(repositoryPath)))
    .sort((left, right) =>
      left.repositoryPath.localeCompare(right.repositoryPath),
    );
  if (missingSources.length > 0) {
    for (const source of missingSources) {
      normalizedReport[source.repositoryPath] =
        await createZeroCoverageForSource(source);
    }
    console.log(
      `[coverage] Materialized ${missingSources.length} zero-covered source file(s) for ${workspace.name}.`,
    );
  }
  const expectedSources = workspace.sourceFiles.map(
    ({ repositoryPath }) => repositoryPath,
  );
  validateExactCoverageSources(
    normalizedReport,
    expectedSources,
    `${workspace.name} final coverage map`,
  );

  await writeJson(reportFile, normalizedReport);
  return {
    reportFile,
    sources: expectedSources,
  };
}

export function buildWorkspaceCoverageArgs(
  reportDirectory,
  effectiveConfigFile,
  jestWorkers = DEFAULT_JEST_WORKERS,
  testScript = "jest",
) {
  return [
    "exec",
    "jest",
    ...normalizedPackageJestArguments(testScript),
    "--coverage",
    "--coverageReporters=json",
    `--coverageDirectory=${reportDirectory}`,
    "--coveragePathIgnorePatterns=\\b\\B",
    "--coverageThreshold={}",
    "--passWithNoTests",
    `--maxWorkers=${jestWorkers}`,
    `--config=${effectiveConfigFile}`,
  ];
}

export async function runWorkspaceCoverage(
  workspace,
  outputRoot,
  repository,
  {
    timeoutMs = DEFAULT_WORKSPACE_TIMEOUT_MS,
    jestWorkers = DEFAULT_JEST_WORKERS,
    runProcess = runProcessWithTimeout,
  } = {},
) {
  const reportDirectory = outputDirectoryFor(workspace, outputRoot);
  await fs.rm(reportDirectory, { recursive: true, force: true });
  await fs.mkdir(reportDirectory, { recursive: true });

  console.log(
    `[coverage] ${workspace.name} (${workspace.location}; ${workspace.sourceFiles.length} source files)`,
  );
  let effectiveConfigFile;
  try {
    effectiveConfigFile = await createEffectiveJestConfig(workspace);
    const args = buildWorkspaceCoverageArgs(
      reportDirectory,
      effectiveConfigFile,
      jestWorkers,
      workspace.testScript,
    );
    const yarn = yarnCommand(args);
    const outcome = await runProcess({
      command: yarn.command,
      args: yarn.args,
      cwd: workspace.directory,
      env: { ...process.env, CI: "true" },
      captureOutput: true,
      timeoutMs,
    });

    const output = `${outcome.stdout ?? ""}\n${outcome.stderr ?? ""}`;
    if (output.includes(FAILED_COVERAGE_DIAGNOSTIC)) {
      throw new Error(
        `${workspace.name} coverage emitted fatal Jest diagnostic: ${FAILED_COVERAGE_DIAGNOSTIC}`,
      );
    }

    if (outcome.signal) {
      throw new Error(
        `${workspace.name} coverage was terminated by ${outcome.signal}`,
      );
    }
    if (outcome.code !== 0) {
      throw new Error(
        `${workspace.name} coverage failed with exit code ${outcome.code}`,
      );
    }

    const reportFile = path.join(reportDirectory, COVERAGE_FILE);
    return await normalizeWorkspaceReport(workspace, reportFile, repository, {
      allowMissingRawReport: workspace[SOURCE_ONLY_APPROVAL] === true,
    });
  } catch (error) {
    if (error.code === "ERR_COVERAGE_TIMEOUT") {
      throw new Error(
        `${workspace.name} coverage timed out after ${timeoutMs} ms`,
        { cause: error },
      );
    }
    if (
      error.message.startsWith(`${workspace.name} coverage `) ||
      error.message.startsWith("Unsupported Jest config export") ||
      error.message.startsWith("Unable to load Jest config")
    ) {
      throw error;
    }
    throw new Error(
      `${workspace.name} coverage process failed: ${error.message}`,
      { cause: error },
    );
  } finally {
    if (effectiveConfigFile) {
      await fs.rm(effectiveConfigFile, { force: true });
    }
  }
}

export async function runPool(items, jobs, operation) {
  let next = 0;
  const results = new Array(items.length);
  const failures = [];

  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = await operation(items[index]);
      } catch (error) {
        failures.push({ error, index, item: items[index] });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(jobs, items.length) }, () => worker()),
  );
  if (failures.length > 0) {
    failures.sort((left, right) => left.index - right.index);
    const ledger = failures
      .map(
        ({ error, item }) =>
          `- ${item.name} (${item.location}): ${error.message}`,
      )
      .join("\n");
    console.error(`[coverage] Failure ledger:\n${ledger}`);
    throw new AggregateError(
      failures.map(({ error }) => error),
      `${failures.length} coverage workspace(s) failed:\n${ledger}`,
    );
  }
  return results;
}

export function selectWorkspaces(workspaces, selectors) {
  assertUniqueValues(selectors, "coverage workspace selector");
  if (selectors.length === 0) {
    return workspaces;
  }

  const selected = [];
  for (const selector of selectors) {
    const matches = workspaces.filter(
      (workspace) =>
        workspace.name === selector || workspace.location === selector,
    );
    if (matches.length === 0) {
      throw new Error(`Unknown Jest workspace selector: ${selector}`);
    }
    if (matches.length > 1) {
      throw new Error(`Ambiguous Jest workspace selector: ${selector}`);
    }
    selected.push(matches[0]);
  }
  assertUniqueValues(
    selected.map(({ location }) => location),
    "selected coverage workspace",
  );
  return selected;
}

export async function collectCoverage({
  repoRoot = process.cwd(),
  workspaceRoot,
  output,
  jobs = 2,
  jestWorkers = DEFAULT_JEST_WORKERS,
  timeoutMs = DEFAULT_WORKSPACE_TIMEOUT_MS,
  workspaceSelectors = [],
  expectedWorkspaces,
}) {
  const repository = path.resolve(repoRoot);
  const outputRoot = path.resolve(repository, output);
  if (!isInside(repository, outputRoot)) {
    throw new Error(`Coverage output must be a directory inside ${repository}`);
  }
  if (!Number.isInteger(jobs) || jobs < 1) {
    throw new Error("Coverage jobs must be a positive integer");
  }
  if (!Number.isInteger(jestWorkers) || jestWorkers < 1) {
    throw new Error("Coverage Jest workers must be a positive integer");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Coverage workspace timeout must be a positive integer");
  }

  const workspaceDirectory = path.resolve(repository, workspaceRoot);
  if (!isInside(repository, workspaceDirectory)) {
    throw new Error(`Workspace root must be inside ${repository}`);
  }
  await activateWorkspacePnp(workspaceDirectory);

  const resolved = await resolveCoverageWorkspaces({
    repoRoot: repository,
    workspaceRoot: workspaceDirectory,
    expectedWorkspaces,
  });
  const selected = selectWorkspaces(resolved.workspaces, workspaceSelectors);

  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true });
  const results = await runPool(selected, jobs, (workspace) =>
    runWorkspaceCoverage(workspace, outputRoot, repository, {
      timeoutMs,
      jestWorkers,
    }),
  );
  assertUniqueValues(
    results.map(({ reportFile }) => fileSystemKey(reportFile)),
    "coverage report path",
  );

  const manifest = {
    schemaVersion: 4,
    scope: resolved.scope,
    complete: true,
    inventory: resolved.workspaces.map(
      ({ name, location, slug, emptySourceReason, sourceOnlyReason }) => ({
        name,
        location,
        slug,
        emptySourceReason: emptySourceReason ?? null,
        sourceOnlyReason: sourceOnlyReason ?? null,
      }),
    ),
    selected: selected.map(
      ({ name, location, slug, emptySourceReason, sourceOnlyReason }) => ({
        name,
        location,
        slug,
        emptySourceReason: emptySourceReason ?? null,
        sourceOnlyReason: sourceOnlyReason ?? null,
      }),
    ),
    reports: selected.map((workspace, index) => ({
      workspace: workspace.name,
      location: workspace.location,
      slug: workspace.slug,
      path: path
        .relative(outputRoot, results[index].reportFile)
        .split(path.sep)
        .join("/"),
      sources: results[index].sources,
      emptySourceReason: workspace.emptySourceReason ?? null,
      sourceOnlyReason: workspace.sourceOnlyReason ?? null,
    })),
  };
  await writeJson(path.join(outputRoot, MANIFEST_FILE), manifest);
  console.log(
    `[coverage] Collected ${results.length} distinct ${resolved.scope} report(s).`,
  );
  return manifest;
}

async function findNamedFiles(root, name) {
  const found = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`Missing input: ${directory}`, { cause: error });
      }
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
      } else if (entry.isFile() && entry.name === name) {
        found.push(file);
      }
    }
  }
  await walk(root);
  return found.sort();
}

async function loadCoverageLibrary() {
  const imported = await import("istanbul-lib-coverage");
  return imported.default ?? imported;
}

function normalizedInventoryRecord(workspace) {
  return {
    name: workspace.name,
    location: workspace.location,
    slug: workspace.slug,
    emptySourceReason: workspace.emptySourceReason ?? null,
    sourceOnlyReason: workspace.sourceOnlyReason ?? null,
  };
}

function validateManifestInventory(manifest, expected, manifestFile) {
  if (!Array.isArray(manifest.inventory)) {
    throw new Error(`Malformed coverage inventory in ${manifestFile}`);
  }
  const actual = validateWorkspaceInventory(
    manifest.inventory.map((workspace) => ({
      ...workspace,
      emptySourceReason: workspace.emptySourceReason ?? undefined,
      sourceOnlyReason: workspace.sourceOnlyReason ?? undefined,
    })),
    `${manifest.scope} manifest`,
  );
  const actualRecords = actual.map(normalizedInventoryRecord);
  const expectedRecords = expected.map(normalizedInventoryRecord);
  if (JSON.stringify(actualRecords) !== JSON.stringify(expectedRecords)) {
    throw new Error(`Coverage workspace inventory drift in ${manifestFile}`);
  }
}

async function buildScopeCoverageContract(scope, inventory, repository) {
  const expected = validateWorkspaceInventory(inventory, scope);
  validateReviewedSourceOnlyInventory(expected, scope, {
    requireAllReviewed: inventory === EXPECTED_COVERAGE_WORKSPACES[scope],
  });
  const expectedByLocation = new Map(
    expected.map((workspace) => [workspace.location, workspace]),
  );
  const sourcesByLocation = new Map();
  const scopeDirectory = path.resolve(repository, scope);
  if (!isInside(repository, scopeDirectory)) {
    throw new Error(`Coverage scope must be inside ${repository}: ${scope}`);
  }

  for (const workspace of expected) {
    const workspaceDirectory = path.resolve(scopeDirectory, workspace.location);
    if (!isInside(scopeDirectory, workspaceDirectory)) {
      throw new Error(
        `Coverage workspace must be inside ${scopeDirectory}: ${workspace.location}`,
      );
    }
    const sources = (
      await discoverEligibleSourceFiles(workspaceDirectory, repository)
    ).map(({ repositoryPath }) => repositoryPath);
    if (sources.length === 0 && !workspace.emptySourceReason) {
      throw new Error(
        `${workspace.name} (${scope}/${workspace.location}) has no eligible src/lib JS/TS source`,
      );
    }
    if (sources.length > 0 && workspace.emptySourceReason) {
      throw new Error(
        `${workspace.name} (${scope}/${workspace.location}) has eligible source but is documented as empty`,
      );
    }
    await validateSourceOnlyWorkspaceEvidence(
      workspace,
      scope,
      workspaceDirectory,
    );
    sourcesByLocation.set(workspace.location, sources);
  }

  return { expected, expectedByLocation, sourcesByLocation };
}

function validateSelectedWorkspaces(manifest, contract, manifestFile) {
  if (!Array.isArray(manifest.selected)) {
    throw new Error(`Malformed selected coverage inventory in ${manifestFile}`);
  }
  const selected = validateWorkspaceInventory(
    manifest.selected.map((workspace) => ({
      ...workspace,
      emptySourceReason: workspace.emptySourceReason ?? undefined,
      sourceOnlyReason: workspace.sourceOnlyReason ?? undefined,
    })),
    `${manifest.scope} selected manifest`,
  );

  for (const workspace of selected) {
    const expected = contract.expectedByLocation.get(workspace.location);
    if (!expected) {
      throw new Error(
        `Unexpected coverage workspace ${manifest.scope}/${workspace.location} in ${manifestFile}`,
      );
    }
    if (
      JSON.stringify(normalizedInventoryRecord(workspace)) !==
      JSON.stringify(normalizedInventoryRecord(expected))
    ) {
      throw new Error(
        `Coverage workspace mismatch for ${manifest.scope}/${workspace.location} in ${manifestFile}`,
      );
    }
  }
  return selected;
}

function validateManifestSourceInventory(
  report,
  expectedSources,
  manifestFile,
  repoRoot,
) {
  const actualSources = report.sources.map((source) =>
    canonicalSourcePath(source, repoRoot),
  );
  assertUniqueValues(
    actualSources.map(sourcePathKey),
    `${report.workspace} manifest source path`,
  );
  const expectedByKey = new Map(
    expectedSources.map((source) => [sourcePathKey(source), source]),
  );
  const actualByKey = new Map(
    actualSources.map((source) => [sourcePathKey(source), source]),
  );
  const missing = [...expectedByKey.entries()]
    .filter(([key]) => !actualByKey.has(key))
    .map(([, source]) => source);
  const unexpected = [...actualByKey.entries()]
    .filter(([key]) => !expectedByKey.has(key))
    .map(([, source]) => source);
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Coverage manifest source inventory mismatch for ${report.workspace} in ${manifestFile}; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }
  report.sources = actualSources;
}

function validateManifestReports(
  manifest,
  selected,
  contract,
  manifestFile,
  repoRoot,
) {
  if (!Array.isArray(manifest.reports)) {
    throw new Error(`Malformed coverage reports in ${manifestFile}`);
  }
  if (manifest.reports.length !== selected.length) {
    throw new Error(
      `Incomplete selected coverage manifest ${manifestFile}: expected ${selected.length} reports, received ${manifest.reports.length}`,
    );
  }

  for (const [index, report] of manifest.reports.entries()) {
    if (
      !isObject(report) ||
      typeof report.workspace !== "string" ||
      typeof report.location !== "string" ||
      typeof report.slug !== "string" ||
      typeof report.path !== "string" ||
      !Array.isArray(report.sources) ||
      report.sources.some((source) => typeof source !== "string")
    ) {
      throw new Error(
        `Malformed coverage manifest report ${index} in ${manifestFile}`,
      );
    }
    if (
      report.emptySourceReason !== null &&
      (typeof report.emptySourceReason !== "string" ||
        report.emptySourceReason.trim().length === 0)
    ) {
      throw new Error(`Malformed empty-source reason in ${manifestFile}`);
    }
    if (
      report.sourceOnlyReason !== null &&
      (typeof report.sourceOnlyReason !== "string" ||
        report.sourceOnlyReason.trim().length === 0)
    ) {
      throw new Error(`Malformed source-only reason in ${manifestFile}`);
    }
    if (report.emptySourceReason !== null && report.sourceOnlyReason !== null) {
      throw new Error(
        `Coverage report ${report.workspace} cannot be both empty and source-only in ${manifestFile}`,
      );
    }
    if (report.sources.length === 0 && !report.emptySourceReason) {
      throw new Error(
        `Undocumented empty source workspace ${report.workspace} in ${manifestFile}`,
      );
    }
    if (report.sources.length > 0 && report.emptySourceReason) {
      throw new Error(
        `Workspace ${report.workspace} has sources and an empty-source reason in ${manifestFile}`,
      );
    }
    assertUniqueValues(
      report.sources.map(sourcePathKey),
      `${report.workspace} manifest source path`,
    );
  }

  assertUniqueValues(
    manifest.reports.map(({ workspace }) => workspace),
    `${manifest.scope} report workspace`,
  );
  assertUniqueValues(
    manifest.reports.map(({ location }) => location),
    `${manifest.scope} report location`,
  );
  assertUniqueValues(
    manifest.reports.map(({ slug }) => slug),
    `${manifest.scope} report slug`,
  );
  assertUniqueValues(
    manifest.reports.map(({ path: reportPath }) => reportPath),
    `${manifest.scope} report path`,
  );

  const reportsByLocation = new Map(
    manifest.reports.map((report) => [report.location, report]),
  );
  for (const workspace of selected) {
    const report = reportsByLocation.get(workspace.location);
    if (
      !report ||
      report.workspace !== workspace.name ||
      report.slug !== workspace.slug ||
      report.path !== `${workspace.slug}/${COVERAGE_FILE}` ||
      report.emptySourceReason !== (workspace.emptySourceReason ?? null) ||
      report.sourceOnlyReason !== (workspace.sourceOnlyReason ?? null)
    ) {
      throw new Error(
        `Coverage report inventory drift for ${manifest.scope}/${workspace.location} in ${manifestFile}`,
      );
    }
    validateManifestSourceInventory(
      report,
      contract.sourcesByLocation.get(workspace.location),
      manifestFile,
      repoRoot,
    );
  }
}

async function loadCoverageManifests(
  inputDirectory,
  expectedScopes,
  inventories,
  repository,
) {
  assertUniqueValues(expectedScopes, "expected coverage scope");
  const expectedScopeSet = new Set(expectedScopes);
  const contracts = new Map();
  const manifests = [];
  for (const manifestFile of await findNamedFiles(
    inputDirectory,
    MANIFEST_FILE,
  )) {
    const manifest = await readJson(manifestFile);
    if (
      !isObject(manifest) ||
      manifest.schemaVersion !== 4 ||
      typeof manifest.scope !== "string"
    ) {
      throw new Error(`Malformed coverage manifest: ${manifestFile}`);
    }
    if (manifest.complete !== true) {
      throw new Error(`Incomplete selected coverage manifest: ${manifestFile}`);
    }
    if (expectedScopeSet.size > 0 && !expectedScopeSet.has(manifest.scope)) {
      throw new Error(
        `Coverage manifest scope mismatch in ${manifestFile}: expected ${[...expectedScopeSet].sort().join(", ")}; received ${manifest.scope}`,
      );
    }
    const configuredInventory = inventories[manifest.scope];
    if (!configuredInventory) {
      throw new Error(
        `No expected coverage inventory for scope ${manifest.scope}`,
      );
    }
    let contract = contracts.get(manifest.scope);
    if (!contract) {
      contract = await buildScopeCoverageContract(
        manifest.scope,
        configuredInventory,
        repository,
      );
      contracts.set(manifest.scope, contract);
    }
    validateManifestInventory(manifest, contract.expected, manifestFile);
    const selected = validateSelectedWorkspaces(
      manifest,
      contract,
      manifestFile,
    );
    validateManifestReports(
      manifest,
      selected,
      contract,
      manifestFile,
      repository,
    );
    manifests.push({ manifest, manifestFile, selected });
  }

  if (manifests.length === 0) {
    throw new Error(
      `Missing input: no ${MANIFEST_FILE} files under ${inputDirectory}`,
    );
  }

  const scopes = [...new Set(manifests.map(({ manifest }) => manifest.scope))];
  if (expectedScopes.length > 0) {
    const actual = [...scopes].sort();
    const expected = [...expectedScopes].sort();
    if (
      actual.length !== expected.length ||
      actual.some((scope, index) => scope !== expected[index])
    ) {
      throw new Error(
        `Coverage scopes must be ${expected.join(", ")}; received ${actual.join(", ")}`,
      );
    }
  }

  const selectedOwners = new Map();
  for (const { manifest, manifestFile, selected } of manifests) {
    for (const workspace of selected) {
      const key = `${manifest.scope}\0${workspace.location}`;
      const previous = selectedOwners.get(key);
      if (previous) {
        throw new Error(
          `Duplicate coverage workspace across manifests: ${manifest.scope}/${workspace.location} in ${previous} and ${manifestFile}`,
        );
      }
      selectedOwners.set(key, manifestFile);
    }
  }

  for (const [scope, contract] of contracts) {
    const missing = contract.expected
      .filter(
        (workspace) => !selectedOwners.has(`${scope}\0${workspace.location}`),
      )
      .map(({ location }) => location);
    if (missing.length > 0) {
      throw new Error(
        `Coverage workspace union is incomplete for ${scope}; missing: ${missing.join(", ")}`,
      );
    }
  }

  const sourceOwners = new Map();
  for (const { manifest, manifestFile } of manifests) {
    for (const report of manifest.reports) {
      for (const source of report.sources) {
        const key = sourcePathKey(source);
        const previous = sourceOwners.get(key);
        if (previous) {
          throw new Error(
            `Duplicate eligible coverage source across manifests: ${source} in ${previous} and ${manifestFile}`,
          );
        }
        sourceOwners.set(key, manifestFile);
      }
    }
  }

  return manifests.sort(
    (left, right) =>
      left.manifest.scope.localeCompare(right.manifest.scope) ||
      left.manifestFile.localeCompare(right.manifestFile),
  );
}

function validateReportSources(report, manifestReport, reportFile, repoRoot) {
  const expectedSources = manifestReport.sources.map((source) =>
    canonicalSourcePath(source, repoRoot),
  );
  assertUniqueValues(
    expectedSources.map(sourcePathKey),
    `${manifestReport.workspace} expected report source`,
  );

  const normalized = {};
  const actualSources = [];
  for (const coverage of Object.values(report)) {
    const source = canonicalSourcePath(coverage.path, repoRoot);
    const key = sourcePathKey(source);
    if (actualSources.some((actual) => sourcePathKey(actual) === key)) {
      throw new Error(`Duplicate coverage source in ${reportFile}: ${source}`);
    }
    const value = structuredClone(coverage);
    value.path = source;
    normalized[source] = value;
    actualSources.push(source);
  }

  const expectedKeys = new Map(
    expectedSources.map((source) => [sourcePathKey(source), source]),
  );
  const actualKeys = new Map(
    actualSources.map((source) => [sourcePathKey(source), source]),
  );
  if (expectedSources.length > 0 && actualSources.length === 0) {
    throw new Error(`Empty coverage report for ${manifestReport.workspace}`);
  }
  const missing = [...expectedKeys.entries()]
    .filter(([key]) => !actualKeys.has(key))
    .map(([, source]) => source);
  const unexpected = [...actualKeys.entries()]
    .filter(([key]) => !expectedKeys.has(key))
    .map(([, source]) => source);
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Coverage report source mismatch in ${reportFile}; missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}`,
    );
  }
  return validateExactCoverageSources(normalized, expectedSources, reportFile);
}

export async function mergeCoverageReports({
  input,
  repoRoot = process.cwd(),
  expectedScopes = [],
  inventories = EXPECTED_COVERAGE_WORKSPACES,
}) {
  const repository = path.resolve(repoRoot);
  const inputDirectory = path.resolve(repository, input);
  if (!isInside(repository, inputDirectory)) {
    throw new Error(`Coverage input must be a directory inside ${repository}`);
  }
  const manifests = await loadCoverageManifests(
    inputDirectory,
    expectedScopes,
    inventories,
    repository,
  );
  const listedReports = [];

  for (const { manifest, manifestFile } of manifests) {
    const manifestDirectory = path.dirname(manifestFile);
    for (const manifestReport of manifest.reports) {
      const reportFile = path.resolve(manifestDirectory, manifestReport.path);
      if (!isInside(manifestDirectory, reportFile)) {
        throw new Error(
          `Coverage manifest path escapes its directory: ${manifestReport.path}`,
        );
      }
      listedReports.push({ manifestReport, reportFile });
    }
  }

  assertUniqueValues(
    listedReports.map(({ reportFile }) => fileSystemKey(reportFile)),
    "coverage report path",
  );
  const discoveredReports = await findNamedFiles(inputDirectory, COVERAGE_FILE);
  assertUniqueValues(
    discoveredReports.map(fileSystemKey),
    "discovered coverage report path",
  );
  const listedByPath = new Map(
    listedReports.map((entry) => [fileSystemKey(entry.reportFile), entry]),
  );
  const discoveredByPath = new Map(
    discoveredReports.map((file) => [fileSystemKey(file), file]),
  );
  const missing = [...listedByPath.entries()]
    .filter(([key]) => !discoveredByPath.has(key))
    .map(([, { reportFile }]) => reportFile);
  const unlisted = [...discoveredByPath.entries()]
    .filter(([key]) => !listedByPath.has(key))
    .map(([, file]) => file);
  if (missing.length > 0) {
    throw new Error(`Missing input coverage report(s): ${missing.join(", ")}`);
  }
  if (unlisted.length > 0) {
    throw new Error(`Unlisted coverage report(s): ${unlisted.join(", ")}`);
  }

  const { createCoverageMap } = await loadCoverageLibrary();
  const coverageMap = createCoverageMap({});
  for (const { manifestReport, reportFile } of [...listedReports].sort(
    (left, right) => left.reportFile.localeCompare(right.reportFile),
  )) {
    const report = validateCoverageReport(
      await readJson(reportFile),
      reportFile,
    );
    const normalizedReport = validateReportSources(
      report,
      manifestReport,
      reportFile,
      repository,
    );
    for (const coverage of Object.values(normalizedReport)) {
      coverageMap.addFileCoverage(coverage);
    }
  }

  return {
    coverageMap,
    reportCount: listedReports.length,
    scopes: [
      ...new Set(manifests.map(({ manifest }) => manifest.scope)),
    ].sort(),
  };
}

function percentage(covered, total) {
  if (total === 0) {
    return null;
  }
  return Math.round((covered / total) * 1000) / 10;
}

export function computeCoverageMetrics(coverageMap) {
  const totals = Object.fromEntries(
    METRIC_NAMES.map((name) => [name, { covered: 0, total: 0, pct: null }]),
  );

  for (const source of coverageMap.files()) {
    const summary = coverageMap.fileCoverageFor(source).toSummary().toJSON();
    for (const name of METRIC_NAMES) {
      totals[name].covered += summary[name].covered;
      totals[name].total += summary[name].total;
    }
  }

  for (const name of METRIC_NAMES) {
    totals[name].pct = percentage(totals[name].covered, totals[name].total);
  }
  return totals;
}

export function coverageColor(percent) {
  if (percent === null) return "#9f9f9f";
  if (percent >= 90) return "#4c1";
  if (percent >= 80) return "#97ca00";
  if (percent >= 70) return "#a4a61d";
  if (percent >= 60) return "#dfb317";
  if (percent >= 50) return "#fe7d37";
  return "#e05d44";
}

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function badgeTextWidth(value) {
  return Math.max(34, Math.ceil(Array.from(String(value)).length * 7 + 10));
}

export function renderFlatSquareBadge({ label, value, title, color }) {
  if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color)) {
    throw new Error(`Invalid badge color: ${color}`);
  }
  const labelWidth = badgeTextWidth(label);
  const valueWidth = badgeTextWidth(value);
  const totalWidth = labelWidth + valueWidth;
  const escapedLabel = escapeXml(label);
  const escapedValue = escapeXml(value);
  const escapedTitle = escapeXml(title);

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="20" role="img" aria-label="${escapedTitle}">`,
    `  <title>${escapedTitle}</title>`,
    '  <g shape-rendering="crispEdges">',
    `    <rect width="${labelWidth}" height="20" fill="#555"/>`,
    `    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>`,
    "  </g>",
    '  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">',
    `    <text x="${labelWidth / 2}" y="14">${escapedLabel}</text>`,
    `    <text x="${labelWidth + valueWidth / 2}" y="14">${escapedValue}</text>`,
    "  </g>",
    "</svg>",
    "",
  ].join("\n");
}

function formatCoverageValue(percent) {
  if (percent === null) {
    return "n/a";
  }
  return `${percent.toFixed(1).replace(/\.0$/, "")}%`;
}

export async function generateCoverageReport({
  input,
  output,
  summaryOutput,
  repoRoot = process.cwd(),
  expectedScopes = ["app", "server"],
  inventories = EXPECTED_COVERAGE_WORKSPACES,
}) {
  const merged = await mergeCoverageReports({
    input,
    repoRoot,
    expectedScopes,
    inventories,
  });
  const metrics = computeCoverageMetrics(merged.coverageMap);
  const lineValue = formatCoverageValue(metrics.lines.pct);
  const summary = {
    schemaVersion: 2,
    scope:
      "Normalized Jest-instrumented JS/TS source coverage; excludes non-Jest workspaces and suites.",
    displayedMetric: "lines",
    displayedValue: lineValue,
    sourceScopes: merged.scopes,
    reports: merged.reportCount,
    files: merged.coverageMap.files().length,
    metrics,
  };
  const badge = renderFlatSquareBadge({
    label: "Jest source",
    value: lineValue,
    title: `Normalized Jest-instrumented JS/TS source coverage (lines): ${lineValue}`,
    color: coverageColor(metrics.lines.pct),
  });

  const outputFile = path.resolve(repoRoot, output);
  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, badge, "utf8");
  await writeJson(path.resolve(repoRoot, summaryOutput), summary);
  console.log(
    `[coverage] ${lineValue} lines (${metrics.lines.covered}/${metrics.lines.total}); ` +
      `${merged.reportCount} reports, ${summary.files} canonical files.`,
  );
  return summary;
}

export function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = new Map();
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    const values = options.get(key) ?? [];
    values.push(value);
    options.set(key, values);
    index += 1;
  }
  return { command, options };
}

export function requiredOption(options, name) {
  const values = options.get(name);
  if (!values || values.length !== 1) {
    throw new Error(`Expected exactly one ${name} option`);
  }
  return values[0];
}

export function optionalOption(options, name) {
  const values = options.get(name);
  if (!values) {
    return undefined;
  }
  if (values.length !== 1) {
    throw new Error(`Expected at most one ${name} option`);
  }
  return values[0];
}

export function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv);
  if (command === "collect") {
    const timeoutValue =
      optionalOption(options, "--timeout-ms") ??
      process.env.COVERAGE_WORKSPACE_TIMEOUT_MS ??
      String(DEFAULT_WORKSPACE_TIMEOUT_MS);
    await collectCoverage({
      workspaceRoot: requiredOption(options, "--workspace-root"),
      output: requiredOption(options, "--output"),
      jobs: positiveInteger(
        optionalOption(options, "--jobs") ?? "2",
        "Coverage jobs",
      ),
      jestWorkers: positiveInteger(
        optionalOption(options, "--jest-workers") ??
          String(DEFAULT_JEST_WORKERS),
        "Coverage Jest workers",
      ),
      timeoutMs: positiveInteger(timeoutValue, "Coverage workspace timeout"),
      workspaceSelectors: options.get("--workspace") ?? [],
    });
    return;
  }
  if (command === "report") {
    await generateCoverageReport({
      input: requiredOption(options, "--input"),
      output: requiredOption(options, "--output"),
      summaryOutput: requiredOption(options, "--summary"),
      expectedScopes: options.get("--expect") ?? ["app", "server"],
    });
    return;
  }
  throw new Error("Usage: coverage.mjs <collect|report> [options]");
}

const invokedAsScript =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
