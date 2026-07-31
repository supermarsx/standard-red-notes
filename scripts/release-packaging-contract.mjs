#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { fingerprintReleaseTree } from "./fingerprint-release-tree.mjs";

const PACKAGING_FINGERPRINT_SCHEMA = "srn-release-packaging-contract-v1";

export const RELEASE_PACKAGING_CONTRACTS = Object.freeze({
  "native-cli": Object.freeze({
    schemaVersion: 1,
    artifactKind: "native-single-file-executable",
    buildRuntime: "node26",
    embeddedRuntime: "node24",
    actions: Object.freeze({
      checkout: "v7",
      downloadArtifact: "v8",
      setupNode: "v7",
      uploadArtifact: "v7",
    }),
    packager: Object.freeze({
      flags: Object.freeze(["--no-signature"]),
      name: "@yao-pkg/pkg",
      version: "6.21.0",
    }),
    products: Object.freeze({
      "srn-home-server": Object.freeze({
        supplementalArtifacts: Object.freeze([
          Object.freeze({
            executable: "zip",
            flags: Object.freeze(["-qr"]),
            format: "zip",
            input: "migrations",
            output: "srn-home-server-migrations.zip",
          }),
        ]),
      }),
    }),
    targets: Object.freeze([
      Object.freeze({ output: "windows-x64.exe", target: "win-x64" }),
      Object.freeze({ output: "windows-arm64.exe", target: "win-arm64" }),
      Object.freeze({ output: "macos-x64", target: "macos-x64" }),
      Object.freeze({ output: "macos-arm64", target: "macos-arm64" }),
      Object.freeze({ output: "linux-x64", target: "linux-x64" }),
      Object.freeze({ output: "linux-arm64", target: "linux-arm64" }),
    ]),
  }),
  desktop: Object.freeze({
    schemaVersion: 1,
    artifactKind: "electron-installers-and-update-metadata",
    actions: Object.freeze({
      checkout: "v7",
      downloadArtifact: "v8",
      release: "v3",
      setupNode: "v7",
      setupPython: "v6",
      uploadArtifact: "v7",
    }),
    builderCommand: "yarn electron-builder",
    builderFixedArguments: Object.freeze([
      "--publish",
      "never",
      "-c.extraMetadata.version=<normalized-release-version>",
    ]),
    corepackVersion: "0.35.0",
    deterministicInputs: Object.freeze([
      "app/package.json",
      "app/yarn.lock",
      "app/.nvmrc",
      "app/.yarnrc.yml",
      "app/.yarn/patches",
      "app/.yarn/releases",
      "app/babel.config.js",
      "app/tsconfig.base.json",
      "app/packages/desktop/package.json",
      "app/packages/desktop/app/package.json",
    ]),
    nodeVersionFile: "app/.nvmrc",
    pythonVersion: "3.14.6",
    signingIdentityAutoDiscovery: false,
    runners: Object.freeze([
      "macos-latest",
      "windows-latest",
      "ubuntu-latest",
      "ubuntu-24.04-arm",
    ]),
    targets: Object.freeze([
      "--mac dmg zip --x64 --arm64",
      "--win nsis --x64 --arm64",
      "--linux AppImage deb --x64",
      "--linux AppImage deb --arm64",
    ]),
    toolchainMetadata: Object.freeze([
      "builderArguments",
      "electronBuilderVersion",
      "electronVersion",
      "nodeVersion",
    ]),
  }),
  mobile: Object.freeze({
    schemaVersion: 1,
    artifactKind: "signed-android-and-ios-apps",
    actions: Object.freeze({
      cache: "v6.1.0",
      checkout: "v7",
      downloadArtifact: "v8",
      release: "v3",
      setupJava: "v5.5.0",
      setupNode: "v7",
      setupRuby: "v1.319.0",
      setupSshAgent: "v0.10.0",
      setupXcode: "v1.7.0",
      uploadArtifact: "v7",
    }),
    androidArchitectures: Object.freeze(["arm64-v8a", "x86_64"]),
    corepackVersion: "0.35.0",
    deterministicInputs: Object.freeze([
      "app/package.json",
      "app/yarn.lock",
      "app/.nvmrc",
      "app/.yarnrc.yml",
      "app/.yarn/patches",
      "app/.yarn/releases",
      "app/babel.config.js",
      "app/tsconfig.base.json",
      "app/packages/mobile/Gemfile",
      "app/packages/mobile/Gemfile.lock",
      "app/packages/mobile/.java-version",
      "app/packages/mobile/.ruby-version",
      "app/packages/mobile/app.json",
      "app/packages/mobile/babel.config.js",
      "app/packages/mobile/metro.config.js",
      "app/packages/mobile/react-native.config.js",
    ]),
    iosArchitectures: Object.freeze(["arm64"]),
    javaDistribution: "zulu",
    javaVersion: "17",
    nodeVersionFile: "app/.nvmrc",
    payloads: Object.freeze([
      "android-release-bundle",
      "ios-release-bundle",
      "embedded-web",
      "native-android-source",
      "native-ios-source",
    ]),
    publicationCommands: Object.freeze([
      "bundle exec fastlane android prod",
      "bundle exec fastlane ios setup",
      "bundle exec fastlane ios prod",
    ]),
    rubyVersion: "3.4.7",
    runners: Object.freeze(["ubuntu-latest", "macos-15"]),
    xcodeVersion: "26",
  }),
  openclaw: Object.freeze({
    schemaVersion: 1,
    artifactKind: "platform-neutral-npm-tarball",
    actions: Object.freeze({
      checkout: "9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      downloadArtifact: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
      setupNode: "820762786026740c76f36085b0efc47a31fe5020",
      uploadArtifact: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    }),
    corepackVersion: "0.35.0",
    nodeVersion: "26.5.0",
    packageManager: "yarn@4.17.1",
    releaseManifestNormalizedFields: Object.freeze([
      "/release/sourceCommit",
      "/release/sourceDate",
      "/release/tag",
      "/release/version",
    ]),
  }),
});

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  throw new TypeError(
    `packaging contract contains unsupported value: ${String(value)}`,
  );
}

function validateMetadata(metadata, requiredNames) {
  if (!isPlainObject(metadata)) {
    throw new TypeError("packaging fingerprint metadata must be an object");
  }
  for (const name of requiredNames ?? []) {
    if (typeof metadata[name] !== "string" || metadata[name].trim() === "") {
      throw new TypeError(`packaging fingerprint requires metadata '${name}'`);
    }
  }
  for (const [name, value] of Object.entries(metadata)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
      throw new TypeError(`invalid packaging metadata name: ${name}`);
    }
    if (typeof value !== "string" || /[\0\r\n]/.test(value)) {
      throw new TypeError(
        `packaging metadata '${name}' must be a single-line string`,
      );
    }
  }
}

export async function fingerprintReleasePackaging({
  contractName,
  contract = RELEASE_PACKAGING_CONTRACTS[contractName],
  metadata = {},
  ...treeOptions
}) {
  if (!contract) {
    throw new TypeError(`unknown release packaging contract: ${contractName}`);
  }
  validateMetadata(metadata, contract.toolchainMetadata);
  const payloadFingerprint = await fingerprintReleaseTree(treeOptions);
  const document = {
    contract,
    contractName,
    metadata,
    payloadFingerprint,
    schema: PACKAGING_FINGERPRINT_SCHEMA,
  };
  return createHash("sha256").update(canonicalJson(document)).digest("hex");
}

function parseArguments(argv) {
  const repeated = new Map([
    ["--exclude", []],
    ["--metadata", []],
    ["--normalize-json-field", []],
    ["--normalize-package-version", []],
    ["--path", []],
  ]);
  const single = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new TypeError(
        `expected --name value arguments; received ${argv.join(" ")}`,
      );
    }
    if (repeated.has(flag)) {
      repeated.get(flag).push(value);
    } else if (single.has(flag)) {
      throw new TypeError(`argument '${flag}' was supplied more than once`);
    } else {
      single.set(flag, value);
    }
  }
  const allowed = new Set([
    "--contract",
    "--github-output",
    "--output",
    "--root",
  ]);
  for (const flag of single.keys()) {
    if (!allowed.has(flag)) {
      throw new TypeError(`unknown argument '${flag}'`);
    }
  }
  const metadata = {};
  for (const specification of repeated.get("--metadata")) {
    const separator = specification.indexOf("=");
    if (separator <= 0) {
      throw new TypeError(`metadata must use <name>=<value>: ${specification}`);
    }
    const name = specification.slice(0, separator);
    if (Object.hasOwn(metadata, name)) {
      throw new TypeError(`metadata '${name}' was supplied more than once`);
    }
    metadata[name] = specification.slice(separator + 1);
  }
  return {
    contractName: single.get("--contract"),
    exclude: repeated.get("--exclude"),
    githubOutput: single.get("--github-output"),
    metadata,
    normalizeJsonField: repeated.get("--normalize-json-field"),
    normalizePackageVersion: repeated.get("--normalize-package-version"),
    output: single.get("--output"),
    paths: repeated.get("--path"),
    root: single.get("--root"),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const fingerprint = await fingerprintReleasePackaging(options);
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
      `Release packaging fingerprint failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
