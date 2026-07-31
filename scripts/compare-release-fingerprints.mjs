#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const COMPARABLE_BASELINE_STATUSES = new Set(["ancestor"]);
const DIVERGENT_BASELINE_STATUSES = new Set([
  "ancestor-with-divergent-tags",
  "ancestor-with-newer-divergent-tags",
]);

export class ReleaseFingerprintComparisonError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReleaseFingerprintComparisonError";
    this.code = code;
  }
}

function parseBoolean(value, flag) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new ReleaseFingerprintComparisonError(
    "invalid-argument",
    `${flag} must be 'true' or 'false'.`,
  );
}

export function normalizeFingerprint(value, label) {
  const fingerprint = String(value ?? "").trim();
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new ReleaseFingerprintComparisonError(
      "malformed-fingerprint",
      `${label} must contain exactly one lowercase SHA-256 fingerprint.`,
    );
  }
  return fingerprint;
}

function normalizeFingerprintAssetName(assetName) {
  if (
    typeof assetName !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(assetName)
  ) {
    throw new ReleaseFingerprintComparisonError(
      "invalid-fingerprint-asset",
      `Invalid fingerprint asset name '${assetName}'.`,
    );
  }
  return assetName;
}

function normalizeFingerprintEntries(entries, label) {
  if (!(entries instanceof Map) || entries.size === 0) {
    throw new ReleaseFingerprintComparisonError(
      "missing-fingerprint-set",
      `${label} fingerprint set is empty.`,
    );
  }
  return new Map(
    [...entries]
      .map(([assetName, fingerprint]) => {
        const normalizedAssetName = normalizeFingerprintAssetName(assetName);
        return [
          normalizedAssetName,
          normalizeFingerprint(
            fingerprint,
            `${label} asset '${normalizedAssetName}'`,
          ),
        ];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function compareFingerprintSets({
  baseRef,
  baselineStatus,
  forced = false,
  currentFingerprints,
  priorFingerprints,
}) {
  const current = normalizeFingerprintEntries(currentFingerprints, "Current");

  if (forced) {
    return {
      schemaVersion: 1,
      decision: "release-forced",
      changed: true,
      blocked: false,
      baseRef: baseRef || null,
      baselineStatus,
      comparedAssets: [...current.keys()],
      changedAssets: [...current.keys()],
      reasonCode: "forced-release",
    };
  }

  if (baselineStatus === "no-ancestor") {
    throw new ReleaseFingerprintComparisonError(
      "no-ancestor-baseline",
      "Version-valid release tags exist, but none is an ancestor of this build. Refusing automatic publication; resolve the history or use an audited force request.",
    );
  }

  if (DIVERGENT_BASELINE_STATUSES.has(baselineStatus)) {
    throw new ReleaseFingerprintComparisonError(
      "divergent-release-history",
      "Version-valid release tags exist outside this build's history. Refusing automatic publication; reconcile the release lines or use an audited force request.",
    );
  }

  if (baselineStatus === "first-release") {
    if (baseRef) {
      throw new ReleaseFingerprintComparisonError(
        "inconsistent-baseline",
        `First-release status cannot carry base ref '${baseRef}'.`,
      );
    }
    return {
      schemaVersion: 1,
      decision: "release-first",
      changed: true,
      blocked: false,
      baseRef: null,
      baselineStatus,
      comparedAssets: [...current.keys()],
      changedAssets: [...current.keys()],
      reasonCode: "first-release",
    };
  }

  if (!COMPARABLE_BASELINE_STATUSES.has(baselineStatus)) {
    throw new ReleaseFingerprintComparisonError(
      "unknown-baseline-status",
      `Unsupported release baseline status '${baselineStatus}'.`,
    );
  }
  if (!baseRef) {
    throw new ReleaseFingerprintComparisonError(
      "missing-baseline-ref",
      `Baseline status '${baselineStatus}' requires an ancestry-validated release ref.`,
    );
  }

  const prior = normalizeFingerprintEntries(priorFingerprints, "Prior");
  const missingAssets = [...current.keys()].filter((name) => !prior.has(name));
  const unexpectedAssets = [...prior.keys()].filter(
    (name) => !current.has(name),
  );
  if (missingAssets.length > 0 || unexpectedAssets.length > 0) {
    throw new ReleaseFingerprintComparisonError(
      "incomplete-prior-fingerprint-set",
      [
        `Release '${baseRef}' does not have the exact expected fingerprint set.`,
        missingAssets.length > 0 ? `Missing: ${missingAssets.join(", ")}.` : "",
        unexpectedAssets.length > 0
          ? `Unexpected: ${unexpectedAssets.join(", ")}.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
  }

  const changedAssets = [...current]
    .filter(([name, fingerprint]) => prior.get(name) !== fingerprint)
    .map(([name]) => name);
  const changed = changedAssets.length > 0;
  return {
    schemaVersion: 1,
    decision: changed ? "release-changed" : "skip-unchanged",
    changed,
    blocked: false,
    baseRef,
    baselineStatus,
    comparedAssets: [...current.keys()],
    changedAssets,
    reasonCode: changed ? "fingerprint-mismatch" : "fingerprint-match",
  };
}

function runGh(args, options = {}) {
  try {
    return execFileSync("gh", args, {
      encoding: options.encoding ?? "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr =
      typeof error?.stderr === "string"
        ? error.stderr.trim()
        : Buffer.isBuffer(error?.stderr)
          ? error.stderr.toString("utf8").trim()
          : "";
    throw new ReleaseFingerprintComparisonError(
      "release-api-unavailable",
      `gh ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
}

export function loadPriorReleaseFingerprints({
  repository,
  baseRef,
  expectedAssets,
  ghRunner = runGh,
}) {
  if (!repository) {
    throw new ReleaseFingerprintComparisonError(
      "missing-repository",
      "A GitHub owner/repository is required for release comparison.",
    );
  }
  const expected = [...expectedAssets]
    .map(normalizeFingerprintAssetName)
    .sort();
  if (new Set(expected).size !== expected.length) {
    throw new ReleaseFingerprintComparisonError(
      "duplicate-fingerprint-asset",
      "The expected release fingerprint set contains duplicate asset names.",
    );
  }
  const rawRelease = ghRunner([
    "release",
    "view",
    baseRef,
    "--repo",
    repository,
    "--json",
    "tagName,isDraft,assets",
  ]);
  let release;
  try {
    release = JSON.parse(String(rawRelease));
  } catch {
    throw new ReleaseFingerprintComparisonError(
      "malformed-release-metadata",
      `GitHub returned malformed metadata for release '${baseRef}'.`,
    );
  }
  if (release.tagName !== baseRef || !Array.isArray(release.assets)) {
    throw new ReleaseFingerprintComparisonError(
      "mismatched-release-metadata",
      `GitHub release metadata did not resolve exact tag '${baseRef}'.`,
    );
  }
  if (typeof release.isDraft !== "boolean") {
    throw new ReleaseFingerprintComparisonError(
      "malformed-release-metadata",
      `GitHub release metadata did not include a draft state for '${baseRef}'.`,
    );
  }
  if (release.isDraft) {
    throw new ReleaseFingerprintComparisonError(
      "draft-release-baseline",
      `GitHub release '${baseRef}' is still a draft and cannot be used as a published fingerprint baseline.`,
    );
  }

  const releaseAssetNames = release.assets.map(({ name }) => name);
  const duplicateAssets = releaseAssetNames.filter(
    (name, index) => releaseAssetNames.indexOf(name) !== index,
  );
  if (duplicateAssets.length > 0) {
    throw new ReleaseFingerprintComparisonError(
      "ambiguous-release-assets",
      `Release '${baseRef}' has duplicate fingerprint asset names: ${[
        ...new Set(duplicateAssets),
      ].join(", ")}.`,
    );
  }
  const missingAssets = expected.filter(
    (assetName) => !releaseAssetNames.includes(assetName),
  );
  if (missingAssets.length > 0) {
    throw new ReleaseFingerprintComparisonError(
      "missing-prior-fingerprint",
      `Release '${baseRef}' is missing required fingerprint assets: ${missingAssets.join(", ")}. Use an audited force request only after verifying the release manually.`,
    );
  }
  const unexpectedFingerprintAssets = releaseAssetNames.filter(
    (assetName) =>
      typeof assetName === "string" &&
      assetName.toLowerCase().endsWith(".fingerprint") &&
      !expected.includes(assetName),
  );
  if (unexpectedFingerprintAssets.length > 0) {
    throw new ReleaseFingerprintComparisonError(
      "unexpected-prior-fingerprint",
      `Release '${baseRef}' has unexpected fingerprint assets: ${unexpectedFingerprintAssets.join(", ")}. Refusing to compare an ambiguous product surface.`,
    );
  }

  const temporaryDirectory = mkdtempSync(
    path.join(os.tmpdir(), "srn-release-fingerprints-"),
  );
  try {
    const fingerprints = new Map();
    for (const assetName of expected) {
      const output = path.join(temporaryDirectory, assetName);
      ghRunner([
        "release",
        "download",
        baseRef,
        "--repo",
        repository,
        "--pattern",
        assetName,
        "--output",
        output,
        "--clobber",
      ]);
      let content;
      try {
        content = readFileSync(output, "utf8");
      } catch {
        throw new ReleaseFingerprintComparisonError(
          "missing-downloaded-fingerprint",
          `GitHub reported fingerprint asset '${assetName}' but did not download it.`,
        );
      }
      fingerprints.set(
        assetName,
        normalizeFingerprint(content, `Prior asset '${assetName}'`),
      );
    }
    return fingerprints;
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function compareWithPriorRelease({
  repository,
  baseRef,
  baselineStatus,
  forced = false,
  currentFingerprints,
  ghRunner,
}) {
  const current = normalizeFingerprintEntries(currentFingerprints, "Current");
  if (forced || baselineStatus === "first-release") {
    return compareFingerprintSets({
      baseRef,
      baselineStatus,
      forced,
      currentFingerprints: current,
    });
  }
  if (baselineStatus === "no-ancestor") {
    return compareFingerprintSets({
      baseRef,
      baselineStatus,
      forced,
      currentFingerprints: current,
    });
  }
  if (!COMPARABLE_BASELINE_STATUSES.has(baselineStatus) || !baseRef) {
    return compareFingerprintSets({
      baseRef,
      baselineStatus,
      forced,
      currentFingerprints: current,
    });
  }
  const priorFingerprints = loadPriorReleaseFingerprints({
    repository,
    baseRef,
    expectedAssets: current.keys(),
    ghRunner,
  });
  return compareFingerprintSets({
    baseRef,
    baselineStatus,
    forced,
    currentFingerprints: current,
    priorFingerprints,
  });
}

function usage() {
  return [
    "Usage:",
    "  node scripts/compare-release-fingerprints.mjs \\",
    "    --repository <owner/repo> --base-ref <tag-or-empty> \\",
    "    --baseline-status <status> --forced <true|false> \\",
    "    --fingerprint <asset-name=sha256> [--fingerprint ...] \\",
    "    --output <json-file> --github-output <output-file>",
  ].join("\n");
}

function parseArguments(argv) {
  const singletonArguments = new Set([
    "--base-ref",
    "--baseline-status",
    "--forced",
    "--github-output",
    "--output",
    "--repository",
  ]);
  const values = new Map();
  const fingerprints = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--fingerprint") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ReleaseFingerprintComparisonError(
          "invalid-argument",
          "Missing value for '--fingerprint'.",
        );
      }
      fingerprints.push(value);
      index += 1;
      continue;
    }
    if (!singletonArguments.has(argument)) {
      throw new ReleaseFingerprintComparisonError(
        "invalid-argument",
        `Unknown argument '${argument}'.\n${usage()}`,
      );
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ReleaseFingerprintComparisonError(
        "invalid-argument",
        `Missing value for '${argument}'.`,
      );
    }
    if (values.has(argument)) {
      throw new ReleaseFingerprintComparisonError(
        "invalid-argument",
        `Argument '${argument}' was supplied more than once.`,
      );
    }
    values.set(argument, value);
    index += 1;
  }
  return { values, fingerprints };
}

function fingerprintMap(specifications) {
  const entries = new Map();
  for (const specification of specifications) {
    const separator = specification.indexOf("=");
    if (separator <= 0) {
      throw new ReleaseFingerprintComparisonError(
        "invalid-argument",
        `Fingerprint '${specification}' must use asset-name=sha256.`,
      );
    }
    const name = specification.slice(0, separator);
    const value = specification.slice(separator + 1);
    if (entries.has(name)) {
      throw new ReleaseFingerprintComparisonError(
        "duplicate-fingerprint-asset",
        `Fingerprint asset '${name}' was supplied more than once.`,
      );
    }
    entries.set(name, value);
  }
  return entries;
}

function appendGithubOutputs(file, result) {
  appendFileSync(
    file,
    [
      `changed=${String(result.changed)}`,
      `blocked=${String(result.blocked)}`,
      `decision=${result.decision}`,
      `reason_code=${result.reasonCode}`,
      `result_json=${JSON.stringify(result)}`,
      "",
    ].join("\n"),
  );
}

export function runCli(argv = process.argv.slice(2)) {
  const { values, fingerprints } = parseArguments(argv);
  const required = [
    "--repository",
    "--base-ref",
    "--baseline-status",
    "--forced",
    "--output",
    "--github-output",
  ];
  for (const argument of required) {
    if (!values.has(argument)) {
      throw new ReleaseFingerprintComparisonError(
        "invalid-argument",
        `Missing required argument '${argument}'.\n${usage()}`,
      );
    }
  }
  const outputFile = values.get("--output");
  const githubOutput = values.get("--github-output");
  const comparedAssets = fingerprints
    .map((specification) => specification.slice(0, specification.indexOf("=")))
    .filter(Boolean)
    .sort();
  try {
    const result = compareWithPriorRelease({
      repository: values.get("--repository"),
      baseRef: values.get("--base-ref"),
      baselineStatus: values.get("--baseline-status"),
      forced: parseBoolean(values.get("--forced"), "--forced"),
      currentFingerprints: fingerprintMap(fingerprints),
    });
    writeFileSync(outputFile, `${JSON.stringify(result, null, 2)}\n`);
    appendGithubOutputs(githubOutput, result);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    const blocked = {
      schemaVersion: 1,
      decision: "blocked",
      changed: false,
      blocked: true,
      baseRef: values.get("--base-ref") || null,
      baselineStatus: values.get("--baseline-status"),
      comparedAssets,
      changedAssets: [],
      reasonCode:
        error instanceof ReleaseFingerprintComparisonError
          ? error.code
          : "unexpected-error",
      message: error instanceof Error ? error.message : String(error),
    };
    writeFileSync(outputFile, `${JSON.stringify(blocked, null, 2)}\n`);
    appendGithubOutputs(githubOutput, blocked);
    throw error;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";

if (invokedPath === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(
      `Release fingerprint comparison blocked: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  }
}
