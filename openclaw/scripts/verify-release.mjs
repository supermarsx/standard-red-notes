#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  NODE_RANGE,
  PACKAGE_NAME,
  SMOKE_TARGETS,
  packageArtifactName,
  releaseManifestName,
  targetById,
} from "./release-config.mjs";

const requiredBundleDependencies = Object.freeze([
  "@anthropic-ai/sdk",
  "@modelcontextprotocol/sdk",
  "openai",
  "toml",
  "zod",
]);

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      fail(`expected --name value arguments; received ${argv.join(" ")}`);
    }
    values.set(key.slice(2), value);
  }

  for (const key of ["archive", "checksums", "manifest", "target"]) {
    if (!values.get(key)) {
      fail(`missing required --${key} argument`);
    }
  }

  return Object.fromEntries(values);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(
      [
        `${command} ${args.join(" ")} failed with exit code ${result.status}`,
        result.stdout?.trim(),
        result.stderr?.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout;
}

function assertNodeAndHost(target) {
  if (Number(process.versions.node.split(".")[0]) !== 26) {
    fail(`release smoke tests require Node 26, found ${process.version}`);
  }
  if (
    process.platform !== target.platform ||
    process.arch !== target.architecture
  ) {
    fail(
      `target ${target.id} requires ${target.platform}/${target.architecture}, ` +
        `found ${process.platform}/${process.arch}`,
    );
  }
}

function verifyChecksums(checksumsPath) {
  const baseDirectory = path.dirname(checksumsPath);
  const entries = readFileSync(checksumsPath, "utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = /^([0-9a-f]{64})  ([^/\\][^\r\n]*)$/.exec(line);
      if (!match || match[2].includes("..")) {
        fail(`invalid SHA256SUMS entry: ${line}`);
      }
      return { expected: match[1], file: match[2] };
    });
  if (entries.length !== 2) {
    fail(
      `pre-release SHA256SUMS.txt must contain exactly 2 entries, found ${entries.length}`,
    );
  }

  for (const entry of entries) {
    const file = path.join(baseDirectory, entry.file);
    if (!existsSync(file)) {
      fail(`checksummed release file is missing: ${entry.file}`);
    }
    const actual = sha256(file);
    if (actual !== entry.expected) {
      fail(
        `checksum mismatch for ${entry.file}: expected ${entry.expected}, found ${actual}`,
      );
    }
  }

  return new Map(entries.map((entry) => [entry.file, entry.expected]));
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(entryPath) : [entryPath];
  });
}

// The packaged manifest is written from the workspace manifest, and `yarn
// install` collapses a lone `bin` entry whose key equals the unscoped package
// name to the bare string form, so an installed release can carry either
// spelling of the identical `openclaw` executable. The string form is accepted
// ONLY when the unscoped name is `openclaw`, and the target is still asserted
// below. Same rule as package-release.mjs and
// scripts/validate-release-contract.mjs (cb979521).
function binTarget(packageJson) {
  const bin = packageJson.bin;
  if (typeof bin !== "string") {
    return bin?.openclaw;
  }

  const unscopedName = String(packageJson.name ?? "").replace(/^@[^/]+\//, "");
  return unscopedName === "openclaw" ? bin : undefined;
}

function assertPackageContents(packageRoot, version, releaseManifest) {
  const topLevel = readdirSync(packageRoot).sort();
  const allowedTopLevel = [
    "LICENSE.md",
    "README.md",
    "dist",
    "node_modules",
    "package.json",
    "release-package.json",
  ].sort();
  if (JSON.stringify(topLevel) !== JSON.stringify(allowedTopLevel)) {
    fail(`unexpected installed package contents: ${topLevel.join(", ")}`);
  }

  const packageJson = JSON.parse(
    readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  if (
    packageJson.name !== PACKAGE_NAME ||
    packageJson.version !== version ||
    packageJson.engines?.node !== NODE_RANGE ||
    binTarget(packageJson) !== "dist/index.js"
  ) {
    fail(
      "installed package metadata does not match the OpenClaw release contract",
    );
  }
  if (packageJson.private === true) {
    fail("installed OpenClaw release package must not be private");
  }
  const bundles = [...(packageJson.bundleDependencies ?? [])].sort();
  if (
    JSON.stringify(bundles) !==
    JSON.stringify([...requiredBundleDependencies].sort())
  ) {
    fail(
      "installed package bundleDependencies do not match the runtime dependencies",
    );
  }

  const internalManifest = JSON.parse(
    readFileSync(path.join(packageRoot, "release-package.json"), "utf8"),
  );
  if (
    internalManifest.release?.version !== version ||
    internalManifest.release?.sourceCommit !== releaseManifest.source.commit ||
    internalManifest.distribution?.node !== NODE_RANGE ||
    internalManifest.distribution?.nativeExecutable !== false ||
    internalManifest.distribution?.nativeAddons !== false ||
    internalManifest.distribution?.productionDependenciesBundled !== true
  ) {
    fail(
      "internal release-package.json does not match the external release manifest",
    );
  }

  for (const dependency of requiredBundleDependencies) {
    const dependencyManifest = path.join(
      packageRoot,
      "node_modules",
      ...dependency.split("/"),
      "package.json",
    );
    if (!existsSync(dependencyManifest)) {
      fail(`bundled runtime dependency is missing: ${dependency}`);
    }
  }

  const nativeAddons = walkFiles(path.join(packageRoot, "node_modules")).filter(
    (file) => file.endsWith(".node"),
  );
  if (nativeAddons.length > 0) {
    fail(
      `platform-neutral package contains native addons: ${nativeAddons.join(", ")}`,
    );
  }
  if (!existsSync(path.join(packageRoot, "dist", "index.js"))) {
    fail("installed package is missing dist/index.js");
  }
  const entrypoint = readFileSync(
    path.join(packageRoot, "dist", "index.js"),
    "utf8",
  );
  if (!entrypoint.startsWith("#!/usr/bin/env node\n")) {
    fail("installed dist/index.js is missing its Node shebang");
  }
}

function smokeInstalledPackage(archive, version, releaseManifest) {
  const installRoot = mkdtempSync(path.join(tmpdir(), "srn-openclaw-smoke-"));
  const npmCache = path.join(installRoot, "empty-npm-cache");
  const prefix = path.join(installRoot, "prefix");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  try {
    run(
      npm,
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--offline",
        "--engine-strict",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        npmCache,
        archive,
      ],
      { env: { ...process.env, npm_config_update_notifier: "false" } },
    );

    const npmRoot = run(npm, ["root", "--global", "--prefix", prefix]).trim();
    const packageRoot = path.join(npmRoot, "@standard-red-notes", "openclaw");
    assertPackageContents(packageRoot, version, releaseManifest);
    run(npm, ["ls", "--global", "--prefix", prefix, "--all"]);

    const directHelp = run(process.execPath, [
      path.join(packageRoot, "dist", "index.js"),
      "--help",
    ]);
    if (!directHelp.includes("Open Claw") || !directHelp.includes("Usage:")) {
      fail("direct packaged entrypoint did not print OpenClaw help");
    }

    const shim =
      process.platform === "win32"
        ? path.join(prefix, "openclaw.cmd")
        : path.join(prefix, "bin", "openclaw");
    if (!existsSync(shim)) {
      fail(`npm did not create the OpenClaw executable shim: ${shim}`);
    }
    const shimHelp = run(shim, ["--help"], {
      shell: process.platform === "win32",
    });
    if (!shimHelp.includes("Open Claw") || !shimHelp.includes("Usage:")) {
      fail("installed OpenClaw shim did not print help");
    }
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArguments(process.argv.slice(2));
  const archive = path.resolve(args.archive);
  const checksumsPath = path.resolve(args.checksums);
  const manifestPath = path.resolve(args.manifest);
  const target = targetById(args.target);
  assertNodeAndHost(target);

  const checksums = verifyChecksums(checksumsPath);
  const releaseManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const version = releaseManifest.package?.version;
  if (!version) {
    fail("release manifest is missing package.version");
  }
  const expectedArchiveName = packageArtifactName(version);
  const expectedManifestName = releaseManifestName(version);
  if (
    path.basename(archive) !== expectedArchiveName ||
    path.basename(manifestPath) !== expectedManifestName
  ) {
    fail("release filenames do not match the manifest version");
  }
  if (
    releaseManifest.package?.platform !== "any" ||
    releaseManifest.package?.architecture !== "any" ||
    releaseManifest.package?.nativeExecutable !== false ||
    releaseManifest.package?.nativeAddons !== false ||
    releaseManifest.package?.productionDependenciesBundled !== true
  ) {
    fail(
      "release manifest must describe one platform-neutral, dependency-bundled Node package",
    );
  }
  if (
    JSON.stringify(releaseManifest.validation?.smokeTargets) !==
    JSON.stringify(SMOKE_TARGETS)
  ) {
    fail(
      "release manifest smoke target matrix does not match the release contract",
    );
  }

  const [artifact] = releaseManifest.artifacts ?? [];
  if (
    releaseManifest.artifacts?.length !== 1 ||
    artifact.file !== expectedArchiveName ||
    artifact.sha256 !== sha256(archive) ||
    checksums.get(expectedArchiveName) !== artifact.sha256 ||
    checksums.get(expectedManifestName) !== sha256(manifestPath)
  ) {
    fail(
      "release manifest artifact metadata does not match the package/checksums",
    );
  }

  smokeInstalledPackage(archive, version, releaseManifest);
  process.stdout.write(
    `OpenClaw ${version} package verified on ${target.id} (${process.platform}/${process.arch}).\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `OpenClaw release verification failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
