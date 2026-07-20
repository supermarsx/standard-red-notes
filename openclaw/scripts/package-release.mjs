#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NODE_RANGE,
  PACKAGE_MANAGER,
  PACKAGE_NAME,
  SMOKE_TARGETS,
  SOURCE_REPOSITORY,
  packageArtifactName,
  provenanceBundleName,
  releaseManifestName,
  versionFromReleaseTag,
} from "./release-config.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(toolRoot, "..");
const defaultOutputDirectory = path.join(toolRoot, "out");
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

  const required = ["tag", "source-sha", "source-date-epoch"];
  for (const key of required) {
    if (!values.get(key)) {
      fail(`missing required --${key} argument`);
    }
  }

  return {
    outputDirectory: path.resolve(
      values.get("out-dir") ?? defaultOutputDirectory,
    ),
    sourceDateEpoch: Number(values.get("source-date-epoch")),
    sourceRepository: values.get("source-repository") ?? SOURCE_REPOSITORY,
    sourceSha: values.get("source-sha"),
    tag: values.get("tag"),
  };
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

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sortedJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

// `yarn install` rewrites workspace manifests in place, and openclaw is a root
// workspace: a lone `bin` entry whose key equals the unscoped package name
// collapses to the bare string form, so both spellings reach a release. They
// declare the identical `openclaw` executable. The string form is accepted ONLY
// when the unscoped name is `openclaw` -- otherwise it declares a
// differently-named executable -- and the target itself is still asserted by
// the caller. Same rule as scripts/validate-release-contract.mjs (cb979521), so
// the repository has one definition of a publishable manifest rather than two.
function binTarget(packageJson) {
  const bin = packageJson.bin;
  if (typeof bin !== "string") {
    return bin?.openclaw;
  }

  const unscopedName = String(packageJson.name ?? "").replace(/^@[^/]+\//, "");
  return unscopedName === "openclaw" ? bin : undefined;
}

function assertReleaseInputs(options, packageJson) {
  const version = versionFromReleaseTag(options.tag);
  if (version !== packageJson.version) {
    fail(
      `release tag version ${version} does not match openclaw/package.json version ${packageJson.version}`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(options.sourceSha)) {
    fail("--source-sha must be a full 40-character lowercase commit SHA");
  }
  if (
    !Number.isSafeInteger(options.sourceDateEpoch) ||
    options.sourceDateEpoch <= 0
  ) {
    fail("--source-date-epoch must be a positive Unix timestamp");
  }
  if (new URL(options.sourceRepository).protocol !== "https:") {
    fail("--source-repository must be an HTTPS URL");
  }
  if (Number(process.versions.node.split(".")[0]) !== 26) {
    fail(
      `release packages must be built with Node 26, found ${process.version}`,
    );
  }
  if (packageJson.name !== PACKAGE_NAME) {
    fail(`unexpected package name: ${packageJson.name}`);
  }
  if (packageJson.engines?.node !== NODE_RANGE) {
    fail(`package engines.node must remain ${NODE_RANGE}`);
  }
  if (binTarget(packageJson) !== "dist/index.js") {
    fail("package bin.openclaw must point to dist/index.js");
  }

  const declaredBundles = [...(packageJson.bundleDependencies ?? [])].sort();
  const expectedBundles = [...requiredBundleDependencies].sort();
  if (JSON.stringify(declaredBundles) !== JSON.stringify(expectedBundles)) {
    fail(
      `bundleDependencies must contain exactly: ${expectedBundles.join(", ")}`,
    );
  }

  return version;
}

function assertEmptyOutputDirectory(outputDirectory) {
  for (const protectedPath of [repositoryRoot, toolRoot]) {
    if (outputDirectory === protectedPath) {
      fail(
        `refusing to use protected directory as release output: ${protectedPath}`,
      );
    }
  }

  mkdirSync(outputDirectory, { recursive: true });
  const entries = readdirSync(outputDirectory);
  if (entries.length > 0) {
    fail(`release output directory must be empty: ${outputDirectory}`);
  }
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    } else if (entry.isSymbolicLink() && path.basename(directory) === ".bin") {
      // Package-manager executable shims only: Yarn's node-modules linker
      // creates node_modules/.bin/* as symlinks on Linux, so the release could
      // never be packaged there. They are not payload -- `files` never ships
      // them and npm regenerates them from the manifest on install. The
      // allowance is scoped to `.bin` on purpose: skipping any symlink anywhere
      // would let this walk step over a link to a native addon.
      continue;
    } else {
      fail(
        `release payload contains an unsupported link or special file: ${entryPath}`,
      );
    }
  }
  return files;
}

function assertPlatformNeutralRuntime(nodeModulesDirectory) {
  const nativeMarkers = walkFiles(nodeModulesDirectory).filter((file) =>
    file.endsWith(".node"),
  );
  if (nativeMarkers.length > 0) {
    fail(
      `platform-neutral package cannot contain native addons:\n${nativeMarkers.join("\n")}`,
    );
  }
}

function directDependencyVersions(nodeModulesDirectory) {
  return Object.fromEntries(
    requiredBundleDependencies.map((dependency) => {
      const manifest = JSON.parse(
        readFileSync(
          path.join(
            nodeModulesDirectory,
            ...dependency.split("/"),
            "package.json",
          ),
          "utf8",
        ),
      );
      return [dependency, manifest.version];
    }),
  );
}

function stageProductionPackage(options, packageJson, temporaryProject) {
  const temporaryTool = path.join(temporaryProject, "openclaw");
  const temporaryMcp = path.join(temporaryProject, "mcp");
  mkdirSync(temporaryTool, { recursive: true });
  mkdirSync(temporaryMcp, { recursive: true });
  for (const file of ["package.json", "yarn.lock", ".yarnrc.yml"]) {
    cpSync(path.join(repositoryRoot, file), path.join(temporaryProject, file));
  }
  cpSync(
    path.join(toolRoot, "package.json"),
    path.join(temporaryTool, "package.json"),
  );
  cpSync(
    path.join(repositoryRoot, "mcp", "package.json"),
    path.join(temporaryMcp, "package.json"),
  );

  const corepack = process.platform === "win32" ? "corepack.cmd" : "corepack";
  const yarnVersion = run(corepack, ["yarn", "--version"], {
    cwd: temporaryProject,
  }).trim();
  if (yarnVersion !== PACKAGE_MANAGER.split("@")[1]) {
    fail(`expected ${PACKAGE_MANAGER}, found yarn@${yarnVersion}`);
  }

  run(corepack, ["yarn", "workspaces", "focus", PACKAGE_NAME, "--production"], {
    cwd: temporaryProject,
    env: {
      ...process.env,
      YARN_ENABLE_IMMUTABLE_INSTALLS: "true",
      YARN_ENABLE_SCRIPTS: "false",
      YARN_NM_HOISTING_LIMITS: "workspaces",
    },
  });

  const packageStage = temporaryTool;
  cpSync(path.join(toolRoot, "dist"), path.join(packageStage, "dist"), {
    recursive: true,
  });
  cpSync(
    path.join(toolRoot, "README.md"),
    path.join(packageStage, "README.md"),
  );
  cpSync(
    path.join(repositoryRoot, "license.md"),
    path.join(packageStage, "LICENSE.md"),
  );
  assertPlatformNeutralRuntime(path.join(packageStage, "node_modules"));

  const packagedManifest = structuredClone(packageJson);
  delete packagedManifest.devDependencies;
  packagedManifest.scripts = { start: "node dist/index.js" };
  writeFileSync(
    path.join(packageStage, "package.json"),
    sortedJson(packagedManifest),
  );

  const sourceDate = new Date(options.sourceDateEpoch * 1000).toISOString();
  writeFileSync(
    path.join(packageStage, "release-package.json"),
    sortedJson({
      schemaVersion: 1,
      package: PACKAGE_NAME,
      release: {
        tag: options.tag,
        version: packageJson.version,
        sourceRepository: options.sourceRepository,
        sourceCommit: options.sourceSha,
        sourceDate,
      },
      distribution: {
        format: "npm-package-tarball",
        platform: "any",
        architecture: "any",
        nativeExecutable: false,
        nativeAddons: false,
        entrypoint: "openclaw",
        node: NODE_RANGE,
        productionDependenciesBundled: true,
      },
    }),
  );

  return {
    directDependencies: directDependencyVersions(
      path.join(packageStage, "node_modules"),
    ),
    packageStage,
    sourceDate,
  };
}

function createPackage(options, version, staged) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packOutput = run(
    npm,
    [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      options.outputDirectory,
    ],
    {
      cwd: staged.packageStage,
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_fund: "false",
      },
    },
  );
  const [packResult] = JSON.parse(packOutput);
  if (!packResult?.filename) {
    fail("npm pack did not report a package filename");
  }
  for (const dependency of requiredBundleDependencies) {
    if (!packResult.bundled?.includes(dependency)) {
      fail(`npm pack did not bundle direct runtime dependency ${dependency}`);
    }
  }

  const generatedPackage = path.join(
    options.outputDirectory,
    packResult.filename,
  );
  const artifactName = packageArtifactName(version);
  const artifactPath = path.join(options.outputDirectory, artifactName);
  renameSync(generatedPackage, artifactPath);

  const archive = {
    file: artifactName,
    mediaType: "application/vnd.npm.package+gzip",
    sha256: sha256(artifactPath),
    size: statSync(artifactPath).size,
  };
  const manifestName = releaseManifestName(version);
  const manifestPath = path.join(options.outputDirectory, manifestName);
  writeFileSync(
    manifestPath,
    sortedJson({
      schemaVersion: 1,
      package: {
        name: PACKAGE_NAME,
        version,
        node: NODE_RANGE,
        packageManager: PACKAGE_MANAGER,
        format: "npm-package-tarball",
        platform: "any",
        architecture: "any",
        nativeExecutable: false,
        nativeAddons: false,
        productionDependenciesBundled: true,
        directDependencies: staged.directDependencies,
      },
      source: {
        repository: options.sourceRepository,
        ref: options.tag,
        commit: options.sourceSha,
        date: staged.sourceDate,
      },
      artifacts: [archive],
      validation: {
        installMode: "offline npm global install with an empty cache",
        entrypoints: ["dist/index.js", "openclaw"],
        smokeTargets: SMOKE_TARGETS,
      },
      provenance: {
        format: "Sigstore bundle with SLSA build provenance",
        file: provenanceBundleName(version),
      },
      npmPack: {
        bundled: packResult.bundled ?? [],
        entryCount: packResult.entryCount,
        integrity: packResult.integrity,
        shasum: packResult.shasum,
        unpackedSize: packResult.unpackedSize,
      },
    }),
  );

  const checksumLines = [
    `${archive.sha256}  ${archive.file}`,
    `${sha256(manifestPath)}  ${manifestName}`,
  ];
  writeFileSync(
    path.join(options.outputDirectory, "SHA256SUMS.txt"),
    `${checksumLines.join("\n")}\n`,
  );

  return { artifactName, manifestName };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  const packageJson = JSON.parse(
    readFileSync(path.join(toolRoot, "package.json"), "utf8"),
  );
  const version = assertReleaseInputs(options, packageJson);
  if (!existsSync(path.join(toolRoot, "dist", "index.js"))) {
    fail(
      "built OpenClaw entrypoint is missing; run the build before packaging",
    );
  }
  if (!existsSync(path.join(toolRoot, "README.md"))) {
    fail("openclaw/README.md is required in release packages");
  }
  assertEmptyOutputDirectory(options.outputDirectory);

  const temporaryProject = mkdtempSync(
    path.join(tmpdir(), "srn-openclaw-release-"),
  );
  try {
    const staged = stageProductionPackage(
      options,
      packageJson,
      temporaryProject,
    );
    const result = createPackage(options, version, staged);
    process.stdout.write(
      `Created ${result.artifactName}, ${result.manifestName}, and SHA256SUMS.txt in ${options.outputDirectory}\n`,
    );
  } finally {
    rmSync(temporaryProject, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `OpenClaw release packaging failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
