#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverReleaseTargetSurface } from "./analyze-release-impact.mjs";
import { RELEASE_PACKAGING_CONTRACTS } from "./release-packaging-contract.mjs";
import {
  approvedWorkflowAction,
  validateMcpReleaseDependencyContract,
  validateImmutableWorkflowActions,
} from "./validate-ci-contract.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const RELEASE_POLICY_INSTALL_COMMAND =
  "npm ci --prefix scripts --ignore-scripts --no-audit --no-fund";

export const RELEASE_CONTRACT_FILES = Object.freeze([
  ".github/workflows/ci.yml",
  ".github/workflows/docs-pages.yml",
  ".github/workflows/srn-client.yml",
  ".github/workflows/srn-server.yml",
  ".github/workflows/srn-mcp.yml",
  ".github/workflows/srn-home-server.yml",
  ".github/workflows/srn-admin.yml",
  ".github/workflows/srn-openclaw.yml",
  ".github/workflows/srn-desktop.yml",
  ".github/workflows/srn-mobile.yml",
  ".github/workflows/release-contract.yml",
  "app/.github/workflows/desktop.release.prod.yml",
  "app/.github/workflows/desktop.release.reuse.yml",
  "app/.github/workflows/mobile.release.prod.yml",
  "app/packages/desktop/package.json",
  "app/packages/desktop/build/entitlements.mac.inherit.plist",
  "app/packages/desktop/scripts/notarizeMac.js",
  "app/packages/desktop/scripts/pruneLinuxNativePrebuilds.js",
  "app/packages/desktop/scripts/pruneLinuxNativePrebuilds.test.js",
  "app/packages/desktop/scripts/windowsSign.js",
  "app/.github/upstream-workflows-disabled/clipper.release.prod.yml",
  "app/.github/upstream-workflows-disabled/git-sync.yml",
  "app/.github/upstream-workflows-disabled/ios.testflight.yml",
  "app/.github/upstream-workflows-disabled/publish.yml",
  "app/.github/upstream-workflows-disabled/releases.notify.yml",
  "app/.github/upstream-workflows-disabled/web.release.prod.yml",
  "app/.github/upstream-workflows-disabled/README.md",
  "app/packages/mobile/android/gradle.properties",
  "app/packages/mobile/fastlane/Appfile",
  "app/packages/mobile/fastlane/Fastfile",
  "app/packages/mobile/fastlane/README.md",
  "app/scripts/verify-desktop-updater-metadata.rb",
  "app/scripts/verify-desktop-updater-metadata.test.rb",
  "cli/srn-client/src/index.ts",
  "cli/srn-server/src/index.ts",
  "docs/ci-production-gates.md",
  "docs/releases-and-upgrades.md",
  "openclaw/package.json",
  "openclaw/scripts/package-release.mjs",
  "openclaw/scripts/release-config.mjs",
  "openclaw/scripts/verify-release.mjs",
  "package.json",
  "mcp/src/index.ts",
  "scripts/analyze-release-impact.mjs",
  "scripts/analyze-release-impact.test.mjs",
  "scripts/compare-release-fingerprints.mjs",
  "scripts/compare-release-fingerprints.test.mjs",
  "scripts/fingerprint-release-tree.mjs",
  "scripts/fingerprint-release-tree.test.mjs",
  "scripts/native-cli-release.mjs",
  "scripts/package.json",
  "scripts/package-lock.json",
  "scripts/release-packaging-contract.mjs",
  "scripts/release-packaging-contract.test.mjs",
  "server/packages/auth/bin/srn_admin.ts",
  "server/packages/home-server/bin/server.ts",
  "server/.github/upstream-workflows-disabled/analytics.yml",
  "server/.github/upstream-workflows-disabled/api-gateway.yml",
  "server/.github/upstream-workflows-disabled/auth.yml",
  "server/.github/upstream-workflows-disabled/common-deploy.yml",
  "server/.github/upstream-workflows-disabled/common-docker-image.yml",
  "server/.github/upstream-workflows-disabled/common-self-hosting.yml",
  "server/.github/upstream-workflows-disabled/common-server-application.yml",
  "server/.github/upstream-workflows-disabled/files.yml",
  "server/.github/upstream-workflows-disabled/publish.yml",
  "server/.github/upstream-workflows-disabled/revisions.yml",
  "server/.github/upstream-workflows-disabled/scheduler.yml",
  "server/.github/upstream-workflows-disabled/syncing-server.yml",
  "server/.github/upstream-workflows-disabled/websockets.yml",
  "server/.github/upstream-workflows-disabled/README.md",
]);

const TOOL_WORKFLOWS = Object.freeze([
  ".github/workflows/srn-client.yml",
  ".github/workflows/srn-server.yml",
  ".github/workflows/srn-mcp.yml",
  ".github/workflows/srn-home-server.yml",
  ".github/workflows/srn-admin.yml",
]);

const NATIVE_CLI_CONTRACT = RELEASE_PACKAGING_CONTRACTS["native-cli"];
const NATIVE_ACTION_OWNERS = Object.freeze({
  checkout: "actions/checkout",
  downloadArtifact: "actions/download-artifact",
  setupNode: "actions/setup-node",
  uploadArtifact: "actions/upload-artifact",
});
const DESKTOP_ACTION_OWNERS = Object.freeze({
  cache: "actions/cache",
  checkout: "actions/checkout",
  downloadArtifact: "actions/download-artifact",
  setupLxd: "canonical/setup-lxd",
  setupNode: "actions/setup-node",
  setupPython: "actions/setup-python",
  uploadArtifact: "actions/upload-artifact",
});
const RELEASE_POLICY_ACTION_OWNERS = Object.freeze({
  checkout: "actions/checkout",
  setupNode: "actions/setup-node",
  uploadArtifact: "actions/upload-artifact",
});
const RELEASE_POLICY_ACTIONS = Object.freeze({
  checkout: "3d3c42e5aac5ba805825da76410c181273ba90b1",
  setupNode: "820762786026740c76f36085b0efc47a31fe5020",
  uploadArtifact: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
});
const RELEASE_POLICY_ACTION_VERSIONS = Object.freeze({
  checkout: "v7.0.1",
  setupNode: "v7.0.0",
  uploadArtifact: "v7.0.1",
});
const OPENCLAW_ACTION_OWNERS = Object.freeze({
  attestBuildProvenance: "actions/attest-build-provenance",
  checkout: "actions/checkout",
  downloadArtifact: "actions/download-artifact",
  setupNode: "actions/setup-node",
  uploadArtifact: "actions/upload-artifact",
});
const MOBILE_ACTION_OWNERS = Object.freeze({
  cache: "actions/cache",
  checkout: "actions/checkout",
  downloadArtifact: "actions/download-artifact",
  setupJava: "actions/setup-java",
  setupNode: "actions/setup-node",
  setupRuby: "ruby/setup-ruby",
  setupXcode: "maxim-lobanov/setup-xcode",
  uploadArtifact: "actions/upload-artifact",
});
const TOOL_TARGETS = Object.freeze(
  [
    ["windows-x64.exe", "win-x64"],
    ["windows-arm64.exe", "win-arm64"],
    ["macos-x64", "macos-x64"],
    ["macos-arm64", "macos-arm64"],
    ["linux-x64", "linux-x64"],
    ["linux-arm64", "linux-arm64"],
  ].map((target) => Object.freeze(target)),
);

const OPENCLAW_SMOKE_TARGETS = Object.freeze([
  ["windows-x64", "windows-2025", "x64"],
  ["windows-arm64", "windows-11-arm", "arm64"],
  ["linux-x64", "ubuntu-24.04", "x64"],
  ["linux-arm64", "ubuntu-24.04-arm", "arm64"],
  ["macos-x64", "macos-15-intel", "x64"],
  ["macos-arm64", "macos-15", "arm64"],
]);

const SELECTIVE_RELEASE_WORKFLOWS = Object.freeze([
  [".github/workflows/srn-admin.yml", "srn-admin", "build"],
  [".github/workflows/srn-client.yml", "srn-client", "lint"],
  [".github/workflows/srn-desktop.yml", "srn-desktop", "identity"],
  [".github/workflows/srn-home-server.yml", "srn-home-server", "build"],
  [".github/workflows/srn-mcp.yml", "srn-mcp", "lint"],
  [".github/workflows/srn-mobile.yml", "srn-mobile", "version"],
  [".github/workflows/srn-openclaw.yml", "srn-openclaw", "context"],
  [".github/workflows/srn-server.yml", "srn-server", "lint"],
]);

const SHARED_RELEASE_GATING_PATHS = Object.freeze([
  "scripts/analyze-release-impact.mjs",
  "scripts/analyze-release-impact.test.mjs",
  "scripts/compare-release-fingerprints.mjs",
  "scripts/compare-release-fingerprints.test.mjs",
  "scripts/fingerprint-release-tree.mjs",
  "scripts/fingerprint-release-tree.test.mjs",
  "scripts/validate-release-contract.mjs",
  "scripts/validate-release-contract.test.mjs",
]);

const APP_EMBEDDED_WORKFLOWS = Object.freeze([
  "app/.github/workflows/codeql-analysis.yml",
  "app/.github/workflows/desktop.release.prod.yml",
  "app/.github/workflows/desktop.release.reuse.yml",
  "app/.github/workflows/mobile.release.prod.yml",
  "app/.github/workflows/pr.yml",
  "app/.github/workflows/snjs.pr.yml",
  "app/.github/workflows/snjs.upgrade.event.yml",
]);
const APP_QUARANTINED_WORKFLOWS = Object.freeze([
  "app/.github/upstream-workflows-disabled/clipper.release.prod.yml",
  "app/.github/upstream-workflows-disabled/git-sync.yml",
  "app/.github/upstream-workflows-disabled/ios.testflight.yml",
  "app/.github/upstream-workflows-disabled/publish.yml",
  "app/.github/upstream-workflows-disabled/releases.notify.yml",
  "app/.github/upstream-workflows-disabled/web.release.prod.yml",
]);
const SERVER_EMBEDDED_WORKFLOWS = Object.freeze([
  "server/.github/workflows/common-e2e.yml",
  "server/.github/workflows/e2e-home-server.yml",
  "server/.github/workflows/e2e-self-hosted.yml",
  "server/.github/workflows/e2e-test-suite.yml",
  "server/.github/workflows/pr.yml",
]);
const SERVER_QUARANTINED_WORKFLOWS = Object.freeze([
  "server/.github/upstream-workflows-disabled/analytics.yml",
  "server/.github/upstream-workflows-disabled/api-gateway.yml",
  "server/.github/upstream-workflows-disabled/auth.yml",
  "server/.github/upstream-workflows-disabled/common-deploy.yml",
  "server/.github/upstream-workflows-disabled/common-docker-image.yml",
  "server/.github/upstream-workflows-disabled/common-self-hosting.yml",
  "server/.github/upstream-workflows-disabled/common-server-application.yml",
  "server/.github/upstream-workflows-disabled/files.yml",
  "server/.github/upstream-workflows-disabled/publish.yml",
  "server/.github/upstream-workflows-disabled/revisions.yml",
  "server/.github/upstream-workflows-disabled/scheduler.yml",
  "server/.github/upstream-workflows-disabled/syncing-server.yml",
  "server/.github/upstream-workflows-disabled/websockets.yml",
]);

const REPOSITORY_TEXT_SCAN_EXTENSIONS = new Set([".md", ".yaml", ".yml"]);
const REPOSITORY_TEXT_SCAN_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".yarn",
  "Pods",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

function repositoryDocumentationAndWorkflowFiles(repositoryRoot) {
  const files = [];
  const walk = (directory, relativeDirectory = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        REPOSITORY_TEXT_SCAN_IGNORED_DIRECTORIES.has(entry.name)
      ) {
        continue;
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
      } else if (
        entry.isFile() &&
        REPOSITORY_TEXT_SCAN_EXTENSIONS.has(path.extname(entry.name))
      ) {
        files.push(relativePath);
      }
    }
  };
  walk(repositoryRoot);
  return files;
}

function countOccurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

function normalizeWorkflowYamlScalars(source) {
  let blockScalarIndent;
  return source
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => {
      const indentation = /^[ \t]*/.exec(line)?.[0].length ?? 0;
      if (blockScalarIndent !== undefined) {
        if (line.trim() === "" || indentation > blockScalarIndent) {
          return line;
        }
        blockScalarIndent = undefined;
      }

      const blockScalar =
        /^([ \t]*)(?:-\s*)?[A-Za-z0-9_.-]+:\s*[|>][+-]?\s*(?:#.*)?$/.exec(line);
      if (blockScalar) {
        blockScalarIndent = blockScalar[1].length;
        return line;
      }

      for (const pattern of [
        /^(\s*-\s*)(["'])(.*)\2(\s*(?:#.*)?)$/,
        /^(\s*(?:-\s*)?[A-Za-z0-9_.-]+:\s*)(["'])(.*)\2(\s*,?\s*(?:#.*)?)$/,
      ]) {
        const scalar = pattern.exec(line);
        if (scalar) {
          return `${scalar[1]}${scalar[3]}${scalar[4]}`;
        }
      }
      return line;
    })
    .join("\n");
}

function requireExactWorkflowInventory(
  errors,
  files,
  prefix,
  expected,
  description,
) {
  const actual = [...files.keys()]
    .filter((file) => file.startsWith(prefix) && /\.(?:yaml|yml)$/.test(file))
    .sort();
  const planned = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(planned)) {
    const missing = planned.filter((file) => !actual.includes(file));
    const unknown = actual.filter((file) => !planned.includes(file));
    errors.push(
      `${description} must match the classified inventory; missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"}`,
    );
  }
}

function requireFragment(errors, file, text, fragment, description) {
  if (fragment instanceof RegExp) {
    if (!fragment.test(text)) {
      errors.push(`${file}: missing ${description}`);
    }
    return;
  }
  if (text.includes(fragment)) {
    return;
  }
  if (
    /\.ya?ml$/.test(file) &&
    normalizeWorkflowYamlScalars(text).includes(
      normalizeWorkflowYamlScalars(fragment),
    )
  ) {
    return;
  }
  errors.push(`${file}: missing ${description}`);
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    return "";
  }
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end < 0 ? source.slice(start) : source.slice(start, end);
}

function validateImmutableActionAllowlist(
  errors,
  {
    actionOwners,
    actions,
    actionVersions,
    allowedLocalActions = new Set(),
    file,
    workflow,
  },
) {
  const actionNamesByOwner = new Map(
    Object.entries(actionOwners).map(([name, owner]) => [owner, name]),
  );
  let actionReferenceCount = 0;

  for (const line of workflow
    .split(/\r?\n/)
    .filter((candidate) => !candidate.trimStart().startsWith("#"))) {
    const uses = /^\s*(?:-\s*)?uses:\s+(\S+)/.exec(line)?.[1];
    if (!uses) {
      continue;
    }
    actionReferenceCount += 1;

    if (uses.startsWith("./")) {
      if (!allowedLocalActions.has(uses)) {
        errors.push(
          `${file}: unexpected local action outside contract ${uses}`,
        );
      }
      continue;
    }

    const external = /^([^\s@]+)@([^\s#]+)$/.exec(uses);
    if (!external) {
      errors.push(`${file}: unsupported action reference ${uses}`);
      continue;
    }
    const [, owner, reference] = external;
    if (!/^[0-9a-f]{40}$/.test(reference)) {
      errors.push(
        `${file}: mutable external action reference ${owner}@${reference}`,
      );
      continue;
    }

    const actionName = actionNamesByOwner.get(owner);
    if (!actionName || actions[actionName] !== reference) {
      errors.push(
        `${file}: unexpected external action outside contract ${owner}@${reference}`,
      );
      continue;
    }

    const expectedVersion = actionVersions[actionName];
    const actualVersion = /#\s*(\S+)\s*$/.exec(line)?.[1];
    if (actualVersion !== expectedVersion) {
      errors.push(
        `${file}: incorrect human version label for ${owner}@${reference}; expected ${expectedVersion}`,
      );
    }
  }

  if (actionReferenceCount === 0) {
    errors.push(`${file}: expected immutable action references`);
  }
}

function jobBlock(workflow, jobName) {
  const marker = `\n  ${jobName}:`;
  const start = workflow.indexOf(marker);
  if (start < 0) {
    return "";
  }

  const contentStart = start + marker.length;
  const remainder = workflow.slice(contentStart);
  const nextJob = remainder.search(/\r?\n  [A-Za-z0-9_-]+:\r?\n/);
  return nextJob < 0 ? remainder : remainder.slice(0, nextJob);
}

function workflowJobNames(workflow) {
  const marker = "\njobs:\n";
  const start = workflow.replaceAll("\r\n", "\n").indexOf(marker);
  if (start < 0) {
    return [];
  }
  return [
    ...workflow
      .replaceAll("\r\n", "\n")
      .slice(start + marker.length)
      .matchAll(/^  ([A-Za-z0-9_-]+):$/gm),
  ].map((match) => match[1]);
}

function requireExactJobSet(errors, file, workflow, expected) {
  const actual = workflowJobNames(workflow);
  if (
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
  ) {
    const missing = expected.filter((job) => !actual.includes(job));
    const unexpected = actual.filter((job) => !expected.includes(job));
    errors.push(
      `${file}: job set must exactly match the release contract; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
    );
  }
}

function actionSequence(block) {
  return [
    ...block.matchAll(/^\s*(?:-\s+)?uses:\s*([^\s#]+)(?:\s+#.*)?$/gm),
  ].map((match) => match[1]);
}

function requireExactJobActionSequence(
  errors,
  file,
  workflow,
  jobName,
  expected,
) {
  const job = jobBlock(workflow, jobName);
  if (!job) {
    errors.push(`${file}: missing ${jobName} job for exact action inventory`);
    return;
  }
  const actual = actionSequence(job);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(
      `${file}: ${jobName} action sequence must be exactly ${expected.join(" -> ") || "empty"}; found ${actual.join(" -> ") || "empty"}`,
    );
  }
}

function jobDependencies(block) {
  const match = /^[ \t]{4}needs:[ \t]*(.*)$/m.exec(block);
  if (!match) {
    return [];
  }
  let source = match[1].trim();
  if (source === "") {
    const remainder = block.slice((match.index ?? 0) + match[0].length);
    const lines = [];
    for (const line of remainder.split(/\r?\n/)) {
      if (/^[ \t]{4}[A-Za-z0-9_-]+:/.test(line)) {
        break;
      }
      lines.push(line);
    }
    source = lines.join(" ");
  }
  return source
    .replace(/[\[\],]/g, " ")
    .split(/\s+/)
    .map((dependency) => dependency.replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}

function requireExactJobDependencies(
  errors,
  file,
  workflow,
  jobName,
  expected,
) {
  const job = jobBlock(workflow, jobName);
  if (!job) {
    errors.push(`${file}: missing ${jobName} job for exact dependency graph`);
    return;
  }
  const actual = jobDependencies(job);
  if (
    JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())
  ) {
    errors.push(
      `${file}: ${jobName} dependencies must be exactly ${expected.join(", ") || "empty"}; found ${actual.join(", ") || "empty"}`,
    );
  }
}

function artifactUploadPaths(job, artifactName) {
  const marker = `\n          name: ${artifactName}`;
  const nameIndex = job.indexOf(marker);
  if (nameIndex < 0) {
    return [];
  }
  const pathMatch = /\n          path:\s*([^\r\n]*)/.exec(job.slice(nameIndex));
  if (!pathMatch) {
    return [];
  }
  if (pathMatch[1].trim() !== "|") {
    return [pathMatch[1].trim()];
  }
  const remainder = job.slice(
    nameIndex + (pathMatch.index ?? 0) + pathMatch[0].length,
  );
  const paths = [];
  for (const line of remainder.replace(/^\r?\n/, "").split(/\r?\n/)) {
    const item = /^\s{12}(\S.*)$/.exec(line)?.[1];
    if (!item) {
      break;
    }
    paths.push(item.trim());
  }
  return paths;
}

function jobStepSignatures(block) {
  return [...block.matchAll(/^      - (name|uses|run):\s*([^\r\n]*)$/gm)].map(
    (match) => `${match[1]}:${match[2].trim()}`,
  );
}

function requireAdjacentNamedSteps(
  errors,
  file,
  workflow,
  jobName,
  integrityStep,
  consumerStep,
) {
  const signatures = jobStepSignatures(jobBlock(workflow, jobName));
  const integrity = `name:${integrityStep}`;
  const consumer = `name:${consumerStep}`;
  const integrityIndexes = signatures.flatMap((signature, index) =>
    signature === integrity ? [index] : [],
  );
  const consumerIndexes = signatures.flatMap((signature, index) =>
    signature === consumer ? [index] : [],
  );
  if (
    integrityIndexes.length !== 1 ||
    consumerIndexes.length !== 1 ||
    consumerIndexes[0] !== integrityIndexes[0] + 1
  ) {
    errors.push(
      `${file}: ${jobName} integrity step '${integrityStep}' must be immediately followed by '${consumerStep}' with no intervening run or action`,
    );
  }
}

function namedStepBlock(job, stepName) {
  const marker = `\n      - name: ${stepName}`;
  const start = job.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const remainder = job.slice(start + marker.length);
  const nextStep = remainder.search(/\r?\n      - (?:name|uses|run):/);
  return nextStep < 0 ? remainder : remainder.slice(0, nextStep);
}

function workflowStepBlock(job, stepName) {
  const normalized = job.replaceAll("\r\n", "\n");
  const starts = [
    ...normalized.matchAll(/^      - (?:id|name|uses|run):/gm),
  ].map((match) => match.index ?? 0);
  for (let index = 0; index < starts.length; index += 1) {
    const block = normalized.slice(starts[index], starts[index + 1]);
    if (
      block.startsWith(`      - name: ${stepName}\n`) ||
      block.includes(`\n        name: ${stepName}\n`)
    ) {
      return block;
    }
  }
  return "";
}

function actionStepBlocks(workflow, actionReference) {
  const normalized = workflow.replaceAll("\r\n", "\n");
  const steps = [];
  for (const match of normalized.matchAll(/^      - (?:name|uses|run):/gm)) {
    const start = match.index ?? 0;
    const remainder = normalized.slice(start + match[0].length);
    const next = remainder.search(/^      - (?:name|uses|run):/m);
    const block =
      next < 0
        ? normalized.slice(start)
        : normalized.slice(start, start + match[0].length + next);
    if (block.includes(`uses: ${actionReference}`)) {
      steps.push(block);
    }
  }
  return steps;
}

function rubyMethodBlock(source, methodName) {
  const marker = `\n  def ${methodName}`;
  const start = source.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const remainder = source.slice(start + marker.length);
  const nextMethod = remainder.search(/\r?\n  def [a-zA-Z0-9_]+/);
  return nextMethod < 0 ? remainder : remainder.slice(0, nextMethod);
}

function releaseTargetBlock(analyzer, target) {
  const marker = `\n  "${target}": {`;
  const start = analyzer.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const contentStart = start + marker.length;
  const remainder = analyzer.slice(contentStart);
  const nextTarget = remainder.search(/\r?\n  "srn-[^"]+": \{/);
  return nextTarget < 0 ? remainder : remainder.slice(0, nextTarget);
}

function pushBlock(workflow) {
  const marker = "\n  push:";
  const start = workflow.indexOf(marker);
  if (start < 0) {
    return "";
  }
  const contentStart = start + marker.length;
  const remainder = workflow.slice(contentStart);
  const nextEvent = remainder.search(/\r?\n  [A-Za-z0-9_-]+:\r?\n/);
  return nextEvent < 0 ? remainder : remainder.slice(0, nextEvent);
}

function pushPathPatterns(workflow) {
  const push = pushBlock(workflow);
  const marker = "\n    paths:";
  const start = push.indexOf(marker);
  if (start < 0) {
    return [];
  }
  const contentStart = start + marker.length;
  const remainder = push.slice(contentStart);
  const nextProperty = remainder.search(/\r?\n    [A-Za-z0-9_-]+:\r?\n/);
  const paths = nextProperty < 0 ? remainder : remainder.slice(0, nextProperty);
  return paths
    .split(/\r?\n/)
    .map((line) => /^\s{6}-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line)?.[1])
    .filter(Boolean);
}

function triggerPatternCoversPath(pattern, expectedPath) {
  if (pattern === expectedPath) {
    return true;
  }
  if (!pattern.endsWith("/**")) {
    return false;
  }
  const prefix = pattern.slice(0, -3);
  return expectedPath === prefix || expectedPath.startsWith(`${prefix}/`);
}

const triggerSurfaceCache = new Map();

function releaseTriggerSurface(target) {
  if (!triggerSurfaceCache.has(target)) {
    triggerSurfaceCache.set(
      target,
      discoverReleaseTargetSurface({
        repo: defaultRepositoryRoot,
        target,
      }),
    );
  }
  return triggerSurfaceCache.get(target);
}

export function loadReleaseContractFiles(
  repositoryRoot = defaultRepositoryRoot,
) {
  const files = new Set([
    ...RELEASE_CONTRACT_FILES,
    ...repositoryDocumentationAndWorkflowFiles(repositoryRoot),
  ]);
  return new Map(
    [...files].map((file) => [
      file,
      readFileSync(path.join(repositoryRoot, file), "utf8"),
    ]),
  );
}

export function validateReleaseContract(files) {
  const errors = [];

  errors.push(
    ...validateMcpReleaseDependencyContract(
      files.get(".github/workflows/srn-mcp.yml") ?? "",
    ),
  );

  for (const actionWorkflow of [
    ".github/workflows/ci.yml",
    ".github/workflows/docs-pages.yml",
  ]) {
    errors.push(
      ...validateImmutableWorkflowActions(
        actionWorkflow,
        files.get(actionWorkflow) ?? "",
      ),
    );
  }

  for (const [file, content] of files) {
    const isDocumentationOrWorkflow = REPOSITORY_TEXT_SCAN_EXTENSIONS.has(
      path.extname(file),
    );
    if (
      isDocumentationOrWorkflow &&
      /(?:bundle exec\s+)?fastlane\s+(?:(?:android|ios)\s+prod|ios\s+(?:publish_prod|testflight_beta))\b/.test(
        content,
      )
    ) {
      errors.push(
        `${file}: removed combined mobile production lane remains in documentation or workflow`,
      );
    }
    if (/lane\s+:testflight_beta\b/.test(content)) {
      errors.push(`${file}: unsafe combined iOS testflight_beta lane remains`);
    }
  }

  requireExactWorkflowInventory(
    errors,
    files,
    "app/.github/workflows/",
    APP_EMBEDDED_WORKFLOWS,
    "embedded app workflow surface",
  );
  requireExactWorkflowInventory(
    errors,
    files,
    "app/.github/upstream-workflows-disabled/",
    APP_QUARANTINED_WORKFLOWS,
    "quarantined app workflow surface",
  );
  requireExactWorkflowInventory(
    errors,
    files,
    "server/.github/workflows/",
    SERVER_EMBEDDED_WORKFLOWS,
    "embedded server workflow surface",
  );
  requireExactWorkflowInventory(
    errors,
    files,
    "server/.github/upstream-workflows-disabled/",
    SERVER_QUARANTINED_WORKFLOWS,
    "quarantined server workflow surface",
  );
  for (const [readmeFile, expected, heading] of [
    [
      "app/.github/upstream-workflows-disabled/README.md",
      APP_QUARANTINED_WORKFLOWS,
      "# Quarantined upstream workflows",
    ],
    [
      "server/.github/upstream-workflows-disabled/README.md",
      SERVER_QUARANTINED_WORKFLOWS,
      "# Quarantined upstream server workflows",
    ],
  ]) {
    const readme = files.get(readmeFile) ?? "";
    requireFragment(
      errors,
      readmeFile,
      readme,
      heading,
      "quarantine ownership heading",
    );
    for (const workflowFile of expected) {
      requireFragment(
        errors,
        readmeFile,
        readme,
        `\`${path.basename(workflowFile)}\``,
        `quarantine rationale for ${path.basename(workflowFile)}`,
      );
    }
  }
  for (const [file, fragment, description] of [
    [
      "app/.github/workflows/snjs.pr.yml",
      "docker push standardnotes/snjs:test",
      "classified embedded SNJS Docker mutation target",
    ],
    [
      "app/.github/workflows/snjs.upgrade.event.yml",
      "peter-evans/create-pull-request@",
      "classified embedded SNJS repository mutation target",
    ],
  ]) {
    requireFragment(errors, file, files.get(file) ?? "", fragment, description);
  }

  for (const [file, expectedJobs] of [
    [
      ".github/workflows/srn-client.yml",
      [
        "impact",
        "lint",
        "format",
        "test",
        "build",
        "decide",
        "identity",
        "package",
        "smoke",
        "release",
      ],
    ],
    [
      ".github/workflows/srn-server.yml",
      [
        "impact",
        "lint",
        "format",
        "test",
        "build",
        "decide",
        "identity",
        "package",
        "smoke",
        "release",
      ],
    ],
    [
      ".github/workflows/srn-mcp.yml",
      [
        "impact",
        "audit",
        "lint",
        "format",
        "test",
        "build",
        "decide",
        "identity",
        "package",
        "smoke",
        "release",
      ],
    ],
    [
      ".github/workflows/srn-home-server.yml",
      ["impact", "build", "decide", "identity", "package", "smoke", "release"],
    ],
    [
      ".github/workflows/srn-admin.yml",
      ["impact", "build", "decide", "identity", "package", "smoke", "release"],
    ],
    [
      ".github/workflows/srn-openclaw.yml",
      [
        "impact",
        "context",
        "quality",
        "package",
        "decide",
        "smoke",
        "identity",
        "attest",
        "release",
      ],
    ],
    [
      ".github/workflows/srn-desktop.yml",
      [
        "impact",
        "identity",
        "build",
        "decide",
        "discard_unchanged",
        "fan_in",
        "release",
      ],
    ],
    [".github/workflows/release-contract.yml", ["validate"]],
  ]) {
    requireExactJobSet(errors, file, files.get(file) ?? "", expectedJobs);
  }

  // Every automatic publisher uses the same two-stage selective-release
  // contract: an ancestry-aware source analysis first, then a normalized
  // artifact/input fingerprint before any tag or external publication. Missing
  // refs, shallow history and malformed/ambiguous tag versions are errors in
  // the analyzer; an audited force reason is the only bypass.
  for (const [file, target, firstJobName] of SELECTIVE_RELEASE_WORKFLOWS) {
    const workflow = files.get(file) ?? "";
    for (const [fragment, description] of [
      ["permissions:\n  contents: read", "read-only workflow permissions"],
      [`concurrency:\n  group: ${target}-release`, "per-product concurrency"],
      ["  cancel-in-progress: false", "non-cancelling release concurrency"],
    ]) {
      requireFragment(errors, file, workflow, fragment, description);
    }
    const writePermissions = workflow
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("#"))
      .filter((line) => line.trim() === "contents: write").length;
    const hasDraftReservation =
      TOOL_WORKFLOWS.includes(file) ||
      target === "srn-openclaw" ||
      target === "srn-desktop" ||
      target === "srn-mobile";
    const expectedWritePermissions =
      target === "srn-desktop" ? 3 : hasDraftReservation ? 2 : 1;
    if (writePermissions !== expectedWritePermissions) {
      errors.push(
        hasDraftReservation
          ? `${file}: expected the exact identity/reconciliation/publication write-job count ${expectedWritePermissions}, found ${writePermissions}`
          : `${file}: expected contents: write only on the publication job, found ${writePermissions}`,
      );
    }
    for (const [fragment, description] of [
      ["force_release:", "audited force-release input"],
      ["force_reason:", "audited force reason input"],
    ]) {
      requireFragment(errors, file, workflow, fragment, description);
    }

    const push = pushBlock(workflow);
    if (!/\n    branches:\s*\[main\]\s*(?:\r?\n|$)/.test(push)) {
      errors.push(`${file}: automatic release analysis must run on main`);
    }
    const triggerPaths = pushPathPatterns(workflow);
    for (const sharedPath of SHARED_RELEASE_GATING_PATHS) {
      if (
        triggerPaths.some((pattern) =>
          triggerPatternCoversPath(pattern, sharedPath),
        )
      ) {
        errors.push(
          `${file}: product publisher paths must not include shared release gate '${sharedPath}'; normal CI owns shared-gate validation`,
        );
      }
    }
    const surface = releaseTriggerSurface(target);
    for (let index = 0; index < surface.packageDirectories.length; index += 1) {
      const directory = surface.packageDirectories[index];
      const packageName = surface.dependencyClosure[index];
      const expectedPath = `${directory}/__release_surface__`;
      if (
        !triggerPaths.some((pattern) =>
          triggerPatternCoversPath(pattern, expectedPath),
        )
      ) {
        errors.push(
          `${file}: push paths do not cover release dependency '${packageName}' at '${directory}/**'`,
        );
      }
    }
    for (const configPath of surface.configPaths) {
      if (
        !triggerPaths.some((pattern) =>
          triggerPatternCoversPath(pattern, configPath),
        )
      ) {
        errors.push(
          `${file}: push paths do not cover release configuration '${configPath}'`,
        );
      }
    }
    for (const configPrefix of surface.configPrefixes) {
      const expectedPath = `${configPrefix}/__release_config__`;
      if (
        !triggerPaths.some((pattern) =>
          triggerPatternCoversPath(pattern, expectedPath),
        )
      ) {
        errors.push(
          `${file}: push paths do not cover release configuration '${configPrefix}/**'`,
        );
      }
    }

    const impact = jobBlock(workflow, "impact");
    if (!impact) {
      errors.push(`${file}: missing release-impact analysis job`);
    } else {
      requireAdjacentNamedSteps(
        errors,
        file,
        workflow,
        "impact",
        "Install release policy dependencies",
        "Validate release packaging contract",
      );
      for (const [fragment, description] of [
        ["fetch-depth: 0", "complete Git history checkout"],
        [
          "node scripts/validate-release-contract.mjs",
          "in-chain packaging contract validation",
        ],
        [
          "node scripts/analyze-release-impact.mjs",
          "release-impact analyzer invocation",
        ],
        [
          RELEASE_POLICY_INSTALL_COMMAND,
          "pinned release-policy dependency install",
        ],
        [`--target ${target}`, `${target} analyzer target`],
        [
          "FORCE_RELEASE: ${{ github.event_name == 'workflow_dispatch' && inputs.force_release || false }}",
          "manual-only force source",
        ],
        [
          "FORCE_REASON: ${{ github.event_name == 'workflow_dispatch' && inputs.force_reason || '' }}",
          "manual-only force reason",
        ],
        ['--force "${FORCE_RELEASE}"', "force flag forwarding"],
        ['--force-reason "${FORCE_REASON}"', "force reason forwarding"],
        ["base_ref:", "selected base-ref output"],
        ["baseline_status:", "selected baseline-status output"],
        ["publication_gate:", "publication-gate output"],
        ["reason_codes:", "machine-readable impact reasons"],
      ]) {
        requireFragment(errors, file, impact, fragment, description);
      }
      if (
        impact.indexOf("node scripts/validate-release-contract.mjs") >
        impact.indexOf("node scripts/analyze-release-impact.mjs")
      ) {
        errors.push(
          `${file}: packaging contract validation must run before release-impact analysis`,
        );
      }
      const releasePolicyInstallIndex = impact.indexOf(
        RELEASE_POLICY_INSTALL_COMMAND,
      );
      const contractValidationIndex = impact.indexOf(
        "node scripts/validate-release-contract.mjs",
      );
      const impactAnalysisIndex = impact.indexOf(
        "node scripts/analyze-release-impact.mjs",
      );
      if (
        releasePolicyInstallIndex < 0 ||
        contractValidationIndex <= releasePolicyInstallIndex ||
        impactAnalysisIndex <= contractValidationIndex
      ) {
        errors.push(
          `${file}: release-policy dependencies must install before contract validation and impact analysis`,
        );
      }
      if (target !== "srn-openclaw" && target !== "srn-mobile") {
        requireFragment(
          errors,
          file,
          impact,
          "git fetch --force --tags origin",
          "complete release tag fetch",
        );
      }
    }
    const expectedReleasePolicyInstalls = TOOL_WORKFLOWS.includes(file) ? 2 : 1;
    const actualReleasePolicyInstalls = countOccurrences(
      workflow,
      RELEASE_POLICY_INSTALL_COMMAND,
    );
    if (actualReleasePolicyInstalls !== expectedReleasePolicyInstalls) {
      errors.push(
        `${file}: expected exactly ${expectedReleasePolicyInstalls} release-policy dependency install(s), found ${actualReleasePolicyInstalls}`,
      );
    }

    const firstJob = jobBlock(workflow, firstJobName);
    if (!firstJob) {
      errors.push(`${file}: missing source-gated ${firstJobName} job`);
    } else if (target === "srn-mobile") {
      requireFragment(
        errors,
        file,
        firstJob,
        "needs: impact",
        `${firstJobName} dependency on release impact`,
      );
      requireFragment(
        errors,
        file,
        firstJob,
        "if: needs.impact.outputs.changed == 'true'",
        `${firstJobName} source-impact gate`,
      );
    }

    const decide = jobBlock(workflow, "decide");
    if (!decide) {
      errors.push(`${file}: missing release fingerprint decision job`);
    } else {
      for (const [fragment, description] of [
        [
          "BASE_REF: ${{ needs.impact.outputs.base_ref }}",
          "analyzer-selected fingerprint base",
        ],
        [
          "BASELINE_STATUS: ${{ needs.impact.outputs.baseline_status }}",
          "analyzer-selected baseline status",
        ],
        ["FORCED: ${{ needs.impact.outputs.forced }}", "audited force output"],
        [
          "node scripts/compare-release-fingerprints.mjs",
          "shared fail-closed fingerprint comparator",
        ],
        ['--base-ref "$BASE_REF"', "selected baseline forwarding"],
        ['--baseline-status "$BASELINE_STATUS"', "baseline-status forwarding"],
        ['--forced "$FORCED"', "audited force forwarding"],
        ["--fingerprint", "release surface fingerprint input"],
        [
          "--output release-fingerprint-comparison.json",
          "fingerprint decision evidence",
        ],
        ["exit 1", "blocked comparison failure"],
      ]) {
        requireFragment(errors, file, decide, fragment, description);
      }
      if (decide.includes("gh release download")) {
        errors.push(
          `${file}: fingerprint comparison must use the shared fail-closed comparator`,
        );
      }
      if (decide.includes('last_tag="$(gh release list')) {
        errors.push(
          `${file}: fingerprint comparison must use the analyzer-selected ancestry-validated base ref`,
        );
      }
    }

    const release = jobBlock(workflow, "release");
    if (!release) {
      errors.push(`${file}: missing release publication job`);
    } else {
      if (!/needs:\s*\[[^\]]*\bdecide\b[^\]]*\]/.test(release)) {
        errors.push(`${file}: release publication does not depend on decide`);
      }
      requireFragment(
        errors,
        file,
        release,
        hasDraftReservation
          ? "needs.decide.outputs.changed == 'true'"
          : "if: needs.decide.outputs.changed == 'true'",
        "unchanged-release publication guard",
      );
      requireFragment(
        errors,
        file,
        release,
        "contents: write",
        "publication-only write permission",
      );
    }

    if (target !== "srn-mobile" && target !== "srn-openclaw") {
      for (const [fragment, description] of [
        ["git fetch --force --tags origin", "complete version tag fetch"],
        [
          'git tag --list "${prefix}*"',
          "collision-safe rolling version source",
        ],
      ]) {
        requireFragment(errors, file, workflow, fragment, description);
      }
      if (workflow.includes("gh release list")) {
        errors.push(
          `${file}: rolling versions must use complete tag history, not a truncated release list`,
        );
      }
    } else if (target === "srn-mobile") {
      requireFragment(
        errors,
        file,
        workflow,
        'git show-ref --verify --quiet "refs/tags/$tag"',
        "mobile tag collision guard",
      );
    }
  }

  const nativeWorkflowInputs = new Map([
    [
      ".github/workflows/srn-client.yml",
      {
        bundle: "dist/index.cjs",
        entrypoint: "cli/srn-client/src/index.ts",
        payload: "--path dist/index.cjs",
      },
    ],
    [
      ".github/workflows/srn-server.yml",
      {
        bundle: "dist/index.cjs",
        entrypoint: "cli/srn-server/src/index.ts",
        payload: "--path dist/index.cjs",
      },
    ],
    [
      ".github/workflows/srn-mcp.yml",
      {
        bundle: "dist/index.cjs",
        entrypoint: "mcp/src/index.ts",
        payload: "--path mcp/dist/index.cjs",
      },
    ],
    [
      ".github/workflows/srn-home-server.yml",
      {
        bundle: "bundle/home-server.cjs",
        entrypoint: "server/packages/home-server/bin/server.ts",
        payload: "--path dist/bundle/home-server.cjs",
      },
    ],
    [
      ".github/workflows/srn-admin.yml",
      {
        bundle: "bundle/srn-admin.cjs",
        entrypoint: "server/packages/auth/bin/srn_admin.ts",
        payload: "--path dist/bundle/srn-admin.cjs",
      },
    ],
  ]);
  for (const file of TOOL_WORKFLOWS) {
    const workflow = files.get(file) ?? "";
    const nativeInput = nativeWorkflowInputs.get(file);
    for (const [fragment, description] of [
      [
        "native-cli-release.mjs fingerprint",
        "canonical native fingerprint command",
      ],
      ["native-cli-release.mjs package", "canonical native package command"],
      [nativeInput.payload, "native executable payload input"],
      ["- 'scripts/native-cli-release.mjs'", "native contract trigger"],
      [
        "- 'scripts/release-packaging-contract.mjs'",
        "packaging contract trigger",
      ],
    ]) {
      requireFragment(errors, file, workflow, fragment, description);
    }
    for (const forbidden of [
      "PKG_NODE:",
      "PKG_VERSION:",
      "declare -A TARGETS=",
    ]) {
      if (workflow.includes(forbidden)) {
        errors.push(
          `${file}: native packaging duplicates canonical contract via '${forbidden}'`,
        );
      }
    }
    const nativeBuildRuntime = NATIVE_CLI_CONTRACT.buildRuntime.replace(
      /^node/,
      "",
    );
    const normalizedWorkflow = normalizeWorkflowYamlScalars(workflow);
    if (
      !normalizedWorkflow.includes(`NODE_VERSION: ${nativeBuildRuntime}`) &&
      !normalizedWorkflow.includes(`node-version: ${nativeBuildRuntime}`)
    ) {
      errors.push(`${file}: missing contract-bound native build runtime`);
    }
    for (const action of [
      `actions/checkout@${NATIVE_CLI_CONTRACT.actions.checkout}`,
      `actions/download-artifact@${NATIVE_CLI_CONTRACT.actions.downloadArtifact}`,
      `actions/setup-node@${NATIVE_CLI_CONTRACT.actions.setupNode}`,
    ]) {
      requireFragment(
        errors,
        file,
        workflow,
        action,
        "contract-bound native action",
      );
    }
    for (const [name, owner] of Object.entries(NATIVE_ACTION_OWNERS)) {
      requireFragment(
        errors,
        file,
        workflow,
        `${owner}@${NATIVE_CLI_CONTRACT.actions[name]} # ${NATIVE_CLI_CONTRACT.actionVersions[name]}`,
        `version-labelled immutable native ${name} action`,
      );
    }
    validateImmutableActionAllowlist(errors, {
      actionOwners: NATIVE_ACTION_OWNERS,
      actions: NATIVE_CLI_CONTRACT.actions,
      actionVersions: NATIVE_CLI_CONTRACT.actionVersions,
      file,
      workflow,
    });
    const nativeAction = (name) =>
      `${NATIVE_ACTION_OWNERS[name]}@${NATIVE_CLI_CONTRACT.actions[name]}`;
    const nativeJobActions = {
      impact: [nativeAction("checkout"), nativeAction("setupNode")],
      build: [
        nativeAction("checkout"),
        nativeAction("setupNode"),
        nativeAction("uploadArtifact"),
      ],
      decide: [nativeAction("checkout")],
      identity: [nativeAction("checkout")],
      package: [
        nativeAction("checkout"),
        nativeAction("setupNode"),
        nativeAction("downloadArtifact"),
        nativeAction("uploadArtifact"),
      ],
      release: [nativeAction("checkout"), nativeAction("downloadArtifact")],
      smoke: [nativeAction("downloadArtifact")],
    };
    if (file === ".github/workflows/srn-mcp.yml") {
      nativeJobActions.audit = [
        nativeAction("checkout"),
        nativeAction("setupNode"),
      ];
    }
    if (
      new Set([
        ".github/workflows/srn-client.yml",
        ".github/workflows/srn-server.yml",
        ".github/workflows/srn-mcp.yml",
      ]).has(file)
    ) {
      for (const job of ["lint", "format", "test"]) {
        nativeJobActions[job] = [
          nativeAction("checkout"),
          nativeAction("setupNode"),
        ];
      }
    }
    for (const [job, sequence] of Object.entries(nativeJobActions)) {
      requireExactJobActionSequence(errors, file, workflow, job, sequence);
    }
    requireAdjacentNamedSteps(
      errors,
      file,
      workflow,
      "build",
      "Install release policy dependencies",
      "Compute payload and native-packaging contract fingerprint",
    );
    requireAdjacentNamedSteps(
      errors,
      file,
      workflow,
      "build",
      "Compute payload and native-packaging contract fingerprint",
      "Upload bundle artifact",
    );
    requireAdjacentNamedSteps(
      errors,
      file,
      workflow,
      "package",
      "Generate checksums",
      "Upload packaged binaries",
    );
    const nativeFingerprintStep = namedStepBlock(
      jobBlock(workflow, "build"),
      "Compute payload and native-packaging contract fingerprint",
    );
    const nativeFingerprintTerminal = nativeFingerprintStep.trimEnd();
    if (
      !nativeFingerprintTerminal.endsWith('--github-output "$GITHUB_OUTPUT"') &&
      !nativeFingerprintTerminal.endsWith(
        `grep -Eq '^[0-9a-f]{64}$' "dist/bundle/\${TOOL}.fingerprint"`,
      )
    ) {
      errors.push(
        `${file}: native bundle fingerprint must be the final command before artifact upload`,
      );
    }
    const nativeChecksumStep = namedStepBlock(
      jobBlock(workflow, "package"),
      "Generate checksums",
    );
    if (
      !nativeChecksumStep.trimEnd().endsWith("sha256sum --check SHA256SUMS.txt")
    ) {
      errors.push(
        `${file}: native checksum verification must be the final command before packaged upload`,
      );
    }
    const nativeCheckoutCount = countOccurrences(
      workflow,
      `uses: ${nativeAction("checkout")}`,
    );
    const nativeNonpersistentCheckoutCount = countOccurrences(
      workflow,
      "persist-credentials: false",
    );
    if (nativeCheckoutCount !== nativeNonpersistentCheckoutCount) {
      errors.push(
        `${file}: every native checkout must explicitly disable credential persistence`,
      );
    }
    const nativeUploadCount = countOccurrences(
      workflow,
      `uses: ${nativeAction("uploadArtifact")}`,
    );
    const nativeRequiredUploadCount = countOccurrences(
      workflow,
      "if-no-files-found: error",
    );
    if (nativeUploadCount !== nativeRequiredUploadCount) {
      errors.push(`${file}: every native artifact upload must fail when empty`);
    }
    for (const uploadStep of actionStepBlocks(
      workflow,
      nativeAction("uploadArtifact"),
    )) {
      if (!uploadStep.includes("retention-days: 30")) {
        errors.push(
          `${file}: every native recovery artifact must be retained for exactly 30 days`,
        );
      }
    }

    const nativeImpactJob = jobBlock(workflow, "impact");
    for (const [fragment, description] of [
      [
        "git fetch --no-tags --force origin refs/heads/main:refs/remotes/origin/main",
        "protected main source fetch",
      ],
      [
        'protected_sha="$(git rev-parse "refs/remotes/origin/main^{commit}")"',
        "protected main commit resolution",
      ],
      ['test "$GITHUB_REF" = refs/heads/main', "exact main ref authorization"],
      [
        'test "$GITHUB_SHA" = "$protected_sha"',
        "exact protected main commit authorization",
      ],
    ]) {
      requireFragment(errors, file, nativeImpactJob, fragment, description);
    }
    const nativeProtectedJobs = ["identity", "release"];
    for (const jobName of nativeProtectedJobs) {
      requireFragment(
        errors,
        file,
        jobBlock(workflow, jobName),
        "environment: release-production",
        `${jobName} protected production environment`,
      );
    }
    if (countOccurrences(workflow, "environment: release-production") !== 2) {
      errors.push(
        `${file}: native production environment must be scoped exactly to identity and release`,
      );
    }

    const identityJob = jobBlock(workflow, "identity");
    if (!identityJob) {
      errors.push(`${file}: missing retry-safe native release identity job`);
    } else {
      for (const [fragment, description] of [
        [
          "needs: [build, decide, impact]",
          "native identity dependency on build, decision, and force intent",
        ],
        [
          "if: needs.decide.outputs.changed == 'true'",
          "native identity unchanged-release guard",
        ],
        ["permissions:\n      contents: write", "native draft permission"],
        [
          "version: ${{ steps.identity.outputs.version }}",
          "reserved version output",
        ],
        ["tag: ${{ steps.identity.outputs.tag }}", "reserved tag output"],
        [
          "release_id: ${{ steps.identity.outputs.release_id }}",
          "reserved release ID output",
        ],
        ["reused: ${{ steps.identity.outputs.reused }}", "draft reuse output"],
        [
          "published: ${{ steps.identity.outputs.published }}",
          "published reservation output",
        ],
        ["fetch-depth: 0", "complete native identity history"],
        ["git fetch --force --tags origin", "complete native identity tags"],
        [
          "EXPECTED_FINGERPRINT: ${{ needs.build.outputs.fingerprint }}",
          "identity deterministic fingerprint input",
        ],
        [
          "FORCED: ${{ needs.impact.outputs.forced }}",
          "identity force-state input",
        ],
        [
          "IMPACT_RESULT: ${{ needs.impact.outputs.result_json }}",
          "identity analyzed-impact input",
        ],
        [
          '[[ "$EXPECTED_FINGERPRINT" =~ ^[0-9a-f]{64}$ ]]',
          "identity fingerprint format assertion",
        ],
        [
          '[[ "$FORCED" == "true" || "$FORCED" == "false" ]]',
          "identity force-state assertion",
        ],
        [".headSha == $sha", "identity force-result commit assertion"],
        [".forced == $forced", "identity force-result state assertion"],
        [
          "(($forced | not) and .forceReason == null)",
          "unforced null-reason assertion",
        ],
        [
          '(.forceReason | gsub("^\\\\s+|\\\\s+$"; "")) | length > 0',
          "forced nonempty-reason assertion",
        ],
        [
          '[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]]',
          "force invocation identifier assertion",
        ],
        ['intent="forced-${GITHUB_RUN_ID}"', "force invocation-scoped intent"],
        ['intent="automatic"', "automatic retry intent"],
        [
          "<!-- srn-release-reservation tool=${TOOL} commit=${GITHUB_SHA} fingerprint=${EXPECTED_FINGERPRINT} intent=${intent} -->",
          "tool-commit-fingerprint-intent release marker",
        ],
        [
          'gh api "repos/${GITHUB_REPOSITORY}/releases?per_page=100" --paginate --slurp',
          "complete native release inventory",
        ],
        [
          ".target_commitish == $sha",
          "reserved release target-commit equality",
        ],
        [
          'marker_prefix="<!-- srn-release-reservation tool=${TOOL} "',
          "tool-scoped stale draft marker",
        ],
        ["mapfile -t stale_reservations", "stale native draft enumeration"],
        ["                ) | not)", "nonmatching draft fingerprint detection"],
        [
          'if [ "${#stale_reservations[@]}" -gt 0 ]; then',
          "stale native draft fail-closed gate",
        ],
        [
          "Reconcile or delete the stale drafts explicitly, then rerun.",
          "stale native draft recovery instruction",
        ],
        [".tag_name == $tag", "draft tag equality"],
        [".name == $name", "draft title equality"],
        [
          ".draft == true or .draft == false",
          "same-run draft or published recovery state",
        ],
        [".prerelease == false", "non-prerelease native draft"],
        [
          `published="$(jq -r '.draft | not' <<< "$release")"`,
          "published-state recovery output",
        ],
        [
          `test "$(git rev-list -n 1 "$tag")" = "$GITHUB_SHA"`,
          "published tag target verification",
        ],
        [
          'git tag --list "${prefix}*"',
          "collision-safe rolling native version allocation",
        ],
        [
          'git show-ref --verify --quiet "refs/tags/${tag}"',
          "native Git tag collision preflight",
        ],
        [
          'gh api --method POST "repos/${GITHUB_REPOSITORY}/releases"',
          "draft release reservation",
        ],
        ['-f target_commitish="$GITHUB_SHA"', "exact native draft target"],
        ["-F draft=true", "draft-only native reservation"],
        ['echo "release_id=$release_id"', "release ID handoff"],
        ['echo "published=$published"', "published state handoff"],
      ]) {
        requireFragment(errors, file, identityJob, fragment, description);
      }
    }
    if (identityJob.includes("GITHUB_RUN_ATTEMPT")) {
      errors.push(
        `${file}: native forced identity must stay stable across attempts in one workflow run`,
      );
    }

    const packageJob = jobBlock(workflow, "package");
    const buildJob = jobBlock(workflow, "build");
    for (const [job, description] of [
      [buildJob, "fingerprinted native invocation plan"],
      [packageJob, "executed native invocation plan"],
    ]) {
      requireFragment(
        errors,
        file,
        job,
        `--bundle ${nativeInput.bundle}`,
        description,
      );
      requireFragment(errors, file, job, "--out-dir out", description);
    }
    for (const action of [
      `actions/checkout@${NATIVE_CLI_CONTRACT.actions.checkout}`,
      `actions/download-artifact@${NATIVE_CLI_CONTRACT.actions.downloadArtifact}`,
      `actions/setup-node@${NATIVE_CLI_CONTRACT.actions.setupNode}`,
    ]) {
      requireFragment(
        errors,
        file,
        packageJob,
        action,
        "contract-bound native package action",
      );
    }

    for (const [fragment, description] of [
      [
        file === ".github/workflows/srn-mcp.yml"
          ? "needs: [audit, build, decide, identity]"
          : "needs: [build, decide, identity]",
        "package fan-in over reserved identity",
      ],
      [
        "if: needs.decide.outputs.changed == 'true' && needs.identity.outputs.published != 'true'",
        "package skip for already-published same-run release",
      ],
      [
        "RELEASE_VERSION: ${{ needs.identity.outputs.version }}",
        "package reserved version input",
      ],
      [
        "RELEASE_TAG: ${{ needs.identity.outputs.tag }}",
        "package reserved tag input",
      ],
      [
        "RELEASE_ID: ${{ needs.identity.outputs.release_id }}",
        "package reserved release ID input",
      ],
      [
        'test "$RELEASE_TAG" = "${TOOL}-v${RELEASE_VERSION}"',
        "package reserved tag/version assertion",
      ],
      ['[[ "$RELEASE_ID" =~ ^[0-9]+$ ]]', "package release ID assertion"],
      ['test "$RELEASE_COMMIT" = "$GITHUB_SHA"', "package commit assertion"],
    ]) {
      requireFragment(errors, file, packageJob, fragment, description);
    }

    const releaseJob = jobBlock(workflow, "release");
    for (const [fragment, description] of [
      [
        file === ".github/workflows/srn-mcp.yml"
          ? "needs: [impact, audit, build, decide, identity, package, smoke]"
          : "needs: [impact, build, decide, identity, package, smoke]",
        "native publication fan-in including force intent",
      ],
      [
        file === ".github/workflows/srn-mcp.yml"
          ? "if: always() && needs.impact.result == 'success' && needs.audit.result == 'success' && needs.decide.outputs.changed == 'true' && needs.identity.result == 'success' && ((needs.package.result == 'success' && needs.smoke.result == 'success') || (needs.identity.outputs.published == 'true' && needs.package.result == 'skipped' && needs.smoke.result == 'skipped'))"
          : "if: always() && needs.impact.result == 'success' && needs.decide.outputs.changed == 'true' && needs.identity.result == 'success' && ((needs.package.result == 'success' && needs.smoke.result == 'success') || (needs.identity.outputs.published == 'true' && needs.package.result == 'skipped' && needs.smoke.result == 'skipped'))",
        "retry-safe native publication result gate",
      ],
      [
        "RELEASE_VERSION: ${{ needs.identity.outputs.version }}",
        "publication reserved version input",
      ],
      [
        "RELEASE_TAG: ${{ needs.identity.outputs.tag }}",
        "publication reserved tag input",
      ],
      [
        "RELEASE_ID: ${{ needs.identity.outputs.release_id }}",
        "publication reserved release ID input",
      ],
      [
        "IDENTITY_PUBLISHED: ${{ needs.identity.outputs.published }}",
        "publication recovered-state input",
      ],
      [
        "EXPECTED_FINGERPRINT: ${{ needs.build.outputs.fingerprint }}",
        "publication exact fingerprint input",
      ],
      [
        "FORCED: ${{ needs.impact.outputs.forced }}",
        "publication force-state input",
      ],
      [
        "IMPACT_RESULT: ${{ needs.impact.outputs.result_json }}",
        "publication analyzed-impact input",
      ],
      [
        '[[ "$FORCED" == "true" || "$FORCED" == "false" ]]',
        "publication force-state assertion",
      ],
      [".headSha == $sha", "publication force-result commit assertion"],
      [".forced == $forced", "publication force-result state assertion"],
      [
        "(($forced | not) and .forceReason == null)",
        "publication unforced null-reason assertion",
      ],
      [
        '(.forceReason | gsub("^\\\\s+|\\\\s+$"; "")) | length > 0',
        "publication forced nonempty-reason assertion",
      ],
      [
        '[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ ]]',
        "publication force invocation identifier assertion",
      ],
      [
        'intent="forced-${GITHUB_RUN_ID}"',
        "publication force invocation-scoped intent",
      ],
      ['intent="automatic"', "publication automatic retry intent"],
      [
        "<!-- srn-release-reservation tool=${TOOL} commit=${GITHUB_SHA} fingerprint=${EXPECTED_FINGERPRINT} intent=${intent} -->",
        "publication tool-commit-fingerprint-intent marker",
      ],
      ["fetch-depth: 0", "complete native publication history"],
      [
        'git show-ref --verify --quiet "refs/tags/${RELEASE_TAG}"',
        "publication Git tag collision guard",
      ],
      [
        'gh api "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"',
        "exact draft lookup by ID",
      ],
      [".tag_name == $tag", "publication draft tag equality"],
      [".name == $name", "publication draft title equality"],
      [".target_commitish == $sha", "publication draft target equality"],
      [
        ".draft == true or .draft == false",
        "publication retry state assertion",
      ],
      [".prerelease == false", "publication prerelease-state assertion"],
      ["contains($marker)", "publication reservation marker assertion"],
      [
        "find out -maxdepth 1 -type f -printf '%f\\n' | LC_ALL=C sort",
        "exact native asset plan",
      ],
      ["echo SHA256SUMS.txt", "checksum asset contract"],
      ['echo "${TOOL}.fingerprint"', "fingerprint asset contract"],
      ['echo "${TOOL}-windows-x64.exe"', "Windows x64 asset contract"],
      ['echo "${TOOL}-windows-arm64.exe"', "Windows arm64 asset contract"],
      ['echo "${TOOL}-macos-x64"', "macOS x64 asset contract"],
      ['echo "${TOOL}-macos-arm64"', "macOS arm64 asset contract"],
      ['echo "${TOOL}-linux-x64"', "Linux x64 asset contract"],
      ['echo "${TOOL}-linux-arm64"', "Linux arm64 asset contract"],
      [
        'gh api --method DELETE "repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}"',
        "unexpected draft asset cleanup",
      ],
      [
        'gh release upload "$RELEASE_TAG" "${files[@]}" --clobber --repo "$GITHUB_REPOSITORY"',
        "retry-safe native asset replacement",
      ],
      [
        '.digest | test("^sha256:[0-9a-f]{64}$")',
        "remote native asset SHA-256 digest assertion",
      ],
      [
        'diff -u "$expected_assets" "$remote_assets"',
        "exact remote native asset set",
      ],
      [
        'gh release download "$RELEASE_TAG" --dir "$downloaded" --repo "$GITHUB_REPOSITORY"',
        "remote native asset redownload",
      ],
      [
        'diff -u "$expected_assets" "$local_assets"',
        "local or downloaded native asset set",
      ],
      [
        'test "$digest" = "sha256:${actual}"',
        "remote native asset digest equality",
      ],
      ["verify_directory out", "post-upload native asset verification"],
      [
        "<!-- srn-release-assets-sha256:${asset_manifest_sha} -->",
        "sorted native asset-manifest digest marker",
      ],
      [
        "Reserved native draft asset manifest drifted from the exact local payload.",
        "native asset-manifest drift rejection",
      ],
      [
        'elif [ "$existing_asset_markers" -ne 1 ]; then',
        "exactly one existing native asset-manifest marker",
      ],
      [
        '| [scan("<!-- srn-release-assets-sha256:[0-9a-f]{64} -->")] | length) == 1)',
        "exactly one total native asset-manifest marker",
      ],
      [
        "done < \"$expected_assets\" | jq -s 'sort_by(.name)'",
        "sorted native asset-manifest entries",
      ],
      [
        '-f tag_name="$RELEASE_TAG" -f body="$next_body"',
        "draft tag preservation during native manifest binding",
      ],
      [
        'asset_manifest_sha="$(jq -cS . "$manifest_file" | sha256sum | cut -d \' \' -f 1)"',
        "canonical native asset-manifest SHA-256",
      ],
      [
        'size="$(stat -c \'%s\' -- "${directory}/${asset_name}")"',
        "native asset size binding",
      ],
      ["bind_asset_manifest out", "pre-mutation native asset binding"],
      [
        'test "$(tr -d \'\\r\\n\' < "${directory}/${TOOL}.fingerprint")" = "$EXPECTED_FINGERPRINT"',
        "remote native fingerprint equality",
      ],
      [
        'if [ "$draft" = "false" ]; then',
        "already-published native recovery branch",
      ],
      [
        "was already published by this workflow run; verified exact assets.",
        "ambiguous publication recovery evidence",
      ],
      [
        'gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"',
        "final native draft publication",
      ],
      ["-F draft=false", "final native published state"],
      ["-f make_latest=false", "native Latest-pointer opt-out"],
    ]) {
      requireFragment(errors, file, releaseJob, fragment, description);
    }
    if (releaseJob.includes("GITHUB_RUN_ATTEMPT")) {
      errors.push(
        `${file}: native publication force intent must stay stable across attempts in one workflow run`,
      );
    }
    if (releaseJob.includes("gh release create")) {
      errors.push(`${file}: native publication must reuse its reserved draft`);
    }
    if (/version="\$\{YY\}\.\$\(\(max \+ 1\)\)"/.test(releaseJob)) {
      errors.push(
        `${file}: native publication must not allocate a new version`,
      );
    }
    const identityValidationIndex = releaseJob.indexOf(
      'jq -e --arg tag "$RELEASE_TAG"',
    );
    const unexpectedAssetCleanupIndex = releaseJob.indexOf(
      "gh api --method DELETE",
    );
    const uploadIndex = releaseJob.indexOf("gh release upload");
    const hashEqualityIndex = releaseJob.lastIndexOf("verify_directory out");
    const manifestBindingIndex = releaseJob.indexOf("bind_asset_manifest out");
    const publicationIndex = releaseJob.lastIndexOf("gh api --method PATCH");
    if (
      identityValidationIndex < 0 ||
      unexpectedAssetCleanupIndex <= identityValidationIndex
    ) {
      errors.push(
        `${file}: native draft identity must be validated before remote asset cleanup`,
      );
    }
    if (
      manifestBindingIndex <= identityValidationIndex ||
      manifestBindingIndex >= unexpectedAssetCleanupIndex
    ) {
      errors.push(
        `${file}: native asset manifest must bind the validated draft before remote asset cleanup`,
      );
    }
    if (uploadIndex <= unexpectedAssetCleanupIndex) {
      errors.push(
        `${file}: native asset upload must follow validated draft cleanup`,
      );
    }
    if (
      hashEqualityIndex <= uploadIndex ||
      publicationIndex <= hashEqualityIndex
    ) {
      errors.push(
        `${file}: native draft publication must follow remote asset hash verification`,
      );
    }

    const smokeJob = jobBlock(workflow, "smoke");
    const nativeSource = files.get(nativeInput.entrypoint) ?? "";
    for (const [fragment, description] of [
      [
        "needs: [decide, identity, package]",
        "native smoke dependency on exact package identity",
      ],
      [
        "if: needs.decide.outputs.changed == 'true' && needs.identity.outputs.published != 'true'",
        "native smoke already-published skip",
      ],
      ["fail-fast: false", "complete native smoke matrix"],
      ["runner: windows-2025", "Windows x64 native smoke runner"],
      ["runner: windows-11-arm", "Windows ARM64 native smoke runner"],
      ["runner: ubuntu-24.04", "Linux x64 native smoke runner"],
      ["runner: ubuntu-24.04-arm", "Linux ARM64 native smoke runner"],
      ["runner: macos-15-intel", "macOS x64 native smoke runner"],
      ["runner: macos-15", "macOS ARM64 native smoke runner"],
      ["sha256sum --check SHA256SUMS.txt", "native smoke checksum proof"],
      [
        'file "$executable" | grep -E "$FILE_PATTERN"',
        "native smoke architecture proof",
      ],
      ["HTTP_PROXY: http://127.0.0.1:9", "native smoke offline HTTP gate"],
      ["HTTPS_PROXY: http://127.0.0.1:9", "native smoke offline HTTPS gate"],
      ["ALL_PROXY: http://127.0.0.1:9", "native smoke offline all-proxy gate"],
      ["--srn-release-self-test", "native executable self-test"],
      [
        'test "$output" = "srn-native-self-test-v1 ${EXPECTED_PLATFORM} ${EXPECTED_NODE_ARCH}"',
        "exact native self-test identity",
      ],
    ]) {
      requireFragment(errors, file, smokeJob, fragment, description);
    }
    const smokeMatrixEntries = [
      ["windows-2025", "windows-x64.exe", "win32", "x64"],
      ["windows-11-arm", "windows-arm64.exe", "win32", "arm64"],
      ["ubuntu-24.04", "linux-x64", "linux", "x64"],
      ["ubuntu-24.04-arm", "linux-arm64", "linux", "arm64"],
      ["macos-15-intel", "macos-x64", "darwin", "x64"],
      ["macos-15", "macos-arm64", "darwin", "arm64"],
    ];
    for (const [
      runner,
      asset,
      platform,
      nodeArchitecture,
    ] of smokeMatrixEntries) {
      const entryPattern = new RegExp(
        `runner:\\s*${runner}[^}]+asset:\\s*${asset.replace(".", "\\.")}[^}]+platform:\\s*${platform}[^}]+node_arch:\\s*${nodeArchitecture}`,
      );
      if (!entryPattern.test(smokeJob)) {
        errors.push(
          `${file}: missing exact ${runner} ${asset} native smoke target`,
        );
      }
    }
    if (
      smokeJob.includes("|| true") ||
      smokeJob.includes("continue-on-error")
    ) {
      errors.push(`${file}: native smoke checks must remain fail-closed`);
    }
    if (
      !/process\.argv\.length\s*===\s*3\s*&&\s*process\.argv\[2\]\s*===\s*["']--srn-release-self-test["']/.test(
        nativeSource,
      )
    ) {
      errors.push(
        `${nativeInput.entrypoint}: missing exact native self-test argument gate`,
      );
    }
    requireFragment(
      errors,
      nativeInput.entrypoint,
      nativeSource,
      "srn-native-self-test-v1 ${process.platform} ${process.arch}",
      "platform and architecture self-test output",
    );
  }

  const nativeReleaseFile = "scripts/native-cli-release.mjs";
  const nativeRelease = files.get(nativeReleaseFile) ?? "";
  for (const [fragment, description] of [
    [
      "packagingContract.targets.map((target) =>",
      "contract-driven target plan",
    ],
    [
      "`${packagingContract.embeddedRuntime}-${target.target}`",
      "contract-driven runtime",
    ],
    [
      "`${packagingContract.packager.name}@${packagingContract.packager.version}`",
      "contract-driven packager",
    ],
    ["...packagingContract.packager.flags", "contract-driven package flags"],
    ['platform === "win32" ? "npx.cmd" : "npx"', "shell-free npx selection"],
    ["executionPlan,", "fingerprinted native invocation plan"],
    ["executorIdentity,", "fingerprinted native executor identity"],
    [
      "nativeCliExecutorImplementationSource()",
      "native executor implementation source",
    ],
    [
      'readFileSync(NATIVE_EXECUTOR_IMPLEMENTATION_FILE, "utf8")',
      "complete native executor module source",
    ],
    [
      "normalizeNativeExecutorSource(source, tool)",
      "self-contained native executor source identity",
    ],
    [
      "createRequire(import.meta.url)",
      "supported release-policy parser loader",
    ],
    ['name: "@babel/parser"', "pinned public semantic parser"],
    ['version: "7.29.7"', "exact semantic parser version"],
    ["parseNativeExecutorAst(source)", "module-aware native AST parser"],
    ["canonicalNativeAst(value)", "canonical semantic AST normalizer"],
    [
      "nativeExecutorSemanticPartitions(source)",
      "product-partitioned native semantics",
    ],
    [
      "the native semantic JavaScript parser is unavailable:",
      "explicit missing-parser ambiguity",
    ],
    [
      "srn-js-source-bytes",
      "collision-resistant native executor source identity",
    ],
    ["return source;", "exact native executor source-byte hashing"],
    ["async function main()", "native command dispatcher implementation"],
    [
      'if (options.command === "package")',
      "native package command dispatch branch",
    ],
    ["srn-native-executor-v4", "versioned native executor identity"],
    [
      "for (const invocation of plan.invocations)",
      "canonical invocation execution loop",
    ],
    [
      "spawn(invocation.executable, invocation.args",
      "canonical shell-free invocation execution",
    ],
    ["shell: false", "explicit shell-free invocation"],
    ["spawn = spawnSync", "production spawn implementation"],
    [
      "product?.supplementalArtifacts ?? []",
      "product supplemental artifact plan",
    ],
  ]) {
    requireFragment(
      errors,
      nativeReleaseFile,
      nativeRelease,
      fragment,
      description,
    );
  }
  for (const privateParserAccess of [
    "process.binding",
    "internal/deps/",
    'from "node:vm"',
    "runInNewContext",
  ]) {
    if (nativeRelease.includes(privateParserAccess)) {
      errors.push(
        `${nativeReleaseFile}: private Node parser access is forbidden (${privateParserAccess})`,
      );
    }
  }

  const packagingContractFile = "scripts/release-packaging-contract.mjs";
  const packagingContract = files.get(packagingContractFile) ?? "";
  const nativePackagingContract = sourceSection(
    packagingContract,
    '  "native-cli": Object.freeze({',
    "  desktop: Object.freeze({",
  );
  const desktopPackagingContract = sourceSection(
    packagingContract,
    "  desktop: Object.freeze({",
    "  mobile: Object.freeze({",
  );
  const mobilePackagingContract = sourceSection(
    packagingContract,
    "  mobile: Object.freeze({",
    "  openclaw: Object.freeze({",
  );
  const openClawPackagingContract = sourceSection(
    packagingContract,
    "  openclaw: Object.freeze({",
    "});\n\nfunction isPlainObject",
  );
  for (const [fragment, description] of [
    [
      `embeddedRuntime: "${NATIVE_CLI_CONTRACT.embeddedRuntime}"`,
      "native embedded runtime contract",
    ],
    [
      `version: "${NATIVE_CLI_CONTRACT.packager.version}"`,
      "native packager version contract",
    ],
    [
      `flags: Object.freeze(["${NATIVE_CLI_CONTRACT.packager.flags.join('", "')}"])`,
      "native packager flag contract",
    ],
    [
      "srn-release-packaging-contract-v1",
      "versioned packaging fingerprint schema",
    ],
  ]) {
    requireFragment(
      errors,
      packagingContractFile,
      packagingContract,
      fragment,
      description,
    );
  }
  for (const [output, target] of TOOL_TARGETS) {
    requireFragment(
      errors,
      packagingContractFile,
      packagingContract,
      `Object.freeze({ output: "${output}", target: "${target}" })`,
      `native target contract ${target}`,
    );
  }
  for (const name of Object.keys(NATIVE_ACTION_OWNERS)) {
    requireFragment(
      errors,
      packagingContractFile,
      nativePackagingContract,
      `${name}: "${NATIVE_CLI_CONTRACT.actions[name]}"`,
      `fingerprinted native ${name} action SHA`,
    );
    requireFragment(
      errors,
      packagingContractFile,
      nativePackagingContract,
      `${name}: "${NATIVE_CLI_CONTRACT.actionVersions[name]}"`,
      `validated human label for native ${name} action SHA`,
    );
  }
  requireFragment(
    errors,
    packagingContractFile,
    packagingContract,
    `targets: Object.freeze([\n${TOOL_TARGETS.map(
      ([output, target]) =>
        `      Object.freeze({ output: "${output}", target: "${target}" }),`,
    ).join("\n")}\n    ]),`,
    "exact native target matrix",
  );
  const homeServerWorkflowFile = ".github/workflows/srn-home-server.yml";
  const homeServerBuild = jobBlock(
    files.get(homeServerWorkflowFile) ?? "",
    "build",
  );
  for (const [fragment, description] of [
    [
      "node ../../../scripts/native-cli-release.mjs fingerprint",
      "normalized home-server release fingerprint",
    ],
    [
      "--path dist/bundle/home-server.cjs",
      "home-server executable fingerprint input",
    ],
    [
      "--path dist/bundle/migrations",
      "home-server migration fingerprint input",
    ],
  ]) {
    requireFragment(
      errors,
      homeServerWorkflowFile,
      homeServerBuild,
      fragment,
      description,
    );
  }
  requireFragment(
    errors,
    packagingContractFile,
    packagingContract,
    'output: "srn-home-server-migrations.zip"',
    "home-server migration archive output contract",
  );
  for (const [fragment, description] of [
    ['executable: "zip"', "home-server migration archive executable"],
    ['flags: Object.freeze(["-qr"])', "home-server migration archive flags"],
    ['input: "migrations"', "home-server migration archive input"],
  ]) {
    requireFragment(
      errors,
      packagingContractFile,
      packagingContract,
      fragment,
      description,
    );
  }
  if ((files.get(homeServerWorkflowFile) ?? "").includes("zip -qr")) {
    errors.push(
      `${homeServerWorkflowFile}: home-server migration packaging bypasses the canonical invocation plan`,
    );
  }
  for (const file of [
    ".github/workflows/srn-client.yml",
    ".github/workflows/srn-server.yml",
  ]) {
    requireFragment(
      errors,
      file,
      files.get(file) ?? "",
      "- 'cli/.prettierrc'",
      "shared CLI release/check configuration trigger",
    );
  }

  const openClawWorkflowFile = ".github/workflows/srn-openclaw.yml";
  const openClawWorkflow = files.get(openClawWorkflowFile) ?? "";
  const openClawContract = RELEASE_PACKAGING_CONTRACTS.openclaw;
  for (const [fragment, description] of [
    [
      `attestBuildProvenance: "${openClawContract.actions.attestBuildProvenance}"`,
      "fingerprinted OpenClaw provenance action",
    ],
    [
      `"${openClawContract.provenance.bundleFilename}"`,
      "fingerprinted OpenClaw provenance bundle filename",
    ],
    [
      `checksumAlgorithm: "${openClawContract.provenance.checksumAlgorithm}"`,
      "fingerprinted OpenClaw provenance checksum algorithm",
    ],
    [
      `format: "${openClawContract.provenance.format}"`,
      "fingerprinted OpenClaw provenance format",
    ],
    [
      `predicate: "${openClawContract.provenance.predicate}"`,
      "fingerprinted OpenClaw provenance predicate",
    ],
    [
      `signerWorkflow: "${openClawContract.provenance.verification.signerWorkflow}"`,
      "fingerprinted OpenClaw signer workflow",
    ],
    [
      `sourceDigest: "${openClawContract.provenance.verification.sourceDigest}"`,
      "fingerprinted OpenClaw provenance source binding",
    ],
    [
      `repository: "${openClawContract.provenance.verification.repository}"`,
      "fingerprinted OpenClaw provenance repository binding",
    ],
  ]) {
    requireFragment(
      errors,
      packagingContractFile,
      packagingContract,
      fragment,
      description,
    );
  }
  for (const subject of openClawContract.provenance.subjects) {
    requireFragment(
      errors,
      packagingContractFile,
      packagingContract,
      `"${subject}"`,
      `fingerprinted OpenClaw provenance subject '${subject}'`,
    );
  }
  const openClawImpact = jobBlock(openClawWorkflow, "impact");
  for (const [fragment, description] of [
    [
      "git fetch --no-tags --force origin refs/heads/main:refs/remotes/origin/main",
      "protected OpenClaw main fetch",
    ],
    [
      'protected_sha="$(git rev-parse "refs/remotes/origin/main^{commit}")"',
      "protected OpenClaw main commit",
    ],
    [
      'case "$GITHUB_EVENT_NAME:$GITHUB_REF_TYPE" in',
      "explicit OpenClaw source classifier",
    ],
    ["push:branch)", "OpenClaw protected branch source"],
    ["push:tag)", "OpenClaw protected pushed-tag source"],
    ["workflow_dispatch:branch)", "OpenClaw protected manual branch source"],
    ["workflow_dispatch:tag)", "OpenClaw protected manual tag source"],
    [
      '[[ "$tag" =~ ^srn-openclaw-v[0-9A-Za-z.+-]+$ ]]',
      "build-metadata-capable OpenClaw source tag authorization",
    ],
    [
      'test "$GITHUB_SHA" = "$protected_sha"',
      "exact protected OpenClaw main commit",
    ],
    ['test "$tagged_sha" = "$GITHUB_SHA"', "exact OpenClaw tag commit"],
    [
      'git merge-base --is-ancestor "$tagged_sha" "$protected_sha"',
      "OpenClaw tag ancestry from protected main",
    ],
    [
      'test "$REQUESTED_TAG" = "$GITHUB_REF_NAME"',
      "manual OpenClaw tag/ref equality",
    ],
    [
      'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
      "checked-out OpenClaw source equality",
    ],
    [
      "EXCLUDED_RELEASE_REF: ${{ startsWith(github.ref, 'refs/tags/srn-openclaw-v') && github.ref_name || (github.event_name == 'workflow_dispatch' && inputs.tag) || '' }}",
      "explicit OpenClaw release-ref exclusion",
    ],
    [
      '--exclude-release-ref "${excluded_release_ref}"',
      "explicit OpenClaw self-tag exclusion forwarding",
    ],
    [
      'retry_intent="forced-${GITHUB_RUN_ID}"',
      "forced OpenClaw retry exclusion intent",
    ],
    ['retry_intent="automatic"', "automatic OpenClaw retry exclusion intent"],
    ["mapfile -t retry_tags", "same-intent OpenClaw retry release discovery"],
    [
      "Multiple OpenClaw releases match this commit and retry intent.",
      "ambiguous OpenClaw retry release rejection",
    ],
  ]) {
    requireFragment(
      errors,
      openClawWorkflowFile,
      openClawImpact,
      fragment,
      description,
    );
  }
  for (const [fragment, description] of [
    ["branches: [main]", "OpenClaw auto-release trigger on main"],
    ['- "openclaw/**"', "OpenClaw workspace release trigger path"],
    ['- "srn-openclaw-v*"', "OpenClaw explicit release tag trigger"],
    ["workflow_dispatch:", "manual OpenClaw release trigger"],
    [
      `NODE_VERSION: "${openClawContract.nodeVersion}"`,
      "contract-bound Node release runtime",
    ],
    [
      `YARN_VERSION: "${openClawContract.packageManager.split("@")[1]}"`,
      "contract-bound Yarn release version",
    ],
    [
      `COREPACK_VERSION: "${openClawContract.corepackVersion}"`,
      "contract-bound Corepack release version",
    ],
    [
      '- "scripts/release-packaging-contract.mjs"',
      "OpenClaw packaging contract trigger",
    ],
    ["yarn install --immutable", "immutable workspace install"],
    [
      "yarn workspace @standard-red-notes/openclaw test:e2e",
      "real OpenClaw live MCP E2E gate",
    ],
    [
      "node openclaw/scripts/package-release.mjs",
      "OpenClaw release packaging command",
    ],
    ["-node-any.tgz", "platform-neutral Node package name"],
    [
      "sha256sum --check SHA256SUMS.txt",
      "strict OpenClaw checksum verification",
    ],
    [
      "node openclaw/scripts/verify-release.mjs",
      "packaged OpenClaw executable verification",
    ],
    [
      `actions/attest-build-provenance@${openClawContract.actions.attestBuildProvenance}`,
      "pinned OpenClaw build provenance action",
    ],
    [
      "needs: [context, package, decide, smoke]",
      "all-target OpenClaw identity fan-in",
    ],
    [
      'gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"',
      "reserved OpenClaw draft publication",
    ],
  ]) {
    requireFragment(
      errors,
      openClawWorkflowFile,
      openClawWorkflow,
      fragment,
      description,
    );
  }
  for (const [action, reference] of Object.entries(openClawContract.actions)) {
    const owner = OPENCLAW_ACTION_OWNERS[action];
    requireFragment(
      errors,
      openClawWorkflowFile,
      openClawWorkflow,
      `${owner}@${reference}`,
      `contract-bound OpenClaw ${action} action`,
    );
    requireFragment(
      errors,
      openClawWorkflowFile,
      openClawWorkflow,
      `${owner}@${reference} # ${openClawContract.actionVersions[action]}`,
      `version-labelled immutable OpenClaw ${action} action`,
    );
    requireFragment(
      errors,
      packagingContractFile,
      openClawPackagingContract,
      `${action}: "${reference}"`,
      `fingerprinted OpenClaw ${action} action SHA`,
    );
    requireFragment(
      errors,
      packagingContractFile,
      openClawPackagingContract,
      `${action}: "${openClawContract.actionVersions[action]}"`,
      `validated human label for OpenClaw ${action} action SHA`,
    );
  }
  validateImmutableActionAllowlist(errors, {
    actionOwners: OPENCLAW_ACTION_OWNERS,
    actions: openClawContract.actions,
    actionVersions: openClawContract.actionVersions,
    file: openClawWorkflowFile,
    workflow: openClawWorkflow,
  });
  const openClawAction = (name) =>
    `${OPENCLAW_ACTION_OWNERS[name]}@${openClawContract.actions[name]}`;
  for (const [job, sequence] of Object.entries({
    impact: [openClawAction("checkout"), openClawAction("setupNode")],
    context: [openClawAction("checkout"), openClawAction("setupNode")],
    quality: [
      openClawAction("checkout"),
      openClawAction("setupNode"),
      openClawAction("uploadArtifact"),
    ],
    package: [
      openClawAction("checkout"),
      openClawAction("setupNode"),
      openClawAction("downloadArtifact"),
      openClawAction("uploadArtifact"),
    ],
    decide: [openClawAction("checkout")],
    smoke: [
      openClawAction("checkout"),
      openClawAction("setupNode"),
      openClawAction("downloadArtifact"),
    ],
    identity: [openClawAction("checkout")],
    attest: [
      openClawAction("downloadArtifact"),
      openClawAction("attestBuildProvenance"),
      openClawAction("uploadArtifact"),
    ],
    release: [openClawAction("checkout"), openClawAction("downloadArtifact")],
  })) {
    requireExactJobActionSequence(
      errors,
      openClawWorkflowFile,
      openClawWorkflow,
      job,
      sequence,
    );
  }
  for (const [job, integrityStep, consumerStep] of [
    ["quality", "Smoke-test built CLI", "Upload tested OpenClaw build"],
    [
      "package",
      "Fingerprint normalized package payload",
      "Upload release package",
    ],
    [
      "attest",
      "Add provenance bundle and verify final checksums",
      "Upload attested release package",
    ],
  ]) {
    requireAdjacentNamedSteps(
      errors,
      openClawWorkflowFile,
      openClawWorkflow,
      job,
      integrityStep,
      consumerStep,
    );
  }
  const openClawSmokeBuildStep = namedStepBlock(
    jobBlock(openClawWorkflow, "quality"),
    "Smoke-test built CLI",
  );
  if (
    !openClawSmokeBuildStep
      .trimEnd()
      .endsWith("node openclaw/dist/index.js --help")
  ) {
    errors.push(
      `${openClawWorkflowFile}: OpenClaw build smoke test must be terminal before upload`,
    );
  }
  for (const uploadStep of actionStepBlocks(
    openClawWorkflow,
    openClawAction("uploadArtifact"),
  )) {
    if (!uploadStep.includes("retention-days: 30")) {
      errors.push(
        `${openClawWorkflowFile}: every OpenClaw recovery artifact must be retained for exactly 30 days`,
      );
    }
  }
  for (const jobName of ["identity", "attest", "release"]) {
    requireFragment(
      errors,
      openClawWorkflowFile,
      jobBlock(openClawWorkflow, jobName),
      "environment: release-production",
      `${jobName} protected production environment`,
    );
  }
  if (
    countOccurrences(openClawWorkflow, "environment: release-production") !== 3
  ) {
    errors.push(
      `${openClawWorkflowFile}: OpenClaw production environment must be scoped exactly to identity, attestation, and release`,
    );
  }
  const openClawFingerprintStep = namedStepBlock(
    jobBlock(openClawWorkflow, "package"),
    "Fingerprint normalized package payload",
  );
  if (
    !openClawFingerprintStep
      .trimEnd()
      .endsWith(`grep -Eq '^[0-9a-f]{64}$' "out/\${TOOL}.fingerprint"`)
  ) {
    errors.push(
      `${openClawWorkflowFile}: OpenClaw fingerprint check must be terminal before package upload`,
    );
  }
  const openClawFinalAttestationStep = namedStepBlock(
    jobBlock(openClawWorkflow, "attest"),
    "Add provenance bundle and verify final checksums",
  );
  if (
    !openClawFinalAttestationStep
      .trimEnd()
      .endsWith("(cd out && sha256sum --check SHA256SUMS.txt)")
  ) {
    errors.push(
      `${openClawWorkflowFile}: OpenClaw provenance and checksum verification must be terminal before attested upload`,
    );
  }
  if (
    countOccurrences(
      openClawWorkflow,
      `uses: ${openClawAction("checkout")}`,
    ) !== countOccurrences(openClawWorkflow, "persist-credentials: false")
  ) {
    errors.push(
      `${openClawWorkflowFile}: every OpenClaw checkout must explicitly disable credential persistence`,
    );
  }
  if (
    countOccurrences(
      openClawWorkflow,
      `uses: ${openClawAction("uploadArtifact")}`,
    ) !== countOccurrences(openClawWorkflow, "if-no-files-found: error")
  ) {
    errors.push(
      `${openClawWorkflowFile}: every OpenClaw artifact upload must fail when empty`,
    );
  }

  // OpenClaw releases itself on every push to main, versioned and tagged like
  // every other srn-* component: rolling `YY.N` discovered from the existing
  // releases, published under a NAMESPACED `srn-openclaw-v<version>` tag. A bare
  // `v<version>` tag would take the repo-global tag namespace and the "Latest"
  // release badge away from srn-desktop.
  const openClawContext = jobBlock(openClawWorkflow, "context");
  if (!openClawContext) {
    errors.push(`${openClawWorkflowFile}: missing OpenClaw version job`);
  } else {
    for (const [fragment, description] of [
      ['version="${YY}.${next}"', "rolling YY.N OpenClaw version"],
      [
        'while git show-ref --verify --quiet "refs/tags/${TOOL}-v${YY}.${next}.0"; do',
        "explicit SemVer package-version reservation",
      ],
      ['tag="${TOOL}-v${version}"', "namespaced OpenClaw release tag"],
      [
        'if [[ ! "${tag}" =~ ^srn-openclaw-v[0-9A-Za-z.+-]+$ ]]; then',
        "build-metadata-capable authoritative OpenClaw tag gate",
      ],
      ["parse_explicit_version() {", "central OpenClaw SemVer parser helper"],
      [
        'version="$(parse_explicit_version "${tag}")"',
        "initial explicit OpenClaw tag parsing",
      ],
      [
        'elif package_version="$(parse_explicit_version "${tag}")"; then',
        "recovered explicit OpenClaw tag parsing",
      ],
      // openclaw/scripts/release-config.mjs only accepts a strict
      // `srn-openclaw-v<semver>` tag, and the release identity `YY.N` is not
      // semver, so the packaged artifact's version is computed separately.
      [
        'package_version="${version}.0"',
        "semver package version for packaging",
      ],
      // The explicit-tag escape hatch must keep asserting that the tag it was
      // handed is the version openclaw/package.json declares.
      [
        'if [ "${version}" != "${declared_version}" ]; then',
        "explicit-tag version assertion against openclaw/package.json",
      ],
      [
        'intent="forced-${GITHUB_RUN_ID}"',
        "invocation-stable forced OpenClaw intent",
      ],
      ['intent="automatic"', "automatic OpenClaw retry intent"],
      ['intent="explicit-${tag}"', "explicit-tag OpenClaw intent"],
      [
        "force_release cannot be combined with an explicit OpenClaw tag.",
        "force and explicit-tag mutual exclusion",
      ],
      [".headSha == $sha", "analyzed OpenClaw source-commit assertion"],
      [".forced == $forced", "analyzed OpenClaw force-state assertion"],
      [
        "(($forced | not) and .forceReason == null)",
        "unforced OpenClaw null-reason assertion",
      ],
      [
        '(.forceReason | gsub("^\\\\s+|\\\\s+$"; "")) | length > 0',
        "forced OpenClaw nonempty-reason assertion",
      ],
      [
        'gh api "repos/${GITHUB_REPOSITORY}/releases?per_page=100" --paginate --slurp',
        "complete OpenClaw release inventory",
      ],
      ["mapfile -t reservations", "matching OpenClaw reservation recovery"],
      ["mapfile -t stale_reservations", "stale OpenClaw draft enumeration"],
      [
        "Reconcile or delete the stale drafts explicitly, then rerun.",
        "stale OpenClaw draft recovery instruction",
      ],
      [
        ".draft == true or .draft == false",
        "draft or published OpenClaw recovery state",
      ],
      [
        `published="$(jq -r '.draft | not' <<< "$release")"`,
        "published OpenClaw recovery output",
      ],
      [
        'git tag --list "${prefix}*"',
        "complete rolling OpenClaw tag inventory",
      ],
      [
        ".[] | .tag_name | select(startswith($prefix))",
        "draft-aware rolling OpenClaw release inventory",
      ],
    ]) {
      requireFragment(
        errors,
        openClawWorkflowFile,
        openClawContext,
        fragment,
        description,
      );
    }
    if (/\btag="?v\$\{version\}/.test(openClawContext)) {
      errors.push(
        `${openClawWorkflowFile}: OpenClaw must not publish an unnamespaced v* tag`,
      );
    }
    if (openClawContext.includes("GITHUB_RUN_ATTEMPT")) {
      errors.push(
        `${openClawWorkflowFile}: forced OpenClaw identity must remain stable across rerun attempts`,
      );
    }
  }

  // The rolling identity is not semver, so package-release.mjs is handed the
  // semver packaging tag, and the matching version is stamped into the manifest
  // it asserts that tag against. Packaging the release identity directly would
  // fail; packaging without the stamp would silently ship the placeholder
  // development version.
  const openClawPackageJob = jobBlock(openClawWorkflow, "package");
  if (!openClawPackageJob) {
    errors.push(`${openClawWorkflowFile}: missing OpenClaw package job`);
  } else {
    for (const [fragment, description] of [
      [
        '--tag "${{ needs.context.outputs.package_tag }}"',
        "semver packaging tag",
      ],
      [
        "manifest.version = process.env.PACKAGE_VERSION",
        "release version stamped into the packaged manifest",
      ],
      [
        "--normalize-package-version package/package.json",
        "rolling package-version normalization",
      ],
      [
        "node scripts/release-packaging-contract.mjs",
        "canonical OpenClaw packaging contract fingerprint",
      ],
      ["--contract openclaw", "OpenClaw packaging contract selection"],
      [
        "--path .srn-release-contract",
        "OpenClaw package implementation inputs",
      ],
      [
        "--normalize-json-field package/release-package.json=/release/sourceCommit",
        "volatile source-commit normalization",
      ],
      [
        "--normalize-json-field package/release-package.json=/release/sourceDate",
        "volatile source-date normalization",
      ],
      [
        "--normalize-json-field package/release-package.json=/release/tag",
        "volatile release-tag normalization",
      ],
      [
        "--normalize-json-field package/release-package.json=/release/version",
        "volatile release-version normalization",
      ],
      [
        '--output "out/${TOOL}.fingerprint"',
        "normalized OpenClaw package fingerprint asset",
      ],
    ]) {
      requireFragment(
        errors,
        openClawWorkflowFile,
        openClawPackageJob,
        fragment,
        description,
      );
    }
    if (openClawPackageJob.includes("--exclude package/release-package.json")) {
      errors.push(
        `${openClawWorkflowFile}: shipped release-package.json must not be excluded wholesale`,
      );
    }
  }

  const openClawSmoke = jobBlock(openClawWorkflow, "smoke");
  if (!openClawSmoke) {
    errors.push(
      `${openClawWorkflowFile}: missing native OpenClaw package smoke matrix`,
    );
  } else {
    requireFragment(
      errors,
      openClawWorkflowFile,
      openClawSmoke,
      "fail-fast: false",
      "complete OpenClaw smoke matrix",
    );
    requireFragment(
      errors,
      openClawWorkflowFile,
      openClawSmoke,
      "if: needs.decide.outputs.changed == 'true'",
      "unchanged OpenClaw smoke skip",
    );
    for (const [target, runner, architecture] of OPENCLAW_SMOKE_TARGETS) {
      const declaration =
        `- target: ${target}\n` +
        `            runner: ${runner}\n` +
        `            architecture: ${architecture}`;
      const count = countOccurrences(openClawSmoke, declaration);
      if (count !== 1) {
        errors.push(
          `${openClawWorkflowFile}: expected one ${target} smoke target on ${runner}, found ${count}`,
        );
      }
    }
  }

  const openClawIdentity = jobBlock(openClawWorkflow, "identity");
  if (!openClawIdentity) {
    errors.push(
      `${openClawWorkflowFile}: missing retry-safe OpenClaw release identity job`,
    );
  } else {
    for (const [fragment, description] of [
      [
        "needs: [context, package, decide, smoke]",
        "smoke-tested OpenClaw identity fan-in",
      ],
      [
        "if: needs.decide.outputs.changed == 'true'",
        "unchanged OpenClaw identity guard",
      ],
      ["contents: write", "OpenClaw draft reservation permission"],
      ["persist-credentials: false", "nonpersisted OpenClaw draft write token"],
      [
        "EXPECTED_FINGERPRINT: ${{ needs.package.outputs.fingerprint }}",
        "exact OpenClaw package fingerprint input",
      ],
      [
        "EXISTING_RELEASE_ID: ${{ needs.context.outputs.release_id }}",
        "recovered OpenClaw release ID input",
      ],
      [
        "INTENT: ${{ needs.context.outputs.intent }}",
        "recovered OpenClaw release intent input",
      ],
      [
        "SOURCE_SHA: ${{ needs.context.outputs.source_sha }}",
        "exact OpenClaw source input",
      ],
      [
        "<!-- srn-release-reservation tool=${TOOL} commit=${SOURCE_SHA} fingerprint=${EXPECTED_FINGERPRINT} intent=${INTENT} -->",
        "OpenClaw commit-fingerprint-intent marker",
      ],
      [
        "mapfile -t stale_reservations",
        "fingerprint-mismatched OpenClaw draft enumeration",
      ],
      [
        "Refusing to publish past stale or fingerprint-mismatched OpenClaw drafts:",
        "fingerprint-mismatched OpenClaw draft fail-closed gate",
      ],
      [
        "mapfile -t exact_reservations",
        "live exact OpenClaw reservation recovery",
      ],
      [
        'elif [ "${#exact_reservations[@]}" -eq 1 ]; then',
        "failed-job OpenClaw reservation adoption",
      ],
      [
        'release_id="${exact_reservations[0]}"',
        "live OpenClaw reservation ID adoption",
      ],
      [
        "Multiple exact OpenClaw reservations match this release identity.",
        "ambiguous exact OpenClaw reservation rejection",
      ],
      [
        'gh api --method POST "repos/${GITHUB_REPOSITORY}/releases"',
        "draft-only OpenClaw reservation",
      ],
      ['-f target_commitish="$SOURCE_SHA"', "exact OpenClaw draft target"],
      [
        '-f name="${TOOL} ${VERSION}"',
        "srn-* OpenClaw release title convention",
      ],
      ["-F draft=true", "OpenClaw draft-only creation"],
      [
        "Draft reservation response was ambiguous. Rerun failed jobs; identity will adopt the exact live marker.",
        "ambiguous OpenClaw reservation recovery instruction",
      ],
      [
        ".draft == true or .draft == false",
        "same-intent OpenClaw draft or publication recovery",
      ],
      [
        `published="$(jq -r '.draft | not' <<< "$release")"`,
        "OpenClaw published-state output",
      ],
      ['echo "release_id=${release_id}"', "OpenClaw release ID handoff"],
      ['echo "published=${published}"', "OpenClaw publication state handoff"],
    ]) {
      requireFragment(
        errors,
        openClawWorkflowFile,
        openClawIdentity,
        fragment,
        description,
      );
    }
    if (/^\s*gh release create\b/m.test(openClawIdentity)) {
      errors.push(
        `${openClawWorkflowFile}: OpenClaw identity must reserve a draft through the exact release API`,
      );
    }
  }

  // Signing and publishing are separate jobs because permissions are per-job:
  // the attester signs with the Sigstore/attestation scopes and only reads the
  // repository, the publisher writes with nothing but `contents: write`.
  const openClawAttest = jobBlock(openClawWorkflow, "attest");
  if (!openClawAttest) {
    errors.push(`${openClawWorkflowFile}: missing OpenClaw attestation job`);
  } else {
    for (const [fragment, description] of [
      [
        "needs: [context, package, decide, identity]",
        "reserved OpenClaw attestation fan-in",
      ],
      [
        "if: needs.decide.outputs.changed == 'true' && needs.identity.outputs.published != 'true'",
        "already-published OpenClaw attestation skip",
      ],
      ["artifact-metadata: write", "artifact metadata permission"],
      ["attestations: write", "attestation permission"],
      ["id-token: write", "provenance signing permission"],
      [
        `actions/attest-build-provenance@${openClawContract.actions.attestBuildProvenance}`,
        "contract-bound provenance action",
      ],
      ["outputs.bundle-path", "published Sigstore provenance bundle"],
      [
        openClawContract.provenance.bundleFilename.replace(
          "<package-version>",
          "${{ needs.context.outputs.package_version }}",
        ),
        "contract-bound provenance bundle filename",
      ],
      ['sha256sum "${provenance}" >> SHA256SUMS.txt', "provenance checksum"],
      [
        "LC_ALL=C sort -o SHA256SUMS.txt SHA256SUMS.txt",
        "canonical OpenClaw checksum identity",
      ],
      // The attested payload is exactly what gets published, so it must reach
      // the publisher intact and an empty handoff must fail the job rather than
      // publish a release with no artifacts.
      [
        "name: srn-openclaw-attested-package",
        "attested payload handoff to the publisher",
      ],
      ["if-no-files-found: error", "required attested payload upload"],
      [
        'gh attestation verify "out/${subject}"',
        "cryptographic attested-payload verification",
      ],
      [
        '--bundle "out/${provenance}"',
        "exact attested-payload provenance bundle verification",
      ],
      ['--repo "$GITHUB_REPOSITORY"', "exact OpenClaw repository binding"],
      [
        '--source-digest "${{ needs.context.outputs.source_sha }}"',
        "exact OpenClaw source-digest binding",
      ],
      [
        '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/srn-openclaw.yml"',
        "exact OpenClaw signer-workflow binding",
      ],
    ]) {
      requireFragment(
        errors,
        openClawWorkflowFile,
        openClawAttest,
        fragment,
        description,
      );
    }
    for (const subject of openClawContract.provenance.subjects) {
      requireFragment(
        errors,
        openClawWorkflowFile,
        openClawAttest,
        `out/${subject.replace(
          "<package-version>",
          "${{ needs.context.outputs.package_version }}",
        )}`,
        "contract-bound provenance subject",
      );
    }
  }

  const openClawRelease = jobBlock(openClawWorkflow, "release");
  for (const [fragment, description] of [
    [
      "needs: [context, package, decide, identity, attest]",
      "reserved and attested OpenClaw release fan-in",
    ],
    [
      "if: always() && needs.decide.outputs.changed == 'true' && needs.identity.result == 'success' && (needs.attest.result == 'success' || (needs.identity.outputs.published == 'true' && needs.attest.result == 'skipped'))",
      "retry-safe OpenClaw publication result gate",
    ],
    ["contents: write", "release publication permission"],
    [
      "persist-credentials: false",
      "nonpersisted OpenClaw publication write token",
    ],
    [
      "name: srn-openclaw-attested-package",
      "attested payload as the published payload",
    ],
    [
      "if: needs.identity.outputs.published != 'true'",
      "already-published OpenClaw artifact recovery branch",
    ],
    [
      "EXPECTED_FINGERPRINT: ${{ needs.package.outputs.fingerprint }}",
      "published OpenClaw fingerprint input",
    ],
    [
      "RELEASE_ID: ${{ needs.identity.outputs.release_id }}",
      "reserved OpenClaw release ID input",
    ],
    [
      "<!-- srn-release-reservation tool=${TOOL} commit=${SOURCE_SHA} fingerprint=${EXPECTED_FINGERPRINT} intent=${INTENT} -->",
      "publication OpenClaw commit-fingerprint-intent marker",
    ],
    [
      'echo "${TOOL}-${PACKAGE_VERSION}-node-any.provenance.sigstore.json"',
      "exact OpenClaw provenance asset identity",
    ],
    [
      "find \"$directory\" -maxdepth 1 -type f -printf '%f\\n' | LC_ALL=C sort",
      "exact local OpenClaw release inventory",
    ],
    [
      'diff -u "$expected_assets" "$actual_assets"',
      "exact local OpenClaw asset set assertion",
    ],
    [
      'LC_ALL=C sort -c "$directory/SHA256SUMS.txt"',
      "canonical OpenClaw checksum ordering assertion",
    ],
    [
      "sha256sum --check SHA256SUMS.txt",
      "attested payload re-verified before publication",
    ],
    [
      "tr -d '\\r\\n' < \"$directory/${TOOL}.fingerprint\"",
      "published OpenClaw fingerprint equality",
    ],
    [
      'gh attestation verify "${directory}/${subject}"',
      "cryptographic OpenClaw provenance verification",
    ],
    [
      '--bundle "${directory}/${provenance}"',
      "exact OpenClaw provenance bundle verification",
    ],
    [
      '--repo "$GITHUB_REPOSITORY"',
      "OpenClaw repository identity verification",
    ],
    [
      '--source-digest "$SOURCE_SHA"',
      "OpenClaw attested source-commit equality",
    ],
    [
      '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/srn-openclaw.yml"',
      "OpenClaw signer-workflow equality",
    ],
    ["jq -r '.assets[].name'", "exact remote OpenClaw asset inventory"],
    [
      ".assets[] | select(.name == $name) | .digest",
      "remote OpenClaw asset digest lookup",
    ],
    [
      '[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]',
      "remote OpenClaw SHA-256 digest assertion",
    ],
    [
      'test "$digest" = "sha256:${actual}"',
      "remote OpenClaw asset digest equality",
    ],
    [
      'gh api "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"',
      "exact OpenClaw release lookup by ID",
    ],
    [".target_commitish == $sha", "exact OpenClaw release target"],
    [
      ".draft == true or .draft == false",
      "OpenClaw draft or published retry state",
    ],
    [
      'if [ "$draft" = "false" ]; then',
      "already-published OpenClaw recovery branch",
    ],
    [
      'gh release download "$TAG" --dir "$recovered" --repo "$GITHUB_REPOSITORY"',
      "published OpenClaw asset recovery",
    ],
    [
      "<!-- srn-release-assets sha256=${asset_plan_sha} -->",
      "exact published OpenClaw asset-plan marker",
    ],
    [
      "was already published by this workflow intent; verified exact attested assets.",
      "ambiguous OpenClaw publication recovery evidence",
    ],
    [
      'gh api --method DELETE "repos/${GITHUB_REPOSITORY}/releases/assets/${asset_id}"',
      "unexpected OpenClaw draft asset cleanup",
    ],
    [
      'gh release upload "$TAG" "${files[@]}" --clobber --repo "$GITHUB_REPOSITORY"',
      "retry-safe OpenClaw asset replacement",
    ],
    [
      "Draft already contains an unexpected finalized asset marker.",
      "premature OpenClaw asset-marker rejection",
    ],
    [
      'gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"',
      "final OpenClaw draft publication",
    ],
    ['-f body="$final_body"', "final OpenClaw asset identity body"],
    ["-F draft=false", "final OpenClaw published state"],
    ["-f make_latest=false", "OpenClaw Latest-pointer opt-out"],
  ]) {
    requireFragment(
      errors,
      openClawWorkflowFile,
      openClawRelease,
      fragment,
      description,
    );
  }
  if (/^\s*gh release create\b/m.test(openClawRelease)) {
    errors.push(
      `${openClawWorkflowFile}: OpenClaw publication must reuse its reserved draft`,
    );
  }
  const openClawReleaseIdentityIndex = openClawRelease.indexOf(
    'jq -e --arg tag "$TAG"',
  );
  const openClawLocalVerificationIndex = openClawRelease.lastIndexOf(
    "verify_directory out",
  );
  const openClawUploadIndex = openClawRelease.indexOf("gh release upload");
  const openClawRemoteVerificationIndex =
    openClawRelease.lastIndexOf("verify_remote out");
  const openClawPublicationIndex = openClawRelease.indexOf(
    "gh api --method PATCH",
  );
  if (
    openClawReleaseIdentityIndex < 0 ||
    openClawLocalVerificationIndex <= openClawReleaseIdentityIndex ||
    openClawUploadIndex <= openClawLocalVerificationIndex ||
    openClawRemoteVerificationIndex <= openClawUploadIndex ||
    openClawPublicationIndex <= openClawRemoteVerificationIndex
  ) {
    errors.push(
      `${openClawWorkflowFile}: OpenClaw publication must validate identity, local assets, upload, verify remote digests, then publish`,
    );
  }
  // The publishing token must stay minimal: attestation scopes belong to the
  // attest job. Carrying them into the publisher is the shape whose
  // `gh release create` returned "HTTP 403: Resource not accessible by
  // integration" from POST /releases even though the runner reported
  // `Contents: write` on the token.
  for (const scope of [
    "artifact-metadata: write",
    "attestations: write",
    "id-token: write",
  ]) {
    if (openClawRelease.includes(scope)) {
      errors.push(
        `${openClawWorkflowFile}: the OpenClaw publish job must not request '${scope}'; ` +
          "publication needs contents: write only",
      );
    }
  }
  if (/sha256sum[^\n]*\|\|\s*true/.test(openClawWorkflow)) {
    errors.push(
      `${openClawWorkflowFile}: OpenClaw checksum failures must not be suppressed`,
    );
  }
  if (
    /srn-openclaw-[^"'\r\n]*-(?:windows|linux|macos)-(?:x64|arm64)\.(?:tgz|zip|tar\.gz)/.test(
      openClawWorkflow,
    )
  ) {
    errors.push(
      `${openClawWorkflowFile}: platform-neutral OpenClaw must not publish fake native archives`,
    );
  }

  const openClawPackageFile = "openclaw/package.json";
  const openClawPackage = JSON.parse(files.get(openClawPackageFile) ?? "{}");
  // `yarn install` rewrites workspace manifests in place, and Yarn 4 does not
  // serialize values that already match its defaults. `private: false` is
  // therefore dropped on every install, so an absent field is as publishable as
  // an explicit `false`; only an explicit `true` blocks the release.
  if (openClawPackage.private === true) {
    errors.push(`${openClawPackageFile}: release package must not be private`);
  }
  if (openClawPackage.engines?.node !== ">=26.0.0") {
    errors.push(
      `${openClawPackageFile}: release package must require Node >=26.0.0`,
    );
  }
  // Same install rewrite: a lone `bin` entry whose key equals the unscoped
  // package name collapses to the bare string form. Both spellings declare the
  // identical `openclaw` executable, and the target itself is still asserted.
  const openClawBin = openClawPackage.bin;
  const openClawUnscopedName = String(openClawPackage.name ?? "").replace(
    /^@[^/]+\//,
    "",
  );
  const openClawBinTarget =
    typeof openClawBin === "string"
      ? openClawUnscopedName === "openclaw"
        ? openClawBin
        : undefined
      : openClawBin?.openclaw;
  if (openClawBinTarget !== "dist/index.js") {
    errors.push(
      `${openClawPackageFile}: release package must expose bin.openclaw as dist/index.js`,
    );
  }
  for (const [field, expected] of [
    ["os", ["darwin", "linux", "win32"]],
    ["cpu", ["arm64", "x64"]],
  ]) {
    const actual = [...(openClawPackage[field] ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(
        `${openClawPackageFile}: ${field} release support must be ${expected.join(",")}`,
      );
    }
  }
  const runtimeDependencies = Object.keys(
    openClawPackage.dependencies ?? {},
  ).sort();
  const bundleDependencies = [
    ...(openClawPackage.bundleDependencies ?? []),
  ].sort();
  if (
    JSON.stringify(runtimeDependencies) !== JSON.stringify(bundleDependencies)
  ) {
    errors.push(
      `${openClawPackageFile}: every runtime dependency must be bundled`,
    );
  }
  if (
    openClawPackage.scripts?.["package:release"] !==
    "node scripts/package-release.mjs"
  ) {
    errors.push(
      `${openClawPackageFile}: package:release is not wired to the packaging script`,
    );
  }
  if (
    openClawPackage.scripts?.["verify:release"] !==
    "node scripts/verify-release.mjs"
  ) {
    errors.push(
      `${openClawPackageFile}: verify:release is not wired to the verifier`,
    );
  }

  const openClawConfigFile = "openclaw/scripts/release-config.mjs";
  const openClawConfig = files.get(openClawConfigFile) ?? "";
  for (const [target, runner, architecture] of OPENCLAW_SMOKE_TARGETS) {
    for (const [fragment, description] of [
      [`id: "${target}"`, `${target} release-config target`],
      [`runner: "${runner}"`, `${target} release-config runner`],
      [
        `architecture: "${architecture}"`,
        `${target} release-config architecture`,
      ],
    ]) {
      requireFragment(
        errors,
        openClawConfigFile,
        openClawConfig,
        fragment,
        description,
      );
    }
  }
  requireFragment(
    errors,
    openClawConfigFile,
    openClawConfig,
    "-node-any.tgz",
    "platform-neutral package filename",
  );
  requireFragment(
    errors,
    openClawConfigFile,
    openClawConfig,
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?",
    "full SemVer build-metadata release-tag grammar",
  );

  const openClawPackagerFile = "openclaw/scripts/package-release.mjs";
  const openClawPackager = files.get(openClawPackagerFile) ?? "";
  for (const [fragment, description] of [
    ["YARN_ENABLE_IMMUTABLE_INSTALLS", "locked production dependency staging"],
    ["YARN_NM_HOISTING_LIMITS", "workspace-local bundled dependency graph"],
    ['"pack"', "npm package creation"],
    [
      "platform-neutral package cannot contain native addons",
      "native addon rejection",
    ],
    // Yarn's node-modules linker writes node_modules/.bin/* as symlinks on
    // Linux, which the payload walk rejected outright, so no release could ever
    // be packaged. The allowance MUST stay scoped to `.bin`: skipping symlinks
    // anywhere would let the walk step over a link to a native addon and defeat
    // the rejection asserted directly above.
    [
      'entry.isSymbolicLink() && path.basename(directory) === ".bin"',
      "bin-shim-only symlink allowance",
    ],
    [
      "productionDependenciesBundled: true",
      "bundled dependency manifest assertion",
    ],
    ["SHA256SUMS.txt", "release checksum manifest"],
    // openclaw is a root yarn workspace, so an install can collapse its `bin`
    // map to the bare string form and that shape can be committed -- this
    // validator accepts it, so the packager must too, or a manifest that passes
    // the contract would fail the release. The string form stays scoped to the
    // `openclaw` executable, and the target is still asserted.
    [
      'unscopedName === "openclaw"',
      "bin string form scoped to the openclaw executable",
    ],
    [
      "package bin.openclaw must point to dist/index.js",
      "packaged bin target assertion",
    ],
  ]) {
    requireFragment(
      errors,
      openClawPackagerFile,
      openClawPackager,
      fragment,
      description,
    );
  }
  // Count-based, like the Latest-pointer opt-out: a broadened or additional
  // symlink branch that is not scoped to `.bin` must fail even though the
  // scoped one above is still present.
  const symlinkAllowances = countOccurrences(
    openClawPackager,
    "entry.isSymbolicLink()",
  );
  const binScopedAllowances = countOccurrences(
    openClawPackager,
    'entry.isSymbolicLink() && path.basename(directory) === ".bin"',
  );
  if (symlinkAllowances !== binScopedAllowances) {
    errors.push(
      `${openClawPackagerFile}: ${symlinkAllowances} symlink allowance(s) but ` +
        `${binScopedAllowances} scoped to .bin; a release payload walk that skips ` +
        "symlinks outside .bin can step over a native addon",
    );
  }

  const openClawVerifierFile = "openclaw/scripts/verify-release.mjs";
  const openClawVerifier = files.get(openClawVerifierFile) ?? "";
  for (const [fragment, description] of [
    ['"--offline"', "offline package install"],
    ['"--engine-strict"', "strict Node engine validation"],
    ['"ls", "--global"', "installed dependency-tree validation"],
    ["process.platform !== target.platform", "native platform assertion"],
    ["process.arch !== target.architecture", "native architecture assertion"],
    ["direct packaged entrypoint", "direct CLI entrypoint smoke test"],
    ["installed OpenClaw shim", "npm-generated executable shim smoke test"],
    // The packaged manifest inherits the workspace manifest's `bin` spelling,
    // so the installed-package guard tolerates the same two shapes as the
    // packager and this validator -- and no more.
    [
      'unscopedName === "openclaw"',
      "bin string form scoped to the openclaw executable",
    ],
    [
      'binTarget(packageJson) !== "dist/index.js"',
      "installed bin target assertion",
    ],
  ]) {
    requireFragment(
      errors,
      openClawVerifierFile,
      openClawVerifier,
      fragment,
      description,
    );
  }

  const rootDesktopFile = ".github/workflows/srn-desktop.yml";
  const rootDesktop = files.get(rootDesktopFile) ?? "";
  const rootDesktopPackageFile = "app/packages/desktop/package.json";
  const rootDesktopPackage = files.get(rootDesktopPackageFile) ?? "";
  const rootDesktopNotarizeFile = "app/packages/desktop/scripts/notarizeMac.js";
  const rootDesktopNotarize = files.get(rootDesktopNotarizeFile) ?? "";
  const rootDesktopWindowsSignFile =
    "app/packages/desktop/scripts/windowsSign.js";
  const rootDesktopWindowsSign = files.get(rootDesktopWindowsSignFile) ?? "";
  const rootDesktopEntitlementsFile =
    "app/packages/desktop/build/entitlements.mac.inherit.plist";
  const rootDesktopEntitlements = files.get(rootDesktopEntitlementsFile) ?? "";
  try {
    const rootDesktopManifest = JSON.parse(rootDesktopPackage);
    if (rootDesktopManifest.devDependencies?.["@electron/asar"] !== "3.4.1") {
      errors.push(
        `${rootDesktopPackageFile}: missing exact direct @electron/asar 3.4.1 devDependency`,
      );
    }
    if (rootDesktopManifest.build?.nsis?.buildUniversalInstaller !== false) {
      errors.push(
        `${rootDesktopPackageFile}: missing disabled universal Windows installer`,
      );
    }
    if (rootDesktopManifest.build?.afterSign !== "scripts/notarizeMac.js") {
      errors.push(
        `${rootDesktopPackageFile}: macOS afterSign must use the fail-closed notarization hook`,
      );
    }
    if (
      rootDesktopManifest.build?.win?.signtoolOptions?.sign !==
      "./scripts/windowsSign.js"
    ) {
      errors.push(
        `${rootDesktopPackageFile}: Windows signtoolOptions must use the fail-closed signing hook`,
      );
    }
  } catch {
    errors.push(`${rootDesktopPackageFile}: invalid desktop package manifest`);
  }
  for (const [fragment, description] of [
    [
      "env.REQUIRE_DESKTOP_AUTHENTICITY === 'true'",
      "explicit production notarization mode",
    ],
    ["throw new Error(message)", "production Apple credential failure"],
    [
      "await electronNotarize.notarize({",
      "awaited Apple notarization submission",
    ],
    [
      "await electronNotarize.staple({ appPath })",
      "awaited Apple notarization ticket stapling",
    ],
  ]) {
    requireFragment(
      errors,
      rootDesktopNotarizeFile,
      rootDesktopNotarize,
      fragment,
      description,
    );
  }
  if (/\.notarize\([^)]*\)\s*\.then\(/s.test(rootDesktopNotarize)) {
    errors.push(
      `${rootDesktopNotarizeFile}: notarization must not escape the awaited afterSign hook`,
    );
  }
  for (const [fragment, description] of [
    [
      "env.REQUIRE_DESKTOP_AUTHENTICITY === 'true'",
      "explicit production Windows signing mode",
    ],
    ["throw new Error(message)", "production Windows credential failure"],
    ["execFileSync", "shell-free Windows signer invocation"],
    ["'--keypair-alias'", "separate Windows signer alias argument"],
    ["'--input'", "separate Windows signer input argument"],
  ]) {
    requireFragment(
      errors,
      rootDesktopWindowsSignFile,
      rootDesktopWindowsSign,
      fragment,
      description,
    );
  }
  if (/\bexecSync\s*\(/.test(rootDesktopWindowsSign)) {
    errors.push(
      `${rootDesktopWindowsSignFile}: Windows signing must not interpolate credentials or paths into a shell command`,
    );
  }
  for (const [fragment, description] of [
    ["<key>com.apple.security.cs.allow-jit</key>", "Electron JIT entitlement"],
    ["<key>com.apple.security.device.camera</key>", "camera entitlement"],
  ]) {
    requireFragment(
      errors,
      rootDesktopEntitlementsFile,
      rootDesktopEntitlements,
      fragment,
      description,
    );
  }
  const desktopContract = RELEASE_PACKAGING_CONTRACTS.desktop;
  for (const [fragment, description] of [
    ["- 'app/packages/**'", "packaged app workspace trigger"],
    [
      "- 'app/scripts/verify-desktop-updater-metadata.rb'",
      "desktop updater verifier trigger",
    ],
    ["builder: '--mac dmg zip --x64 --arm64'", "macOS x64+arm64 build leg"],
    ["builder: '--win nsis --x64 --arm64'", "Windows x64+arm64 build leg"],
    ["builder: '--linux AppImage deb --x64'", "Linux x64 build leg"],
    ["builder: '--linux AppImage deb --arm64'", "Linux arm64 build leg"],
    [
      /label:\s*linux-x64,\s*\r?\n\s*os:\s*ubuntu-latest,\s*\r?\n\s*builder:\s*["']--linux AppImage deb --x64["'],\s*\r?\n\s*target_arch:\s*x64,/,
      "Linux x64 native prebuild target",
    ],
    [
      /label:\s*linux-arm64,\s*\r?\n\s*os:\s*ubuntu-24\.04-arm,\s*\r?\n\s*builder:\s*["']--linux AppImage deb --arm64["'],\s*\r?\n\s*target_arch:\s*arm64,/,
      "Linux arm64 native prebuild target",
    ],
    [
      "name: srn-desktop-${{ matrix.label }}",
      "per-leg desktop artifact upload",
    ],
    ["name: srn-desktop-release-payload", "desktop release artifact fan-in"],
    [
      `actions/setup-python@${desktopContract.actions.setupPython}`,
      "contract-bound desktop Python action",
    ],
    [
      `python-version: '${desktopContract.rootPythonVersion}'`,
      "contract-bound root desktop Python version",
    ],
  ]) {
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktop,
      fragment,
      description,
    );
  }
  const rootDesktopImpact = jobBlock(rootDesktop, "impact");
  for (const [fragment, description] of [
    [
      "git fetch --no-tags --force origin refs/heads/main:refs/remotes/origin/main",
      "protected desktop main fetch",
    ],
    [
      'protected_sha="$(git rev-parse "refs/remotes/origin/main^{commit}")"',
      "protected desktop main commit",
    ],
    [
      'test "$GITHUB_REF" = refs/heads/main',
      "exact desktop main ref authorization",
    ],
    [
      'test "$GITHUB_SHA" = "$protected_sha"',
      "exact protected desktop commit authorization",
    ],
  ]) {
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktopImpact,
      fragment,
      description,
    );
  }
  for (const jobName of ["identity", "build", "discard_unchanged", "release"]) {
    requireFragment(
      errors,
      rootDesktopFile,
      jobBlock(rootDesktop, jobName),
      "environment: release-production",
      `${jobName} protected production environment`,
    );
  }
  if (countOccurrences(rootDesktop, "environment: release-production") !== 4) {
    errors.push(
      `${rootDesktopFile}: desktop production environment must be scoped exactly to identity, authenticated build, unchanged-draft deletion, and release`,
    );
  }

  for (const value of [
    ...desktopContract.rootTargets,
    ...desktopContract.rootRunners,
  ]) {
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktop,
      value,
      "contract-bound desktop target or runner",
    );
  }
  for (const name of [
    "checkout",
    "downloadArtifact",
    "setupNode",
    "setupPython",
    "uploadArtifact",
  ]) {
    const owner = DESKTOP_ACTION_OWNERS[name];
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktop,
      `${owner}@${desktopContract.actions[name]}`,
      `contract-bound desktop ${name} action`,
    );
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktop,
      `${owner}@${desktopContract.actions[name]} # ${desktopContract.actionVersions[name]}`,
      `version-labelled immutable desktop ${name} action`,
    );
  }
  validateImmutableActionAllowlist(errors, {
    actionOwners: DESKTOP_ACTION_OWNERS,
    actions: desktopContract.actions,
    actionVersions: desktopContract.actionVersions,
    file: rootDesktopFile,
    workflow: rootDesktop,
  });
  for (const name of Object.keys(DESKTOP_ACTION_OWNERS)) {
    requireFragment(
      errors,
      packagingContractFile,
      desktopPackagingContract,
      `${name}: "${desktopContract.actions[name]}"`,
      `fingerprinted desktop ${name} action SHA`,
    );
    requireFragment(
      errors,
      packagingContractFile,
      desktopPackagingContract,
      `${name}: "${desktopContract.actionVersions[name]}"`,
      `validated human label for desktop ${name} action SHA`,
    );
  }

  const rootDesktopIdentity = jobBlock(rootDesktop, "identity");
  for (const [fragment, description] of [
    ["needs: impact", "desktop identity dependency on impact analysis"],
    [
      "if: needs.impact.outputs.changed == 'true'",
      "desktop identity source-impact guard",
    ],
    ["contents: write", "desktop draft reservation permission"],
    ["persist-credentials: false", "nonpersisted desktop write token"],
    [
      "version: ${{ steps.identity.outputs.version }}",
      "desktop version output",
    ],
    [
      "app_version: ${{ steps.identity.outputs.app_version }}",
      "desktop semver app-version output",
    ],
    [
      "release_id: ${{ steps.identity.outputs.release_id }}",
      "desktop release ID output",
    ],
    [
      "published: ${{ steps.identity.outputs.published }}",
      "desktop published-state output",
    ],
    ["FORCED: ${{ needs.impact.outputs.forced }}", "desktop force-state input"],
    [
      "IMPACT_RESULT: ${{ needs.impact.outputs.result_json }}",
      "desktop impact evidence input",
    ],
    [".headSha == $sha", "desktop impact commit assertion"],
    [".forced == $forced", "desktop impact force assertion"],
    [
      'intent="forced-${GITHUB_RUN_ID}"',
      "invocation-stable forced desktop intent",
    ],
    ["intent=automatic", "automatic desktop retry intent"],
    [
      "<!-- srn-release-reservation tool=${TOOL} commit=${GITHUB_SHA} intent=${intent} -->",
      "desktop commit-intent reservation marker",
    ],
    [
      'gh api "repos/${GITHUB_REPOSITORY}/releases?per_page=100" --paginate --slurp',
      "complete desktop release inventory",
    ],
    ["mapfile -t stale_reservations", "stale desktop draft enumeration"],
    ['git tag --list "${prefix}*"', "complete desktop tag inventory"],
    [
      ".[] | select(.tag_name | startswith($prefix))",
      "draft-aware desktop version inventory",
    ],
    ['version="${yy}.$((max + 1))"', "rolling YY.N desktop version"],
    ['tag="${TOOL}-v${version}"', "namespaced desktop release tag"],
    ['name="${TOOL} ${version}"', "srn-* desktop release title convention"],
    ['-f name="$name"', "desktop draft release title binding"],
    [
      'echo "app_version=${version}.0"',
      "semver app version for electron-updater",
    ],
    [
      'gh api --method POST "repos/${GITHUB_REPOSITORY}/releases"',
      "desktop draft reservation",
    ],
    ["-F draft=true", "desktop draft-only reservation"],
  ]) {
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktopIdentity,
      fragment,
      description,
    );
  }
  if (rootDesktopIdentity.includes("GITHUB_RUN_ATTEMPT")) {
    errors.push(
      `${rootDesktopFile}: forced desktop identity must remain stable across rerun attempts`,
    );
  }
  if (rootDesktopIdentity.includes('tag="v${version}"')) {
    errors.push(
      `${rootDesktopFile}: desktop must not publish an unnamespaced v* tag`,
    );
  }

  requireFragment(
    errors,
    rootDesktopFile,
    rootDesktop,
    "-c.extraMetadata.version=${{ needs.identity.outputs.app_version }}",
    "semver app version injected into electron-builder",
  );
  const rootDesktopBuilderFixedArguments = desktopContract.builderFixedArguments
    .map((argument) =>
      argument.replace(
        "<normalized-release-version>",
        "${{ needs.identity.outputs.app_version }}",
      ),
    )
    .join(" ");
  const rootDesktopBuilderInvocation =
    desktopContract.builderCommand +
    " ${{ matrix.builder }} " +
    rootDesktopBuilderFixedArguments;
  requireFragment(
    errors,
    rootDesktopFile,
    rootDesktop,
    "run: " + rootDesktopBuilderInvocation,
    "contract-bound electron-builder command shape",
  );

  const rootDesktopBuild = jobBlock(rootDesktop, "build");
  if (!rootDesktopBuild) {
    errors.push(`${rootDesktopFile}: missing desktop build matrix`);
  } else {
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktopBuild,
      "fail-fast: false",
      "complete desktop build matrix",
    );
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktopBuild,
      "if-no-files-found: error",
      "required desktop installer upload",
    );
    for (const [fragment, description] of [
      [
        "Require macOS signing and notarization credentials",
        "fail-closed macOS authenticity preflight",
      ],
      [
        "Require and validate Windows signing credentials",
        "fail-closed Windows authenticity preflight",
      ],
      [
        "SM_CLIENT_CERT_FILE_B64: ${{ secrets.SM_CLIENT_CERT_FILE_B64 }}",
        "DigiCert client authentication certificate secret",
      ],
      [
        "SM_CLIENT_TOOLS_MSI_SHA256: ${{ secrets.SM_CLIENT_TOOLS_MSI_SHA256 }}",
        "DigiCert client tools MSI hash secret",
      ],
      [
        "https://one.digicert.com/signingmanager/api-ui/v1/releases/Keylockertools-windows-x64.msi/download",
        "official DigiCert client tools HTTPS endpoint",
      ],
      [
        "if ($toolsUri.Scheme -ne 'https' -or $toolsUri.Host -ne 'one.digicert.com')",
        "official DigiCert client tools authority enforcement",
      ],
      [
        "-Headers @{ 'x-api-key' = $env:SM_API_KEY }",
        "authenticated DigiCert client tools download",
      ],
      [
        "Get-FileHash -LiteralPath $msiPath -Algorithm SHA256",
        "downloaded DigiCert MSI SHA-256 calculation",
      ],
      [
        "if ($actualMsiHash -ne $expectedMsiHash)",
        "fail-closed DigiCert MSI hash comparison",
      ],
      [
        "$msiSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid",
        "fail-closed DigiCert MSI Authenticode validation",
      ],
      [
        "Start-Process -FilePath msiexec.exe",
        "quiet DigiCert MSI installation",
      ],
      [
        "if (@(0, 1641, 3010) -notcontains $installer.ExitCode)",
        "bounded DigiCert MSI success exit codes",
      ],
      [
        "C:\\Program Files\\DigiCert\\DigiCert Keylocker Tools",
        "fixed DigiCert client tools install directory",
      ],
      [
        "$toolsDirectory | Out-File -FilePath $env:GITHUB_PATH",
        "DigiCert client tools future-step PATH",
      ],
      [
        "Get-Command smctl -CommandType Application -ErrorAction Stop",
        "required DigiCert signing client",
      ],
      ["& $smctl.Source healthcheck", "DigiCert credential health check"],
      [
        "if ($LASTEXITCODE -ne 0)",
        "fail-closed DigiCert credential health check",
      ],
      ['SM_TLS_SKIP_VERIFY: "false"', "DigiCert TLS verification enforcement"],
      [
        "https://clientauth.one.digicert.com",
        "approved DigiCert US production authority",
      ],
      [
        "https://clientauth.one.nl.digicert.com",
        "approved DigiCert Netherlands production authority",
      ],
      [
        "if ($allowedHosts -notcontains $env:SM_HOST.TrimEnd('/'))",
        "DigiCert production authority enforcement",
      ],
      [
        'REQUIRE_DESKTOP_AUTHENTICITY: "true"',
        "production authenticity hook enforcement",
      ],
      [
        "Verify macOS signatures and stapled notarization tickets",
        "macOS signature and notarization verification",
      ],
      [
        'codesign --verify --deep --strict --verbose=2 "$app"',
        "macOS code signature validation",
      ],
      [
        'test "$actual_team" = "$EXPECTED_APPLE_TEAM_ID"',
        "expected Apple Team ID binding",
      ],
      ['xcrun stapler validate "$app"', "stapled notarization validation"],
      [
        'spctl --assess --type execute --verbose=4 "$app"',
        "Gatekeeper assessment",
      ],
      [
        "Verify Windows published and runtime signatures and timestamps",
        "Windows signature verification",
      ],
      [
        "Get-AuthenticodeSignature -LiteralPath $artifact",
        "Authenticode trust validation",
      ],
      [
        "Expected exactly two published Windows executable packages",
        "closed published Windows executable inventory",
      ],
      [
        "Expected exactly two unpacked Windows application executables",
        "closed unpacked Windows runtime inventory",
      ],
      [
        "'dist/win-unpacked/standard-red-notes.exe'",
        "Windows x64 unpacked runtime signature target",
      ],
      [
        "'dist/win-arm64-unpacked/standard-red-notes.exe'",
        "Windows ARM64 unpacked runtime signature target",
      ],
      [
        "$signature.SignerCertificate.Thumbprint -ne $expected",
        "expected Windows signer binding",
      ],
      [
        "$null -eq $signature.TimeStamperCertificate",
        "Windows timestamp enforcement",
      ],
      [
        "Remove Windows signing bootstrap material",
        "Windows signing material cleanup",
      ],
      [
        "digicert-keylocker-tools.msi",
        "downloaded DigiCert MSI cleanup target",
      ],
      [
        "digicert-client-auth.p12",
        "DigiCert client authentication cleanup target",
      ],
      ["find dist -type f -name app.asar", "actual packaged asar discovery"],
      ["yarn exec asar extract", "packaged desktop runtime extraction"],
      [
        "for metadata_path in dist/latest*.yml",
        "updater-only desktop metadata inventory",
      ],
      [
        "for blockmap in dist/*.blockmap",
        "portable desktop blockmap inventory",
      ],
      ["checksum=(shasum -a 256)", "macOS desktop checksum fallback"],
      [
        '"standard-red-notes-${APP_VERSION}-linux-x86_64.AppImage"',
        "electron-builder Linux x64 AppImage filename",
      ],
      [
        '"standard-red-notes-${APP_VERSION}-linux-amd64.deb"',
        "electron-builder Linux x64 Debian filename",
      ],
      [
        "node ../../../scripts/release-packaging-contract.mjs",
        "canonical desktop packaging fingerprint",
      ],
      ["--contract desktop", "desktop packaging contract selection"],
      ["cp ../../yarn.lock", "desktop lockfile packaging input"],
      ["cp ../../.nvmrc", "desktop Node runtime input"],
      ["cp -a ../../.yarn/patches", "desktop Yarn patch inputs"],
      ["cp -a ../../.yarn/releases", "desktop Yarn runtime inputs"],
      ["cp package.json", "desktop electron-builder configuration input"],
      [
        "cp build/entitlements.mac.inherit.plist",
        "desktop macOS entitlement fingerprint input",
      ],
      [
        "cp scripts/notarizeMac.js",
        "desktop macOS notarization policy fingerprint input",
      ],
      [
        "cp scripts/windowsSign.js",
        "desktop Windows signing policy fingerprint input",
      ],
      [
        'electron_version="$(yarn node -p',
        "resolved Electron toolchain metadata",
      ],
      [
        'builder_version="$(yarn node -p',
        "resolved electron-builder toolchain metadata",
      ],
      ['--metadata "builderArguments=', "effective desktop target metadata"],
      [
        '--metadata "electronBuilderVersion=',
        "effective electron-builder metadata",
      ],
      ['--metadata "electronVersion=', "effective Electron metadata"],
      ['--metadata "nodeVersion=', "effective desktop Node metadata"],
      [
        "--normalize-package-version package.json",
        "rolling desktop version normalization",
      ],
      [
        "${TOOL}-${target}.fingerprint",
        "per-platform desktop runtime fingerprints",
      ],
    ]) {
      requireFragment(
        errors,
        rootDesktopFile,
        rootDesktopBuild,
        fragment,
        description,
      );
    }
    if (
      countOccurrences(rootDesktopBuild, 'SM_TLS_SKIP_VERIFY: "false"') !== 2
    ) {
      errors.push(
        `${rootDesktopFile}: DigiCert TLS verification must be enforced in preflight and signing`,
      );
    }
    const rootDesktopWindowsCleanup = namedStepBlock(
      rootDesktopBuild,
      "Remove Windows signing bootstrap material",
    );
    for (const [fragment, description] of [
      [
        "if: always() && runner.os == 'Windows'",
        "unconditional Windows signing material cleanup",
      ],
      [
        "Join-Path $env:RUNNER_TEMP 'digicert-keylocker-tools.msi'",
        "downloaded DigiCert MSI cleanup",
      ],
      [
        "Join-Path $env:RUNNER_TEMP 'digicert-client-auth.p12'",
        "DigiCert client authentication cleanup",
      ],
      [
        "Remove-Item -LiteralPath $temporaryFile -Force",
        "exact Windows signing material removal",
      ],
    ]) {
      requireFragment(
        errors,
        rootDesktopFile,
        rootDesktopWindowsCleanup,
        fragment,
        description,
      );
    }
    const rootDesktopPruner = namedStepBlock(
      rootDesktopBuild,
      "Prune foreign Linux native prebuilds",
    );
    for (const [fragment, description] of [
      ["if: runner.os == 'Linux'", "Linux-only native prebuild pruning"],
      [
        "working-directory: app/packages/desktop",
        "desktop native prebuild pruning workspace",
      ],
      [
        "TARGET_ARCH: ${{ matrix.target_arch }}",
        "matrix-bound Linux native prebuild architecture",
      ],
      [
        'run: node scripts/pruneLinuxNativePrebuilds.js --arch "$TARGET_ARCH" --node-modules node_modules --node-modules app/dist/node_modules',
        "both Linux packaged dependency graphs pruned",
      ],
    ]) {
      requireFragment(
        errors,
        rootDesktopFile,
        rootDesktopPruner,
        fragment,
        description,
      );
    }
    requireAdjacentNamedSteps(
      errors,
      rootDesktopFile,
      rootDesktop,
      "build",
      "Build desktop bundle (webpack)",
      "Prune foreign Linux native prebuilds",
    );
    requireAdjacentNamedSteps(
      errors,
      rootDesktopFile,
      rootDesktop,
      "build",
      "Prune foreign Linux native prebuilds",
      "electron-builder",
    );
    if (/\bmapfile\b/.test(rootDesktopBuild)) {
      errors.push(
        `${rootDesktopFile}: root desktop build must not use Bash-4-only mapfile`,
      );
    }
    if (rootDesktopBuild.includes("-printf")) {
      errors.push(
        `${rootDesktopFile}: root desktop build must not use GNU-only find -printf`,
      );
    }
    const configuredRootLegs = [
      ...rootDesktopBuild.matchAll(
        /label:\s*([^,\s}]+),\s*\r?\n\s*os:\s*([^,\s}]+),\s*\r?\n\s*builder:\s*(?:"([^"]+)"|'([^']+)')/g,
      ),
    ].map((match) => ({
      builderArguments: match[3] ?? match[4],
      platform: match[1],
      runner: match[2],
    }));
    if (
      JSON.stringify(configuredRootLegs) !==
      JSON.stringify(desktopContract.rootLegs)
    ) {
      errors.push(
        `${rootDesktopFile}: root desktop platform/runner/builder matrix must exactly match the fingerprint contract`,
      );
    }
  }
  if (/continue-on-error:\s*true/.test(rootDesktop)) {
    errors.push(
      `${rootDesktopFile}: no desktop release leg may be best-effort (continue-on-error)`,
    );
  }

  const rootDesktopDiscard = jobBlock(rootDesktop, "discard_unchanged");
  for (const [fragment, description] of [
    [
      "needs: [impact, identity, decide]",
      "unchanged desktop reservation fan-in",
    ],
    [".assets | length == 0", "empty desktop draft deletion guard"],
    [
      'gh api --method DELETE "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"',
      "exact unchanged desktop draft deletion",
    ],
  ]) {
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktopDiscard,
      fragment,
      description,
    );
  }

  const rootDesktopFanIn = jobBlock(rootDesktop, "fan_in");
  for (const [fragment, description] of [
    ["needs: [identity, build, decide]", "desktop payload fan-in dependencies"],
    ["metadata_version", "updater metadata app-version binding"],
    ["update_urls", "updater metadata URL validation"],
    ['test "$url" = "$(basename "$url")"', "path-free updater URL assertion"],
    [
      "Unexpected desktop release artifact",
      "desktop debug/effective YAML rejection",
    ],
    [
      "Conflicting desktop artifacts share basename",
      "desktop basename collision rejection",
    ],
    ["updaterAuthorities", "canonical updater authority manifest"],
    ["DESKTOP-ARTIFACTS.json", "desktop artifact inventory manifest"],
    ["SHA256SUMS.txt", "desktop exact checksum manifest"],
    ["manifest_sha=", "desktop payload manifest handoff"],
    ["if-no-files-found: error", "required desktop fan-in upload"],
    [
      "sudo apt-get install -y file p7zip-full unzip",
      "desktop updater inspection tools",
    ],
    [
      "ruby app/scripts/verify-desktop-updater-metadata.rb",
      "desktop updater metadata verifier",
    ],
    [
      "--metadata staged/macos/latest-mac.yml",
      "macOS updater authority verification",
    ],
    [
      "--metadata staged/windows/latest.yml",
      "Windows updater authority verification",
    ],
    [
      "--metadata staged/linux-x64/latest-linux.yml",
      "Linux x64 updater authority verification",
    ],
    [
      "--metadata staged/linux-arm64/latest-linux-arm64.yml",
      "Linux ARM64 updater authority verification",
    ],
    ["=dmg-x64", "macOS DMG x64 architecture verification"],
    ["=dmg-arm64", "macOS DMG ARM64 architecture verification"],
    ["=zip-x64", "macOS ZIP x64 architecture verification"],
    ["=zip-arm64", "macOS ZIP ARM64 architecture verification"],
    ["=windows-x64", "Windows x64 architecture verification"],
    ["=windows-arm64", "Windows ARM64 architecture verification"],
    ["=appimage-x64", "AppImage x64 architecture verification"],
    ["=appimage-arm64", "AppImage ARM64 architecture verification"],
    ["=deb-x64", "Debian x64 architecture verification"],
    ["=deb-arm64", "Debian ARM64 architecture verification"],
    [
      '"standard-red-notes-${APP_VERSION}-linux-x86_64.AppImage=appimage-x64"',
      "electron-builder Linux x64 AppImage architecture binding",
    ],
    [
      '"standard-red-notes-${APP_VERSION}-linux-amd64.deb=deb-x64"',
      "electron-builder Linux x64 Debian architecture binding",
    ],
  ]) {
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktopFanIn,
      fragment,
      description,
    );
  }
  if (
    countOccurrences(
      rootDesktopFanIn,
      "ruby app/scripts/verify-desktop-updater-metadata.rb",
    ) !== 4
  ) {
    errors.push(
      `${rootDesktopFile}: root fan-in must verify exactly four updater authorities`,
    );
  }
  for (const [metadata, authority] of Object.entries(
    desktopContract.rootReleaseInventory.authorities,
  )) {
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktopFanIn,
      `[${metadata}]=${authority}`,
      `desktop ${metadata} authority`,
    );
  }
  for (const template of desktopContract.rootReleaseInventory
    .requiredTemplates) {
    requireFragment(
      errors,
      packagingContractFile,
      desktopPackagingContract,
      `"${template}"`,
      `fingerprinted root desktop asset template ${template}`,
    );
  }

  const rootDesktopRelease = jobBlock(rootDesktop, "release");
  for (const [fragment, description] of [
    [
      "needs: [impact, identity, build, decide, fan_in]",
      "desktop release fan-in over every leg",
    ],
    [
      "if: always() && needs.identity.result == 'success'",
      "retry-safe desktop release result gate",
    ],
    ["persist-credentials: false", "nonpersisted desktop publication token"],
    [
      "RELEASE_ID: ${{ needs.identity.outputs.release_id }}",
      "reserved desktop release ID",
    ],
    [
      "EXPECTED_MANIFEST_SHA: ${{ needs.fan_in.outputs.manifest_sha }}",
      "exact desktop payload manifest input",
    ],
    [
      "<!-- srn-release-reservation tool=${TOOL} commit=${GITHUB_SHA} intent=${intent} -->",
      "desktop publication reservation marker",
    ],
    ["verify_payload()", "desktop local/recovered payload verification"],
    [".updaterAuthorities ==", "desktop updater authority equality"],
    [
      'diff -u "$expected_assets" "$local_assets"',
      "exact local desktop asset set",
    ],
    ["verify_remote_assets()", "desktop remote digest verification"],
    ['.digest | test("^sha256:', "remote desktop SHA-256 assertion"],
    [
      "<!-- srn-desktop-release-assets manifest=${manifest_sha} -->",
      "desktop payload-manifest release marker",
    ],
    [
      '-f tag_name="$RELEASE_TAG" -f body="$body"',
      "draft tag preservation during desktop manifest binding",
    ],
    [
      "was already published; exact identity, inventory, checksums, and API digests verified.",
      "ambiguous desktop publication recovery",
    ],
    [
      'gh release upload "$RELEASE_TAG" "${files[@]}" --clobber',
      "retry-safe desktop draft upload",
    ],
    [
      'verify_remote_assets payload "$expected_assets"',
      "post-upload desktop digest verification",
    ],
    [
      'gh api --method PATCH "repos/${GITHUB_REPOSITORY}/releases/${RELEASE_ID}"',
      "final desktop draft publication",
    ],
    ["-F draft=false", "desktop final published state"],
    ["-f make_latest=true", "desktop Latest-pointer ownership"],
  ]) {
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktopRelease,
      fragment,
      description,
    );
  }
  if (/sha256sum[^\n]*\|\|\s*true/.test(rootDesktopRelease)) {
    errors.push(
      `${rootDesktopFile}: desktop checksum failures must not be suppressed`,
    );
  }
  const rootDesktopUploadIndex =
    rootDesktopRelease.indexOf("gh release upload");
  const rootDesktopRemoteVerifyIndex = rootDesktopRelease.lastIndexOf(
    "verify_remote_assets payload",
  );
  const rootDesktopPublishIndex = rootDesktopRelease.lastIndexOf(
    "gh api --method PATCH",
  );
  if (
    rootDesktopUploadIndex < 0 ||
    rootDesktopRemoteVerifyIndex <= rootDesktopUploadIndex ||
    rootDesktopPublishIndex <= rootDesktopRemoteVerifyIndex
  ) {
    errors.push(
      `${rootDesktopFile}: desktop must upload a validated draft, verify remote digests, then publish`,
    );
  }

  const desktopAction = (name) =>
    `${DESKTOP_ACTION_OWNERS[name]}@${desktopContract.actions[name]}`;
  for (const uploadStep of actionStepBlocks(
    rootDesktop,
    desktopAction("uploadArtifact"),
  )) {
    if (!uploadStep.includes("retention-days: 30")) {
      errors.push(
        `${rootDesktopFile}: every desktop recovery artifact must be retained for exactly 30 days`,
      );
    }
  }
  for (const [job, sequence] of Object.entries({
    impact: [desktopAction("checkout"), desktopAction("setupNode")],
    identity: [desktopAction("checkout")],
    build: [
      desktopAction("checkout"),
      desktopAction("setupNode"),
      desktopAction("setupPython"),
      desktopAction("uploadArtifact"),
    ],
    decide: [
      desktopAction("checkout"),
      desktopAction("downloadArtifact"),
      desktopAction("downloadArtifact"),
      desktopAction("downloadArtifact"),
      desktopAction("downloadArtifact"),
    ],
    discard_unchanged: [desktopAction("checkout")],
    fan_in: [
      desktopAction("checkout"),
      desktopAction("downloadArtifact"),
      desktopAction("downloadArtifact"),
      desktopAction("downloadArtifact"),
      desktopAction("downloadArtifact"),
      desktopAction("uploadArtifact"),
    ],
    release: [desktopAction("checkout"), desktopAction("downloadArtifact")],
  })) {
    requireExactJobActionSequence(
      errors,
      rootDesktopFile,
      rootDesktop,
      job,
      sequence,
    );
  }
  requireAdjacentNamedSteps(
    errors,
    rootDesktopFile,
    rootDesktop,
    "build",
    "Collect exact installers and canonical updater metadata",
    "Upload installers",
  );
  requireAdjacentNamedSteps(
    errors,
    rootDesktopFile,
    rootDesktop,
    "fan_in",
    "Validate authorities, reject collisions, and checksum payload",
    "Upload exact desktop release payload",
  );
  const rootDesktopLegIntegrity = namedStepBlock(
    jobBlock(rootDesktop, "build"),
    "Collect exact installers and canonical updater metadata",
  );
  if (
    !rootDesktopLegIntegrity
      .trimEnd()
      .endsWith('"${checksum_check[@]}" "$leg_manifest"\n          )')
  ) {
    errors.push(
      `${rootDesktopFile}: per-leg desktop checksum verification must be terminal before upload`,
    );
  }
  const rootDesktopFanInIntegrity = namedStepBlock(
    jobBlock(rootDesktop, "fan_in"),
    "Validate authorities, reject collisions, and checksum payload",
  );
  if (
    !rootDesktopFanInIntegrity
      .trimEnd()
      .endsWith("(cd payload && sha256sum --check SHA256SUMS.txt)")
  ) {
    errors.push(
      `${rootDesktopFile}: desktop fan-in checksum verification must be terminal before upload`,
    );
  }
  const rootDesktopRoleJobs = Object.freeze({
    "artifact-build": "build",
    "artifact-fan-in": "fan_in",
    "draft-discard": "discard_unchanged",
    "github-publish": "release",
    "impact-analysis": "impact",
    "release-decision": "decide",
    "release-identity": "identity",
  });
  for (const [role, dependencies] of Object.entries(
    desktopContract.semanticPublicationGraphs.root,
  )) {
    requireExactJobDependencies(
      errors,
      rootDesktopFile,
      rootDesktop,
      rootDesktopRoleJobs[role],
      dependencies.map((dependency) => rootDesktopRoleJobs[dependency]),
    );
  }

  // GitHub's "Latest release" pointer is REPO-GLOBAL, and electron-updater
  // resolves the desktop update channel through it: it GETs /releases/latest,
  // takes `tag_name` verbatim, then fetches `<tag>/latest.yml`. Releases default
  // to `make_latest: true`, so any non-desktop srn-* release silently steals the
  // pointer and desktop updates die with ERR_UPDATER_CHANNEL_FILE_NOT_FOUND.
  // Every non-desktop publisher must therefore opt out explicitly, in its own
  // mechanism's syntax. The counts (rather than a mere presence check) are the
  // point: a newly added second release step that forgets the flag must fail.
  // Matched line-anchored so prose in a workflow's header comment (srn-admin
  // still describes a `gh release create` it no longer uses) is not counted as
  // a release step.
  const LATEST_POINTER_MECHANISMS = Object.freeze([
    [
      "uses: softprops/action-gh-release",
      /^\s*(?:-\s+)?uses:\s+softprops\/action-gh-release/gm,
      "make_latest: 'false'",
      /^\s*make_latest:\s*'false'\s*$/gm,
    ],
    [
      "gh release create",
      /^\s*gh release create\b/gm,
      "--latest=false",
      /--latest=false\b/g,
    ],
    [
      "gh api release PATCH",
      /^\s*gh api --method PATCH "\/?repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{(?:RELEASE_ID|release_id)\}"/gm,
      "-f make_latest=false",
      /^\s*-f make_latest=false\b/gm,
    ],
  ]);
  for (const file of [
    ".github/workflows/srn-client.yml",
    ".github/workflows/srn-server.yml",
    ".github/workflows/srn-mcp.yml",
    ".github/workflows/srn-home-server.yml",
    ".github/workflows/srn-admin.yml",
    ".github/workflows/srn-openclaw.yml",
    ".github/workflows/srn-mobile.yml",
  ]) {
    const workflow = files.get(file) ?? "";
    let publishers = 0;
    for (const [
      invocation,
      invocationPattern,
      optOut,
      optOutPattern,
    ] of LATEST_POINTER_MECHANISMS) {
      const steps = [...workflow.matchAll(invocationPattern)].length;
      publishers += steps;
      const optOuts = [...workflow.matchAll(optOutPattern)].length;
      if (steps !== optOuts) {
        errors.push(
          `${file}: ${steps} '${invocation}' release step(s) but ${optOuts} '${optOut}' opt-out(s); ` +
            "non-desktop releases must leave the repo-global Latest pointer to srn-desktop",
        );
      }
    }
    if (publishers === 0) {
      errors.push(`${file}: missing GitHub release publication step`);
    }
    if (/^\s*-F make_latest=(?:true|false|legacy)\b/gm.test(workflow)) {
      errors.push(
        `${file}: make_latest is a REST string enum and must use raw-field '-f', not typed-field '-F'`,
      );
    }
    if (/^\s*-f (?:draft|prerelease)=(?:true|false)\b/gm.test(workflow)) {
      errors.push(
        `${file}: draft and prerelease are REST booleans and must use typed-field '-F', not raw-field '-f'`,
      );
    }
  }
  // The mirror image: desktop is the one component that must keep the pointer,
  // because that is how electron-updater finds its channel file at all.
  if (
    rootDesktop.includes("make_latest: 'false'") ||
    rootDesktop.includes("--latest=false") ||
    rootDesktop.includes("-f make_latest=false")
  ) {
    errors.push(
      `${rootDesktopFile}: srn-desktop must claim the repo-global Latest pointer`,
    );
  }

  const appDesktopFile = "app/.github/workflows/desktop.release.reuse.yml";
  const appDesktop = files.get(appDesktopFile) ?? "";
  const appDesktopProductionFile =
    "app/.github/workflows/desktop.release.prod.yml";
  const appDesktopProduction = files.get(appDesktopProductionFile) ?? "";
  for (const [fragment, description] of [
    [
      "uses: ./.github/workflows/desktop.release.reuse.yml",
      "same-commit reusable desktop workflow caller",
    ],
    ["secrets: inherit", "desktop reusable workflow secret forwarding"],
    ["channel: prod", "desktop production channel input"],
  ]) {
    requireFragment(
      errors,
      appDesktopProductionFile,
      appDesktopProduction,
      fragment,
      description,
    );
  }
  if (/^\s*uses:\s+(?!\.\/)[^\s]+@[^\s]+/m.test(appDesktopProduction)) {
    errors.push(
      `${appDesktopProductionFile}: desktop production must not call a remote or mutable reusable workflow`,
    );
  }
  if (pushBlock(appDesktopProduction) !== "") {
    errors.push(
      `${appDesktopProductionFile}: standalone desktop recovery must remain manual-only`,
    );
  }
  for (const [fragment, description] of [
    ["workflow_dispatch:", "manual desktop recovery trigger"],
    ["confirm_publish:", "explicit desktop recovery confirmation"],
    ["audit_reason:", "audited desktop recovery reason"],
    [
      'test "$CONFIRM_PUBLISH" = true',
      "fail-closed desktop recovery confirmation",
    ],
    ['test -n "$reason"', "nonempty desktop recovery audit reason"],
    ["needs: Gate", "desktop recovery authorization dependency"],
    [
      "environment: release-production",
      "protected desktop recovery environment",
    ],
    ["fetch-depth: 0", "complete desktop recovery history"],
    ["persist-credentials: false", "nonpersistent desktop recovery checkout"],
    [
      `actions/checkout@${desktopContract.actions.checkout} # ${desktopContract.actionVersions.checkout}`,
      "immutable desktop recovery checkout",
    ],
    [
      "git fetch --no-tags --force origin refs/heads/main:refs/remotes/origin/main",
      "protected desktop recovery main fetch",
    ],
    [
      'protected_sha="$(git rev-parse "refs/remotes/origin/main^{commit}")"',
      "protected desktop recovery main commit",
    ],
    ['test "$GITHUB_REF" = refs/heads/main', "exact desktop recovery main ref"],
    [
      'test "$GITHUB_SHA" = "$protected_sha"',
      "exact desktop recovery source commit",
    ],
  ]) {
    requireFragment(
      errors,
      appDesktopProductionFile,
      appDesktopProduction,
      fragment,
      description,
    );
  }
  const standaloneDesktopCallerJobs = [
    ...appDesktopProduction
      .slice(appDesktopProduction.indexOf("\njobs:"))
      .matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm),
  ].map((match) => match[1]);
  if (
    JSON.stringify(standaloneDesktopCallerJobs) !==
    JSON.stringify(["Gate", "Build"])
  ) {
    errors.push(
      `${appDesktopProductionFile}: manual desktop recovery jobs must be exactly Gate then Build`,
    );
  }
  if (
    countOccurrences(
      appDesktopProduction,
      "environment: release-production",
    ) !== 1
  ) {
    errors.push(
      `${appDesktopProductionFile}: manual desktop recovery must cross exactly one protected authorization environment`,
    );
  }
  for (const [fragment, description] of [
    [
      "permissions:\n  contents: read",
      "read-only reusable desktop permissions",
    ],
    [
      "concurrency:\n  group: desktop-release-${{ inputs.channel }}\n  cancel-in-progress: false",
      "channel-scoped non-cancelling reusable desktop concurrency",
    ],
  ]) {
    requireFragment(errors, appDesktopFile, appDesktop, fragment, description);
  }
  const standaloneDesktopPythonVersions = [
    ...appDesktop.matchAll(/^\s*python-version:\s*'([^']+)'\s*$/gm),
  ].map((match) => match[1]);
  if (
    standaloneDesktopPythonVersions.length !== 7 ||
    standaloneDesktopPythonVersions.some(
      (version) => version !== desktopContract.standalonePythonVersion,
    )
  ) {
    errors.push(
      `${appDesktopFile}: expected 7 standalone Python ${desktopContract.standalonePythonVersion} setup legs, found ${standaloneDesktopPythonVersions.join(",") || "none"}`,
    );
  }
  for (const [name, value] of [
    ["rootPythonVersion", desktopContract.rootPythonVersion],
    ["standalonePythonVersion", desktopContract.standalonePythonVersion],
  ]) {
    requireFragment(
      errors,
      packagingContractFile,
      desktopPackagingContract,
      `${name}: "${value}"`,
      `explicit desktop ${name} contract`,
    );
  }
  for (const [fragment, description] of [
    ["rootRunners: Object.freeze([", "explicit root desktop runner contract"],
    ["rootTargets: Object.freeze([", "explicit root desktop target contract"],
    ["rootLegs: Object.freeze([", "paired root desktop build-leg contract"],
    [
      "semanticPublicationGraphs: Object.freeze({",
      "semantic desktop publication graph contract",
    ],
    [
      "standaloneTargets: Object.freeze([",
      "explicit standalone desktop target contract",
    ],
    [
      `standaloneBuilderCommand: "${desktopContract.standaloneBuilderCommand}"`,
      "standalone desktop builder command contract",
    ],
    [
      "standaloneBuilderFixedArguments: Object.freeze([",
      "standalone desktop fixed builder arguments contract",
    ],
    [
      "standalonePublicationCommands: Object.freeze([",
      "standalone desktop publication command contract",
    ],
    [
      `standaloneArtifactFanInPattern: "${desktopContract.standaloneArtifactFanInPattern}"`,
      "standalone desktop artifact fan-in contract",
    ],
    [
      `standaloneReleaseFiles: "${desktopContract.standaloneReleaseFiles}"`,
      "standalone desktop release-file contract",
    ],
  ]) {
    requireFragment(
      errors,
      packagingContractFile,
      desktopPackagingContract,
      fragment,
      description,
    );
  }
  const standaloneDesktopBuilderFixedArguments =
    desktopContract.standaloneBuilderFixedArguments
      .map((argument) =>
        argument.replace("<app-version>", "${{ env.APP_VERSION }}"),
      )
      .join(" ");
  for (const target of desktopContract.standaloneTargets) {
    const block = jobBlock(appDesktop, target.job);
    if (!block) {
      errors.push(`${appDesktopFile}: missing ${target.job} packaging job`);
      continue;
    }
    requireFragment(
      errors,
      appDesktopFile,
      block,
      `runs-on: ${target.runner}`,
      `${target.job} contract-bound runner`,
    );
    for (const builderArguments of target.builderArguments) {
      requireFragment(
        errors,
        appDesktopFile,
        block,
        desktopContract.standaloneBuilderCommand +
          " " +
          builderArguments +
          " " +
          standaloneDesktopBuilderFixedArguments,
        `${target.job} contract-bound builder invocation`,
      );
    }
    for (const validationCommand of target.validationCommands) {
      requireFragment(
        errors,
        appDesktopFile,
        block,
        validationCommand.replace("<app-version>", "${{ env.APP_VERSION }}"),
        `${target.job} contract-bound validation command`,
      );
    }
    for (const environment of target.requiredEnvironment) {
      const [name, value] = environment.split("=", 2);
      requireFragment(
        errors,
        appDesktopFile,
        block,
        `${name}: '${value}'`,
        `${target.job} contract-bound environment`,
      );
    }
    if (target.artifactName === null) {
      if (block.includes("actions/upload-artifact@")) {
        errors.push(
          `${appDesktopFile}: validation-only ${target.job} must not invent a release artifact`,
        );
      }
    } else {
      requireFragment(
        errors,
        appDesktopFile,
        block,
        `name: ${target.artifactName}`,
        `${target.job} artifact name`,
      );
      requireFragment(
        errors,
        appDesktopFile,
        block,
        "if-no-files-found: error",
        `${target.job} required artifact upload`,
      );
      for (const artifactGlob of target.artifactGlobs) {
        requireFragment(
          errors,
          appDesktopFile,
          block,
          artifactGlob,
          `${target.job} artifact glob '${artifactGlob}'`,
        );
      }
      const configuredPaths = artifactUploadPaths(block, target.artifactName);
      if (
        JSON.stringify(configuredPaths) !== JSON.stringify(target.artifactGlobs)
      ) {
        errors.push(
          `${appDesktopFile}: ${target.job} upload paths must exactly match the fingerprint contract`,
        );
      }
    }
    requireFragment(
      errors,
      packagingContractFile,
      desktopPackagingContract,
      `job: "${target.job}"`,
      `fingerprinted standalone desktop job ${target.job}`,
    );
  }
  const configuredStandaloneJobs = [
    ...appDesktop
      .slice(appDesktop.indexOf("\njobs:"))
      .matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm),
  ].map((match) => match[1]);
  const expectedStandaloneJobs = [
    ...desktopContract.standaloneTargets.map((target) => target.job),
    "FanIn",
    "PublishGitHub",
    "PublishSnap",
    "ReleaseStatus",
  ];
  if (
    JSON.stringify([...configuredStandaloneJobs].sort()) !==
    JSON.stringify([...expectedStandaloneJobs].sort())
  ) {
    errors.push(
      `${appDesktopFile}: standalone desktop job set must exactly match the fingerprint contract`,
    );
  }
  const configuredStandaloneBuilders = [
    ...appDesktop.matchAll(
      /^[ \t]*(?:run:[ \t]*)?(yarn run electron-builder [^\r\n]+)$/gm,
    ),
  ].map((match) => match[1].trim());
  const expectedStandaloneBuilders = desktopContract.standaloneTargets.flatMap(
    (target) =>
      target.builderArguments.map(
        (builderArguments) =>
          desktopContract.standaloneBuilderCommand +
          " " +
          builderArguments +
          " " +
          standaloneDesktopBuilderFixedArguments,
      ),
  );
  if (
    JSON.stringify([...configuredStandaloneBuilders].sort()) !==
    JSON.stringify([...expectedStandaloneBuilders].sort())
  ) {
    errors.push(
      `${appDesktopFile}: standalone desktop builder set must exactly match the fingerprint contract`,
    );
  }
  for (const [name, owner] of Object.entries(DESKTOP_ACTION_OWNERS)) {
    requireFragment(
      errors,
      appDesktopFile,
      appDesktop,
      `${owner}@${desktopContract.actions[name]} # ${desktopContract.actionVersions[name]}`,
      `reusable desktop version-labelled immutable ${name} action`,
    );
  }
  validateImmutableActionAllowlist(errors, {
    actionOwners: DESKTOP_ACTION_OWNERS,
    actions: desktopContract.actions,
    actionVersions: desktopContract.actionVersions,
    allowedLocalActions: new Set(["./actions/release-notes"]),
    file: appDesktopFile,
    workflow: appDesktop,
  });
  for (const jobName of [
    "Mac",
    "Windows",
    "Linux-Snap",
    "PublishGitHub",
    "PublishSnap",
  ]) {
    requireFragment(
      errors,
      appDesktopFile,
      jobBlock(appDesktop, jobName),
      "environment: release-production",
      `${jobName} protected production environment`,
    );
  }
  if (countOccurrences(appDesktop, "environment: release-production") !== 5) {
    errors.push(
      `${appDesktopFile}: reusable desktop production environment must be scoped exactly to macOS signing, Windows signing, Snap build, GitHub publication, and Snap publication`,
    );
  }
  for (const uploadStep of actionStepBlocks(
    appDesktop,
    desktopAction("uploadArtifact"),
  )) {
    if (!uploadStep.includes("retention-days: 30")) {
      errors.push(
        `${appDesktopFile}: every standalone desktop recovery artifact must be retained for exactly 30 days`,
      );
    }
  }
  for (const [job, sequence] of Object.entries({
    Mac: [
      desktopAction("checkout"),
      desktopAction("setupNode"),
      desktopAction("cache"),
      desktopAction("setupPython"),
      desktopAction("uploadArtifact"),
    ],
    Windows: [
      desktopAction("checkout"),
      desktopAction("setupNode"),
      desktopAction("cache"),
      desktopAction("setupPython"),
      desktopAction("uploadArtifact"),
    ],
    "Linux-AppImage-X64": [
      desktopAction("checkout"),
      desktopAction("setupNode"),
      desktopAction("cache"),
      desktopAction("setupPython"),
      desktopAction("uploadArtifact"),
    ],
    "Linux-AppImage-ARM64": [
      desktopAction("checkout"),
      desktopAction("setupNode"),
      desktopAction("cache"),
      desktopAction("setupPython"),
      desktopAction("uploadArtifact"),
    ],
    "Linux-Dir-X64": [
      desktopAction("checkout"),
      desktopAction("setupNode"),
      desktopAction("cache"),
      desktopAction("setupPython"),
    ],
    "Linux-Dir-ARM64": [
      desktopAction("checkout"),
      desktopAction("setupNode"),
      desktopAction("cache"),
      desktopAction("setupPython"),
    ],
    "Linux-Deb-X64": [desktopAction("downloadArtifact")],
    "Linux-Deb-ARM64": [desktopAction("downloadArtifact")],
    "Linux-Snap": [
      desktopAction("checkout"),
      desktopAction("setupNode"),
      desktopAction("cache"),
      desktopAction("setupPython"),
      desktopAction("setupLxd"),
      desktopAction("uploadArtifact"),
    ],
    FanIn: [
      desktopAction("checkout"),
      desktopAction("setupNode"),
      desktopAction("downloadArtifact"),
      desktopAction("downloadArtifact"),
      desktopAction("downloadArtifact"),
      desktopAction("downloadArtifact"),
      desktopAction("downloadArtifact"),
      desktopAction("uploadArtifact"),
    ],
    PublishGitHub: [
      desktopAction("checkout"),
      desktopAction("downloadArtifact"),
      "./actions/release-notes",
    ],
    PublishSnap: [desktopAction("downloadArtifact")],
    ReleaseStatus: [],
  })) {
    requireExactJobActionSequence(
      errors,
      appDesktopFile,
      appDesktop,
      job,
      sequence,
    );
  }
  for (const [job, integrityStep, consumerStep] of [
    ["Mac", "Verify macOS installer and updater inventory", "Upload"],
    ["Windows", "Verify Windows installer and updater inventory", "Upload"],
    [
      "Linux-AppImage-X64",
      "Verify Linux X64 installer and updater inventory",
      "Upload",
    ],
    [
      "Linux-AppImage-ARM64",
      "Verify Linux ARM64 installer and updater inventory",
      "Upload",
    ],
    ["Linux-Snap", "Review Snap", "Upload"],
    [
      "FanIn",
      "Validate authorities, reject collisions, and build exact inventory",
      "Upload immutable publication payload",
    ],
    [
      "PublishGitHub",
      "Generate Release Notes",
      "Reserve, reconcile, and publish exact GitHub release",
    ],
    [
      "PublishSnap",
      "Verify payload checksums",
      "Publish or reconcile the exact Snap revision",
    ],
  ]) {
    requireAdjacentNamedSteps(
      errors,
      appDesktopFile,
      appDesktop,
      job,
      integrityStep,
      consumerStep,
    );
  }
  const standaloneFanInIntegrity = namedStepBlock(
    jobBlock(appDesktop, "FanIn"),
    "Validate authorities, reject collisions, and build exact inventory",
  );
  if (
    !standaloneFanInIntegrity
      .trimEnd()
      .endsWith("(cd payload && sha256sum --check SHA256SUMS)")
  ) {
    errors.push(
      `${appDesktopFile}: standalone desktop fan-in checksum verification must be terminal before upload`,
    );
  }
  const standaloneDesktopRoleJobs = Object.freeze({
    "artifact-fan-in": "FanIn",
    "deb-arm64-validation": "Linux-Deb-ARM64",
    "deb-x64-validation": "Linux-Deb-X64",
    "github-publish": "PublishGitHub",
    "linux-appimage-arm64": "Linux-AppImage-ARM64",
    "linux-appimage-x64": "Linux-AppImage-X64",
    "linux-dir-arm64": "Linux-Dir-ARM64",
    "linux-dir-x64": "Linux-Dir-X64",
    "linux-snap": "Linux-Snap",
    "mac-build": "Mac",
    "release-status": "ReleaseStatus",
    "snap-publish": "PublishSnap",
    "windows-build": "Windows",
  });
  for (const [role, dependencies] of Object.entries(
    desktopContract.semanticPublicationGraphs.standalone,
  )) {
    requireExactJobDependencies(
      errors,
      appDesktopFile,
      appDesktop,
      standaloneDesktopRoleJobs[role],
      dependencies.map((dependency) => standaloneDesktopRoleJobs[dependency]),
    );
  }
  const windows = jobBlock(appDesktop, "Windows");
  if (!windows) {
    errors.push(`${appDesktopFile}: missing Windows job`);
  } else {
    for (const [fragment, description] of [
      ["runs-on: windows-latest", "Windows runner"],
      [
        "Require and validate Windows signing credentials",
        "fail-closed Windows authenticity preflight",
      ],
      [
        "SM_CLIENT_TOOLS_MSI_SHA256: ${{ secrets.SM_CLIENT_TOOLS_MSI_SHA256 }}",
        "DigiCert client tools MSI hash secret",
      ],
      [
        "https://one.digicert.com/signingmanager/api-ui/v1/releases/Keylockertools-windows-x64.msi/download",
        "official DigiCert client tools HTTPS endpoint",
      ],
      [
        "if ($toolsUri.Scheme -ne 'https' -or $toolsUri.Host -ne 'one.digicert.com')",
        "official DigiCert client tools authority enforcement",
      ],
      [
        "-Headers @{ 'x-api-key' = $env:SM_API_KEY }",
        "authenticated DigiCert client tools download",
      ],
      [
        "Get-FileHash -LiteralPath $msiPath -Algorithm SHA256",
        "downloaded DigiCert MSI SHA-256 calculation",
      ],
      [
        "if ($actualMsiHash -ne $expectedMsiHash)",
        "fail-closed DigiCert MSI hash comparison",
      ],
      [
        "$msiSignature.Status -ne [System.Management.Automation.SignatureStatus]::Valid",
        "fail-closed DigiCert MSI Authenticode validation",
      ],
      [
        "Start-Process -FilePath msiexec.exe",
        "quiet DigiCert MSI installation",
      ],
      [
        "if (@(0, 1641, 3010) -notcontains $installer.ExitCode)",
        "bounded DigiCert MSI success exit codes",
      ],
      [
        "C:\\Program Files\\DigiCert\\DigiCert Keylocker Tools",
        "fixed DigiCert client tools install directory",
      ],
      [
        "$toolsDirectory | Out-File -FilePath $env:GITHUB_PATH",
        "DigiCert client tools future-step PATH",
      ],
      [
        "Get-Command smctl -CommandType Application -ErrorAction Stop",
        "required DigiCert signing client",
      ],
      ["& $smctl.Source healthcheck", "DigiCert credential health check"],
      [
        "if ($LASTEXITCODE -ne 0)",
        "fail-closed DigiCert credential health check",
      ],
      [
        "if ($allowedHosts -notcontains $env:SM_HOST.TrimEnd('/'))",
        "DigiCert production authority enforcement",
      ],
      [
        "REQUIRE_DESKTOP_AUTHENTICITY: 'true'",
        "production Windows signing hook enforcement",
      ],
      [
        "Verify Windows published and runtime signatures and timestamps",
        "Windows signature verification",
      ],
      [
        "Get-AuthenticodeSignature -LiteralPath $artifact",
        "Authenticode trust validation",
      ],
      [
        "Expected exactly two published Windows executable packages",
        "closed published Windows executable inventory",
      ],
      [
        "Expected exactly two unpacked Windows application executables",
        "closed unpacked Windows runtime inventory",
      ],
      [
        "'dist/win-unpacked/standard-red-notes.exe'",
        "Windows x64 unpacked runtime signature target",
      ],
      [
        "'dist/win-arm64-unpacked/standard-red-notes.exe'",
        "Windows ARM64 unpacked runtime signature target",
      ],
      [
        "$signature.SignerCertificate.Thumbprint -ne $expected",
        "expected Windows signer binding",
      ],
      [
        "$null -eq $signature.TimeStamperCertificate",
        "Windows timestamp enforcement",
      ],
      [
        "Remove Windows signing bootstrap material",
        "Windows signing material cleanup",
      ],
      [
        "digicert-keylocker-tools.msi",
        "downloaded DigiCert MSI cleanup target",
      ],
      [
        "digicert-client-auth.p12",
        "DigiCert client authentication cleanup target",
      ],
      ["--win nsis --x64 --arm64", "Windows NSIS x64+arm64 build"],
      ["name: dist-windows", "Windows artifact upload"],
      ["packages/desktop/dist/*.exe", "Windows installer artifact path"],
      ["packages/desktop/dist/*.blockmap", "Windows update blockmap path"],
    ]) {
      requireFragment(errors, appDesktopFile, windows, fragment, description);
    }
    if (countOccurrences(windows, "SM_TLS_SKIP_VERIFY: 'false'") !== 2) {
      errors.push(
        `${appDesktopFile}: standalone DigiCert TLS verification must be enforced in preflight and signing`,
      );
    }
    const standaloneWindowsCleanup = namedStepBlock(
      windows,
      "Remove Windows signing bootstrap material",
    );
    for (const [fragment, description] of [
      ["if: always()", "unconditional Windows signing material cleanup"],
      [
        "Join-Path $env:RUNNER_TEMP 'digicert-keylocker-tools.msi'",
        "downloaded DigiCert MSI cleanup",
      ],
      [
        "Join-Path $env:RUNNER_TEMP 'digicert-client-auth.p12'",
        "DigiCert client authentication cleanup",
      ],
      [
        "Remove-Item -LiteralPath $temporaryFile -Force",
        "exact Windows signing material removal",
      ],
    ]) {
      requireFragment(
        errors,
        appDesktopFile,
        standaloneWindowsCleanup,
        fragment,
        description,
      );
    }
  }

  const mac = jobBlock(appDesktop, "Mac");
  for (const [fragment, description] of [
    ["--mac dmg zip --x64 --arm64", "combined macOS x64 and arm64 build"],
    [
      "REQUIRE_DESKTOP_AUTHENTICITY: 'true'",
      "production macOS notarization hook enforcement",
    ],
    [
      "Require macOS signing and notarization credentials",
      "fail-closed macOS authenticity preflight",
    ],
    [
      "Verify macOS signatures and stapled notarization tickets",
      "macOS signature and notarization verification",
    ],
    [
      'codesign --verify --deep --strict --verbose=2 "$app"',
      "macOS code signature validation",
    ],
    [
      'test "$actual_team" = "$APPLE_TEAM_ID"',
      "expected Apple Team ID binding",
    ],
    ['xcrun stapler validate "$app"', "stapled notarization validation"],
    [
      'spctl --assess --type execute --verbose=4 "$app"',
      "Gatekeeper assessment",
    ],
  ]) {
    requireFragment(errors, appDesktopFile, mac, fragment, description);
  }

  for (const [job, builder] of [
    ["Linux-AppImage-X64", "--linux AppImage deb --x64"],
    ["Linux-AppImage-ARM64", "--linux AppImage deb --arm64"],
  ]) {
    const block = jobBlock(appDesktop, job);
    if (!block) {
      errors.push(`${appDesktopFile}: missing ${job} job`);
    } else {
      requireFragment(
        errors,
        appDesktopFile,
        block,
        builder,
        `${job} packaging command`,
      );
    }
  }

  const publish = jobBlock(appDesktop, "FanIn");
  for (const dependency of desktopContract.standaloneTargets.map(
    (target) => target.job,
  )) {
    requireFragment(
      errors,
      appDesktopFile,
      publish,
      `        ${dependency},`,
      `${dependency} Publish dependency`,
    );
  }
  requireFragment(
    errors,
    appDesktopFile,
    publish,
    "Windows,",
    "Windows Publish dependency",
  );
  requireFragment(
    errors,
    appDesktopFile,
    publish,
    "name: desktop-release-payload",
    "exact standalone desktop publication payload",
  );
  requireFragment(
    errors,
    appDesktopFile,
    publish,
    `path: ${desktopContract.standaloneReleaseFiles}`,
    "standalone desktop release-file set",
  );
  for (const command of desktopContract.standalonePublicationCommands) {
    requireFragment(
      errors,
      appDesktopFile,
      appDesktop,
      command.replace("<app-version>", "${{ env.APP_VERSION }}"),
      "contract-bound standalone desktop publication command",
    );
  }
  for (const [fragment, description] of [
    ["validate_source()", "source-scoped standalone desktop inventory"],
    ["metadata_version", "standalone updater metadata version assertion"],
    ["update_urls", "standalone updater URL inventory assertion"],
    [
      'test "$url" = "$(basename "$url")"',
      "path-free standalone updater URL assertion",
    ],
    ["Unexpected release artifact", "unexpected standalone asset rejection"],
    [
      "Conflicting artifacts share basename",
      "standalone basename collision rejection",
    ],
    ["DESKTOP-ARTIFACTS.json", "standalone exact asset inventory"],
    ["SHA256SUMS", "standalone exact checksum manifest"],
    ["if-no-files-found: error", "required standalone publication payload"],
    [
      "sudo apt-get install -y file p7zip-full unzip",
      "standalone updater inspection tools",
    ],
    [
      "ruby scripts/verify-desktop-updater-metadata.rb",
      "standalone updater metadata verifier",
    ],
    [
      "--metadata staged/dist-macos/latest-mac.yml",
      "standalone macOS updater authority verification",
    ],
    [
      "--metadata staged/dist-windows/latest.yml",
      "standalone Windows updater authority verification",
    ],
    [
      "--metadata staged/dist-linux-x64/latest-linux.yml",
      "standalone Linux x64 updater authority verification",
    ],
    [
      "--metadata staged/dist-linux-arm64/latest-linux-arm64.yml",
      "standalone Linux ARM64 updater authority verification",
    ],
    ["=dmg-x64", "standalone DMG x64 architecture verification"],
    ["=dmg-arm64", "standalone DMG ARM64 architecture verification"],
    ["=zip-x64", "standalone ZIP x64 architecture verification"],
    ["=zip-arm64", "standalone ZIP ARM64 architecture verification"],
    ["=windows-x64", "standalone Windows x64 architecture verification"],
    ["=windows-arm64", "standalone Windows ARM64 architecture verification"],
    ["=appimage-x64", "standalone AppImage x64 architecture verification"],
    ["=appimage-arm64", "standalone AppImage ARM64 architecture verification"],
    ["=deb-x64", "standalone Debian x64 architecture verification"],
    ["=deb-arm64", "standalone Debian ARM64 architecture verification"],
  ]) {
    requireFragment(errors, appDesktopFile, publish, fragment, description);
  }
  if (
    countOccurrences(
      publish,
      "ruby scripts/verify-desktop-updater-metadata.rb",
    ) !== 4
  ) {
    errors.push(
      `${appDesktopFile}: standalone fan-in must verify exactly four updater authorities`,
    );
  }
  for (const [metadata, authority] of Object.entries(
    desktopContract.standaloneReleaseInventory.authorities,
  )) {
    requireFragment(
      errors,
      appDesktopFile,
      publish,
      `[${metadata}]=${authority}`,
      `standalone ${metadata} authority`,
    );
  }
  for (const template of desktopContract.standaloneReleaseInventory
    .requiredTemplates) {
    requireFragment(
      errors,
      packagingContractFile,
      desktopPackagingContract,
      `"${template}"`,
      `fingerprinted standalone desktop asset template ${template}`,
    );
  }

  const standaloneGitHubPublish = jobBlock(appDesktop, "PublishGitHub");
  for (const [fragment, description] of [
    [
      "persist-credentials: false",
      "nonpersistent standalone GitHub publication checkout",
    ],
    [
      'test "$remote_manifest_sha" = "$MANIFEST_SHA"',
      "published manifest binding to current payload",
    ],
    ['.digest | test("^sha256:', "standalone remote GitHub SHA-256 assertion"],
    ["load_remote_assets", "standalone exact remote asset verification"],
    [
      "<!-- srn-standalone-desktop-release commit=${GITHUB_SHA} tag=${RELEASE_TAG} -->",
      "standalone commit-tag reservation marker",
    ],
    [
      "<!-- srn-standalone-desktop-assets manifest=${MANIFEST_SHA} -->",
      "standalone asset-manifest marker",
    ],
    [
      'gh release upload "$RELEASE_TAG" "${files[@]}" --clobber',
      "retry-safe standalone draft upload",
    ],
    ["-F draft=false", "standalone final publication state"],
    ["-f make_latest=false", "standalone Latest-pointer opt-out"],
  ]) {
    requireFragment(
      errors,
      appDesktopFile,
      standaloneGitHubPublish,
      fragment,
      description,
    );
  }
  const standaloneGitHubChecksums = countOccurrences(
    standaloneGitHubPublish,
    'test "$(sha256sum dist/SHA256SUMS | cut -d \' \' -f 1)" = "$MANIFEST_SHA"',
  );
  if (standaloneGitHubChecksums < 2) {
    errors.push(
      `${appDesktopFile}: standalone GitHub payload must be reverified after local release-note generation`,
    );
  }
  const standaloneUploadIndex =
    standaloneGitHubPublish.indexOf("gh release upload");
  const standaloneRemoteVerifyIndex = standaloneGitHubPublish.lastIndexOf(
    "load_remote_assets dist",
  );
  const standalonePublishIndex = standaloneGitHubPublish.lastIndexOf(
    "gh api --method PATCH",
  );
  if (
    standaloneUploadIndex < 0 ||
    standaloneRemoteVerifyIndex <= standaloneUploadIndex ||
    standalonePublishIndex <= standaloneRemoteVerifyIndex
  ) {
    errors.push(
      `${appDesktopFile}: standalone GitHub release must upload the draft, verify API digests, then publish`,
    );
  }

  const standaloneSnapPublish = jobBlock(appDesktop, "PublishSnap");
  for (const [fragment, description] of [
    [
      "Multiple ${snap_name} revisions already use version",
      "ambiguous Snap version rejection",
    ],
    [
      "Snapcraft does not expose a remote payload digest",
      "honest Snap byte-proof limitation",
    ],
    ["Failing closed", "pre-existing Snap revision fail-closed behavior"],
    [
      'snapcraft upload "$snap_file" --release stable,candidate,beta,edge',
      "exact Snap four-channel upload",
    ],
    ['test "${#candidates[@]}" -eq 1', "unique post-upload Snap revision"],
    [
      'channels_match "${candidates[0]}"',
      "post-upload Snap channel verification",
    ],
  ]) {
    requireFragment(
      errors,
      appDesktopFile,
      standaloneSnapPublish,
      fragment,
      description,
    );
  }
  if (standaloneSnapPublish.includes("exit 0")) {
    errors.push(
      `${appDesktopFile}: pre-existing Snap identity must never be accepted without remote byte proof`,
    );
  }
  requireFragment(
    errors,
    appDesktopFile,
    jobBlock(appDesktop, "PublishGitHub"),
    "permissions:\n      contents: write",
    "Publish-only reusable desktop write permission",
  );
  requireFragment(
    errors,
    appDesktopFile,
    jobBlock(appDesktop, "PublishGitHub"),
    ".target_commitish == $sha",
    "same-commit reusable desktop release target assertion",
  );
  const reusableDesktopWritePermissions = appDesktop
    .split(/\r?\n/)
    .filter((line) => line.trim() === "contents: write").length;
  if (reusableDesktopWritePermissions !== 1) {
    errors.push(
      `${appDesktopFile}: expected one Publish-only contents: write permission, found ${reusableDesktopWritePermissions}`,
    );
  }
  if (/\bif:\s*always\(\)/.test(publish)) {
    errors.push(
      `${appDesktopFile}: Publish must not bypass failed or skipped platform dependencies`,
    );
  }
  if (appDesktop.includes("CI_PAT_TOKEN")) {
    errors.push(
      `${appDesktopFile}: broad CI PAT is forbidden for reusable desktop release`,
    );
  }

  const rootMobileFile = ".github/workflows/srn-mobile.yml";
  const rootMobile = files.get(rootMobileFile) ?? "";
  const appMobileFile = "app/.github/workflows/mobile.release.prod.yml";
  const appMobile = files.get(appMobileFile) ?? "";
  const fastfileFile = "app/packages/mobile/fastlane/Fastfile";
  const fastfile = files.get(fastfileFile) ?? "";
  const appfileFile = "app/packages/mobile/fastlane/Appfile";
  const appfile = files.get(appfileFile) ?? "";
  const mobileReadmeFile = "app/packages/mobile/fastlane/README.md";
  const mobileReadme = files.get(mobileReadmeFile) ?? "";
  const mobileContract = RELEASE_PACKAGING_CONTRACTS.mobile;
  const mobileAction = (name) =>
    `${MOBILE_ACTION_OWNERS[name]}@${mobileContract.actions[name]}`;

  const rootMobileJobs = [
    "impact",
    "version",
    "fingerprint",
    "decide",
    "reserve_release",
    "android",
    "ios",
    "validated",
    "publish_android",
    "upload_ios",
    "distribute_ios",
    "submit_ios",
    "release",
  ];
  const standaloneMobileJobs = [
    "context",
    "android",
    "ios",
    "validated",
    "publish_android",
    "upload_ios",
    "distribute_ios",
    "submit_ios",
    "release",
  ];
  requireExactJobSet(errors, rootMobileFile, rootMobile, rootMobileJobs);
  requireExactJobSet(errors, appMobileFile, appMobile, standaloneMobileJobs);

  for (const [file, workflow] of [
    [rootMobileFile, rootMobile],
    [appMobileFile, appMobile],
  ]) {
    validateImmutableActionAllowlist(errors, {
      actionOwners: MOBILE_ACTION_OWNERS,
      actions: mobileContract.actions,
      actionVersions: mobileContract.actionVersions,
      file,
      workflow,
    });
  }

  const rootMobileActions = {
    impact: ["checkout", "setupNode", "uploadArtifact"],
    version: ["checkout"],
    fingerprint: ["checkout", "setupNode", "uploadArtifact"],
    decide: ["checkout"],
    reserve_release: [],
    android: [
      "checkout",
      "setupNode",
      "cache",
      "setupJava",
      "setupRuby",
      "uploadArtifact",
    ],
    ios: [
      "checkout",
      "setupNode",
      "cache",
      "setupXcode",
      "setupRuby",
      "uploadArtifact",
    ],
    validated: ["downloadArtifact", "uploadArtifact"],
    publish_android: [
      "checkout",
      "setupRuby",
      "downloadArtifact",
      "uploadArtifact",
    ],
    upload_ios: [
      "checkout",
      "setupXcode",
      "setupRuby",
      "downloadArtifact",
      "uploadArtifact",
    ],
    distribute_ios: [
      "checkout",
      "setupRuby",
      "downloadArtifact",
      "uploadArtifact",
    ],
    submit_ios: ["checkout", "setupRuby", "downloadArtifact", "uploadArtifact"],
    release: ["downloadArtifact"],
  };
  const standaloneMobileActions = {
    context: ["checkout"],
    android: rootMobileActions.android,
    ios: rootMobileActions.ios,
    validated: rootMobileActions.validated,
    publish_android: rootMobileActions.publish_android,
    upload_ios: rootMobileActions.upload_ios,
    distribute_ios: rootMobileActions.distribute_ios,
    submit_ios: rootMobileActions.submit_ios,
    release: rootMobileActions.release,
  };
  for (const [file, workflow, plan] of [
    [rootMobileFile, rootMobile, rootMobileActions],
    [appMobileFile, appMobile, standaloneMobileActions],
  ]) {
    for (const [job, actionNames] of Object.entries(plan)) {
      requireExactJobActionSequence(
        errors,
        file,
        workflow,
        job,
        actionNames.map(mobileAction),
      );
    }
  }

  const rootMobileRoleToJob = Object.freeze({
    "impact-analysis": "impact",
    "release-version": "version",
    "release-fingerprint": "fingerprint",
    "release-decision": "decide",
    "github-draft-reservation": "reserve_release",
    "android-build": "android",
    "ios-build": "ios",
    "validated-android-ios": "validated",
    "android-store-publish": "publish_android",
    "ios-app-store-upload": "upload_ios",
    "ios-review-distribute": "distribute_ios",
    "ios-review-submit": "submit_ios",
    "github-release": "release",
  });
  const standaloneMobileRoleToJob = Object.freeze({
    "release-context-and-reservation": "context",
    "android-build": "android",
    "ios-build": "ios",
    "validated-android-ios": "validated",
    "android-store-publish": "publish_android",
    "ios-app-store-upload": "upload_ios",
    "ios-review-distribute": "distribute_ios",
    "ios-review-submit": "submit_ios",
    "github-release": "release",
  });
  for (const [file, workflow, graph, roleToJob] of [
    [
      rootMobileFile,
      rootMobile,
      mobileContract.semanticPublicationGraphs.root,
      rootMobileRoleToJob,
    ],
    [
      appMobileFile,
      appMobile,
      mobileContract.semanticPublicationGraphs.standalone,
      standaloneMobileRoleToJob,
    ],
  ]) {
    for (const [role, dependencies] of Object.entries(graph)) {
      const job = roleToJob[role];
      if (!job || dependencies.some((dependency) => !roleToJob[dependency])) {
        errors.push(`${packagingContractFile}: unknown mobile semantic role`);
        continue;
      }
      requireExactJobDependencies(
        errors,
        file,
        workflow,
        job,
        dependencies.map((dependency) => roleToJob[dependency]),
      );
    }
  }

  const productionJobs = Object.freeze([
    "android",
    "ios",
    "publish_android",
    "upload_ios",
    "distribute_ios",
    "submit_ios",
    "release",
  ]);
  for (const [file, workflow, reservationJob] of [
    [rootMobileFile, rootMobile, "reserve_release"],
    [appMobileFile, appMobile, "context"],
  ]) {
    const protectedJobs = [reservationJob, ...productionJobs];
    for (const job of protectedJobs) {
      requireFragment(
        errors,
        file,
        jobBlock(workflow, job),
        `environment: ${mobileContract.productionEnvironment}`,
        `${job} protected production environment`,
      );
    }
    const actualEnvironmentCount = workflow
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.trim() ===
          `environment: ${mobileContract.productionEnvironment}`,
      ).length;
    if (actualEnvironmentCount !== protectedJobs.length) {
      errors.push(
        `${file}: production environment must be scoped to exactly ${protectedJobs.join(", ")}; found ${actualEnvironmentCount} declarations`,
      );
    }

    const checkoutReference = mobileAction("checkout");
    for (const step of actionStepBlocks(workflow, checkoutReference)) {
      if (!step.includes("persist-credentials: false")) {
        errors.push(
          `${file}: every mobile checkout must disable credential persistence`,
        );
      }
    }
    const uploadReference = mobileAction("uploadArtifact");
    for (const step of actionStepBlocks(workflow, uploadReference)) {
      if (!step.includes("if-no-files-found: error")) {
        errors.push(
          `${file}: every mobile artifact upload must fail when empty`,
        );
      }
      if (!step.includes(`retention-days: ${mobileContract.retentionDays}`)) {
        errors.push(
          `${file}: every mobile artifact and intent marker must retain for exactly ${mobileContract.retentionDays} days`,
        );
      }
    }
  }

  for (const [fragment, description] of [
    [
      "git fetch --no-tags --force origin refs/heads/main:refs/remotes/origin/main",
      "fresh protected-main source proof",
    ],
    ["fetch-tags: true", "complete mobile release tag checkout"],
    [
      "rm -rf html/Web.bundle/src/web-src .release-impact",
      "stale embedded-web payload cleanup",
    ],
    [
      '[ "$GITHUB_REF" != refs/heads/main ] || [ "$GITHUB_SHA" != "$protected_sha" ]',
      "manual protected-main head equality guard",
    ],
    [
      'git merge-base --is-ancestor "$tagged_commit" "$protected_sha"',
      "release-tag protected-main ancestry proof",
    ],
    [
      "if: needs.impact.outputs.changed == 'true' && needs.impact.outputs.publish_requested == 'true'",
      "mobile impact-versus-publication gate",
    ],
    [
      "force_release requires publish_release=true; an analysis-only dispatch cannot force publication.",
      "fail-closed manual force intent",
    ],
  ]) {
    requireFragment(errors, rootMobileFile, rootMobile, fragment, description);
  }
  if (pushBlock(rootMobile).includes("@standardnotes/mobile@*")) {
    errors.push(
      `${rootMobileFile}: workflow-created mobile tags must not recursively trigger mobile publication`,
    );
  }
  for (const [fragment, description] of [
    ["on:\n  workflow_dispatch:", "manual-only recovery trigger"],
    ["confirm_recovery:", "explicit recovery confirmation input"],
    ["recovery_reason:", "audited recovery reason input"],
    [
      '[ "${#non_whitespace_reason}" -lt 20 ]',
      "minimum recovery reason length",
    ],
    [
      '[ "$GITHUB_REF" != refs/heads/main ] || [ "$GITHUB_SHA" != "$protected_sha" ]',
      "recovery protected-main head equality guard",
    ],
  ]) {
    requireFragment(errors, appMobileFile, appMobile, fragment, description);
  }
  if (/^\s{2}(?:push|pull_request|schedule):/m.test(appMobile)) {
    errors.push(`${appMobileFile}: recovery publisher must remain manual-only`);
  }

  for (const [file, workflow, reservationJob] of [
    [rootMobileFile, rootMobile, "reserve_release"],
    [appMobileFile, appMobile, "context"],
  ]) {
    const reservation = jobBlock(workflow, reservationJob);
    const releaseJob = jobBlock(workflow, "release");
    if (countOccurrences(workflow, "gh release create") !== 1) {
      errors.push(
        `${file}: mobile publication must create at most one exact marker-bound draft in the early reservation job`,
      );
    }
    requireFragment(
      errors,
      file,
      reservation,
      "gh release create",
      "early marker-bound GitHub draft reservation",
    );
    for (const [fragment, description] of [
      ["--draft", "draft reservation"],
      ["--prerelease", "prerelease reservation"],
      ["--latest=false", "non-latest reservation"],
      ['--target "$GITHUB_SHA"', "exact source-commit reservation"],
    ]) {
      requireFragment(errors, file, reservation, fragment, description);
    }
    if (releaseJob.includes("gh release create")) {
      errors.push(
        `${file}: final mobile publication must adopt the early draft and never create a fallback release`,
      );
    }
    for (const [fragment, description] of [
      ["gh release upload", "exact GitHub release asset upload"],
      ["--clobber", "draft-only retry replacement"],
      ["-F draft=false", "final draft publication"],
      ["-F prerelease=true", "final prerelease classification"],
      ["-f make_latest=false", "non-latest final publication"],
      ["verify_remote_assets", "remote GitHub asset verification"],
      ["verify_not_latest", "remote latest-pointer verification"],
    ]) {
      requireFragment(errors, file, releaseJob, fragment, description);
    }
  }
  requireFragment(
    errors,
    rootMobileFile,
    rootMobile,
    "srn-mobile-release-intent:run=${GITHUB_RUN_ID};sha=${GITHUB_SHA};version=${VERSION};fingerprint=${FINGERPRINT};",
    "run/commit/version/fingerprint release reservation marker",
  );
  requireFragment(
    errors,
    appMobileFile,
    appMobile,
    "srn-mobile-recovery-release-intent:run=${GITHUB_RUN_ID};sha=${GITHUB_SHA};version=${version};reason=${reason_sha};",
    "run/commit/version/reason recovery reservation marker",
  );

  for (const [file, workflow] of [
    [rootMobileFile, rootMobile],
    [appMobileFile, appMobile],
  ]) {
    for (const [fragment, description] of [
      [
        "EXPECTED_ANDROID_UPLOAD_CERT_SHA256: ${{ secrets.EXPECTED_ANDROID_UPLOAD_CERT_SHA256 }}",
        "protected Android upload-certificate fingerprint",
      ],
      [
        'expected_version_code="$((3004000 + BUILD_NUMBER))"',
        "contract-bound Android version code",
      ],
      [
        "IOS_USES_NON_EXEMPT_ENCRYPTION: ${{ vars.IOS_USES_NON_EXEMPT_ENCRYPTION }}",
        "operator-reviewed iOS encryption classification",
      ],
      [
        "IOS_EXPORT_COMPLIANCE_CODE: ${{ secrets.IOS_EXPORT_COMPLIANCE_CODE }}",
        "conditional iOS export-compliance code",
      ],
      [
        "Print :ITSAppUsesNonExemptEncryption",
        "embedded iOS export classification verification",
      ],
      [
        'test -n "$IOS_EXPORT_COMPLIANCE_CODE"',
        "non-exempt export code requirement",
      ],
      [
        'test -z "$IOS_EXPORT_COMPLIANCE_CODE"',
        "exempt export code prohibition",
      ],
      ['.applicationId == "com.standardnotes"', "Android application ID"],
      [
        '.bundleId == "com.standardnotes.standardnotes"',
        "iOS application bundle ID",
      ],
      [
        '.extensionBundleId == "com.standardnotes.standardnotes.Share-To-SN"',
        "iOS share-extension bundle ID",
      ],
      ['.teamId == "HKF9BXSN95"', "iOS development team ID"],
      [
        '.appGroup == "group.com.standardnotes.standardnotes"',
        "iOS app-group entitlement",
      ],
    ]) {
      requireFragment(errors, file, workflow, fragment, description);
    }
    for (const command of [
      ...mobileContract.buildCommands,
      ...mobileContract.publicationCommands,
      ...mobileContract.providerInspectionLanes,
    ]) {
      requireFragment(
        errors,
        file,
        workflow,
        command,
        `contract-bound mobile command '${command}'`,
      );
    }
  }
  for (const deterministicInput of mobileContract.deterministicInputs) {
    requireFragment(
      errors,
      rootMobileFile,
      jobBlock(rootMobile, "fingerprint"),
      `--path ${deterministicInput}`,
      `mobile deterministic packaging input '${deterministicInput}'`,
    );
  }
  for (const [file, workflow] of [
    [rootMobileFile, rootMobile],
    [appMobileFile, appMobile],
  ]) {
    for (const [fragment, description] of [
      [
        `java-version: '${mobileContract.javaVersion}'`,
        "contract-bound Java version",
      ],
      [
        `ruby-version: '${mobileContract.rubyVersion}'`,
        "contract-bound Ruby version",
      ],
      [
        `xcode-version: '${mobileContract.xcodeVersion}'`,
        "contract-bound Xcode version",
      ],
      ["runs-on: macos-15", "iOS macOS runner"],
      [
        `npm install --global corepack@${mobileContract.corepackVersion}`,
        "contract-bound Corepack version",
      ],
    ]) {
      requireFragment(errors, file, workflow, fragment, description);
    }
  }

  requireAdjacentNamedSteps(
    errors,
    rootMobileFile,
    rootMobile,
    "android",
    "Verify Android package, signer, version, and four-ABI symmetry",
    "Upload validated Android artifacts",
  );
  requireAdjacentNamedSteps(
    errors,
    appMobileFile,
    appMobile,
    "android",
    "Verify Android package, signer, version, and four-ABI symmetry",
    "Upload validated Android artifacts",
  );
  requireAdjacentNamedSteps(
    errors,
    rootMobileFile,
    rootMobile,
    "ios",
    "Verify iOS application, extension, provisioning, signature, and device architecture",
    "Upload validated iOS artifact",
  );
  requireAdjacentNamedSteps(
    errors,
    appMobileFile,
    appMobile,
    "ios",
    "Verify iOS application, extension, provisioning, signature, and device architecture",
    "Upload validated iOS artifact",
  );
  requireAdjacentNamedSteps(
    errors,
    rootMobileFile,
    rootMobile,
    "validated",
    "Verify complete validated payload and generate checksums",
    "Upload complete pre-publication payload",
  );
  requireAdjacentNamedSteps(
    errors,
    appMobileFile,
    appMobile,
    "validated",
    "Verify complete pre-publication payload",
    "Upload complete validated release payload",
  );
  for (const [file, workflow] of [
    [rootMobileFile, rootMobile],
    [appMobileFile, appMobile],
  ]) {
    const validated = jobBlock(workflow, "validated");
    const releaseJob = jobBlock(workflow, "release");
    for (const template of mobileContract.validatedReleaseTemplates) {
      const rendered = template.replace("<version>", "${VERSION}");
      requireFragment(
        errors,
        file,
        validated,
        rendered,
        `validated mobile release file '${template}'`,
      );
      requireFragment(
        errors,
        file,
        releaseJob,
        rendered,
        `published mobile release file '${template}'`,
      );
    }
    requireFragment(
      errors,
      file,
      validated,
      'test "${#files[@]}" -eq 5',
      "five pre-manifest mobile payload files",
    );
    requireFragment(
      errors,
      file,
      releaseJob,
      'test "${#release_files[@]}" -eq 6',
      "exact six-file mobile release inventory",
    );
    requireFragment(
      errors,
      file,
      releaseJob,
      "sha256sum --check SHA256SUMS.txt",
      "terminal mobile release checksum verification",
    );
  }

  const mobileStagePlans = [
    [
      rootMobileFile,
      rootMobile,
      [
        [
          "publish_android",
          "Reserve or reconcile exact Google Play publication intent",
          "Persist Google Play intent before external mutation",
          "Publish or verify exact Google Play bundle digest and track state",
          "srn-mobile-google-play-intent-${{ github.run_id }}",
          "bundle exec fastlane android publish_prod",
          [
            "remoteSha256 == $sha",
            'track == "beta"',
            "matchingBundleCount == 1",
          ],
        ],
        [
          "upload_ios",
          "Reserve or reconcile exact App Store build-upload intent",
          "Persist App Store intent before external mutation",
          "Upload or verify exact App Store build-upload binary evidence",
          "srn-mobile-app-store-intent-${{ github.run_id }}",
          "bundle exec fastlane ios upload_prod",
          [
            "remoteFileSize == $size",
            "remoteMd5 == $md5",
            "matchingBuildCount == 1",
          ],
        ],
        [
          "distribute_ios",
          "Reserve or reconcile exact TestFlight distribution intent",
          "Persist TestFlight distribution intent before external mutation",
          "Distribute once or reconcile exact TestFlight membership and beta review",
          "srn-mobile-testflight-distribution-intent-${{ github.run_id }}",
          "bundle exec fastlane ios distribute_prod",
          [
            "matchingPublicGroupCount == 1",
            "matchingBuildMembershipCount == 1",
            "matchingBetaReviewSubmissionCount == 1",
          ],
        ],
        [
          "submit_ios",
          "Reserve or reconcile exact App Store review-submission intent",
          "Persist App Store submission intent before external mutation",
          "Submit once or reconcile exact App Store version, build, and review state",
          "srn-mobile-app-store-submission-intent-${{ github.run_id }}",
          "bundle exec fastlane ios submit_prod",
          ["matchingAppStoreVersionCount == 1", "remoteBuildId == .buildId"],
        ],
      ],
    ],
    [
      appMobileFile,
      appMobile,
      [
        [
          "publish_android",
          "Reserve or reconcile exact Google Play recovery intent",
          "Persist Google Play recovery intent before external mutation",
          "Publish or verify exact Google Play bundle digest and track state",
          "srn-mobile-google-play-intent-${{ github.run_id }}",
          "bundle exec fastlane android publish_prod",
          [
            "remoteSha256 == $sha",
            'trackStatus == "completed"',
            "matchingBundleCount == 1",
          ],
        ],
        [
          "upload_ios",
          "Reserve or reconcile exact App Store recovery intent",
          "Persist App Store recovery intent before external mutation",
          "Upload or verify exact App Store build-upload binary evidence",
          "srn-mobile-app-store-intent-${{ github.run_id }}",
          "bundle exec fastlane ios upload_prod",
          [
            "remoteFileSize == $size",
            "remoteMd5 == $md5",
            "matchingBuildCount == 1",
          ],
        ],
        [
          "distribute_ios",
          "Reserve or reconcile exact TestFlight recovery distribution intent",
          "Persist TestFlight recovery distribution intent before external mutation",
          "Distribute once or reconcile exact TestFlight recovery state",
          "srn-mobile-testflight-distribution-intent-${{ github.run_id }}",
          "bundle exec fastlane ios distribute_prod",
          [
            "matchingPublicGroupCount == 1",
            "matchingBuildMembershipCount == 1",
            "matchingBetaReviewSubmissionCount == 1",
          ],
        ],
        [
          "submit_ios",
          "Reserve or reconcile exact App Store recovery submission intent",
          "Persist App Store recovery submission intent before external mutation",
          "Submit once or reconcile exact App Store recovery state",
          "srn-mobile-app-store-submission-intent-${{ github.run_id }}",
          "bundle exec fastlane ios submit_prod",
          ["matchingAppStoreVersionCount == 1", "remoteBuildId == .buildId"],
        ],
      ],
    ],
  ];
  for (const [file, workflow, stages] of mobileStagePlans) {
    for (const [
      jobName,
      preflightName,
      persistName,
      mutationName,
      artifactName,
      publicationCommand,
      proofFragments,
    ] of stages) {
      const job = jobBlock(workflow, jobName);
      const preflight = workflowStepBlock(job, preflightName);
      if (!preflight) {
        errors.push(`${file}: ${jobName} is missing exact provider preflight`);
      }
      const persistIndex = job.indexOf(`\n      - name: ${persistName}`);
      const mutationIndex = job.indexOf(`\n      - name: ${mutationName}`);
      if (
        !preflight ||
        persistIndex < 0 ||
        mutationIndex < 0 ||
        job.indexOf(preflight) > persistIndex ||
        persistIndex > mutationIndex
      ) {
        errors.push(
          `${file}: ${jobName} must keep preflight, durable intent, and external mutation in exact order`,
        );
      }
      requireAdjacentNamedSteps(
        errors,
        file,
        workflow,
        jobName,
        persistName,
        mutationName,
      );
      requireFragment(
        errors,
        file,
        namedStepBlock(job, persistName),
        artifactName,
        `${jobName} same-run durable intent marker`,
      );
      const mutation = namedStepBlock(job, mutationName);
      requireFragment(
        errors,
        file,
        mutation,
        publicationCommand,
        `${jobName} exact provider mutation command`,
      );
      for (const proof of proofFragments) {
        requireFragment(
          errors,
          file,
          mutation,
          proof,
          `${jobName} exact provider-state proof '${proof}'`,
        );
      }
      if (countOccurrences(workflow, publicationCommand) !== 1) {
        errors.push(
          `${file}: ${publicationCommand} must occur exactly once inside its marker-bound publication step`,
        );
      }
    }
    const distributionPreflightName =
      file === rootMobileFile
        ? "Reserve or reconcile exact TestFlight distribution intent"
        : "Reserve or reconcile exact TestFlight recovery distribution intent";
    const distributionPreflight = workflowStepBlock(
      jobBlock(workflow, "distribute_ios"),
      distributionPreflightName,
    );
    const partialStateBranch = sourceSection(
      distributionPreflight,
      "pending:true)",
      "valid:true)",
    );
    for (const [fragment, description] of [
      [".reconcilable == true", "explicit partial-state reconciliation proof"],
      [
        '.reconciliationOperations == ["public-group-membership"]',
        "membership-only recovery operation",
      ],
      [
        '.reconciliationOperations == ["beta-review-submission"]',
        "beta-review-only recovery operation",
      ],
      [
        "mutation_required=true",
        "same-run partial-state idempotent reconciliation",
      ],
    ]) {
      requireFragment(errors, file, partialStateBranch, fragment, description);
    }
    if (
      /pending:true\|valid:true\)[^\r\n]*mutation_required=false/.test(workflow)
    ) {
      errors.push(
        `${file}: same-run partial TestFlight state must idempotently reconcile the missing half before exact verification`,
      );
    }
  }

  for (const [fragment, description] of [
    [
      "ANDROID_PRODUCTION_PACKAGE_ID = 'com.standardnotes'",
      "Fastlane Android production ID",
    ],
    [
      "IOS_PRODUCTION_BUNDLE_ID = 'com.standardnotes.standardnotes'",
      "Fastlane iOS production ID",
    ],
    [
      "IOS_SHARE_EXTENSION_BUNDLE_ID = 'com.standardnotes.standardnotes.Share-To-SN'",
      "Fastlane iOS share-extension ID",
    ],
    ["IOS_PRODUCTION_TEAM_ID = 'HKF9BXSN95'", "Fastlane Apple team ID"],
    [
      "ENV['IOS_USES_NON_EXEMPT_ENCRYPTION']",
      "Fastlane protected export classification",
    ],
    [
      "ENV['IOS_EXPORT_COMPLIANCE_CODE']",
      "Fastlane conditional export compliance code",
    ],
    [
      "plist['ITSAppUsesNonExemptEncryption'] = export_compliance[:uses_non_exempt_encryption]",
      "Fastlane embedded export classification",
    ],
    ["lane :inspect_upload", "separate App Store upload inspection lane"],
    [
      "lane :inspect_distribution",
      "separate TestFlight distribution inspection lane",
    ],
    [
      "lane :inspect_submission",
      "separate App Store submission inspection lane",
    ],
    ["lane :inspect_prod", "separate Google Play inspection lane"],
    [
      "def app_store_distribution_reconciliation_operations(evidence)",
      "TestFlight partial-state reconciliation classifier",
    ],
    [
      "return ['public-group-membership'] if membership_count == 0 && submission_count == 1",
      "membership-only TestFlight recovery",
    ],
    [
      "return ['beta-review-submission'] if membership_count == 1 && submission_count == 0",
      "beta-review-only TestFlight recovery",
    ],
    [
      "operations.include?('public-group-membership')",
      "idempotent missing-membership mutation",
    ],
    [
      "operations.include?('beta-review-submission')",
      "idempotent missing-review mutation",
    ],
  ]) {
    requireFragment(errors, fastfileFile, fastfile, fragment, description);
  }
  for (const [fragment, description] of [
    [
      'app_identifier "com.standardnotes.standardnotes"',
      "iOS Appfile identity",
    ],
    ["package_name 'com.standardnotes'", "Android Appfile identity"],
  ]) {
    requireFragment(errors, appfileFile, appfile, fragment, description);
  }
  for (const [fragment, description] of [
    ["retained for 30 days", "mobile artifact retention recovery guidance"],
    [
      "Recover by rerunning only the failed job and its dependent jobs in",
      "failed-job-only mobile retry guidance",
    ],
    ["Never use **rerun all jobs**", "no-rebuild mobile retry warning"],
    [
      "distribution/app-signing leaf is a different key",
      "Android upload versus app-signing key distinction",
    ],
    [
      "operator-reviewed legal/export",
      "honest iOS export-classification responsibility",
    ],
  ]) {
    requireFragment(
      errors,
      mobileReadmeFile,
      mobileReadme,
      fragment,
      description,
    );
  }

  for (const [fragment, description] of [
    ["androidVersionCodeBase: 3004000", "mobile Android version-code base"],
    [
      'iosAppGroup: "group.com.standardnotes.standardnotes"',
      "mobile iOS app-group contract",
    ],
    [
      /iosShareExtensionIdentifier:\s*["']com\.standardnotes\.standardnotes\.Share-To-SN["']/,
      "mobile iOS share-extension contract",
    ],
    [
      /androidUploadCertificateSecret:\s*["']EXPECTED_ANDROID_UPLOAD_CERT_SHA256["']/,
      "mobile Android upload-certificate secret contract",
    ],
    [
      /iosUsesNonExemptEncryptionVariable:\s*["']IOS_USES_NON_EXEMPT_ENCRYPTION["']/,
      "mobile iOS export classification contract",
    ],
    [
      'productionEnvironment: "mobile-production"',
      "mobile protected environment contract",
    ],
    ["retentionDays: 30", "mobile recovery retention contract"],
    [
      "semanticPublicationGraphs: Object.freeze({",
      "mobile root and recovery publication DAG contracts",
    ],
    [
      '"srn-mobile-testflight-distribution-intent-<run-id>"',
      "mobile TestFlight durable intent contract",
    ],
  ]) {
    requireFragment(
      errors,
      packagingContractFile,
      packagingContract,
      fragment,
      description,
    );
  }

  const linuxPrunerFile =
    "app/packages/desktop/scripts/pruneLinuxNativePrebuilds.js";
  const linuxPruner = files.get(linuxPrunerFile) ?? "";
  for (const [fragment, description] of [
    [
      "SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64'])",
      "closed Linux prebuild architecture allowlist",
    ],
    [
      "nodeModulesDirectories.length !== 2",
      "exact dual packaged dependency graph requirement",
    ],
    [
      "nodeModulesDirectories.map((directory) => path.resolve(directory))",
      "all packaged dependency graph resolution",
    ],
    [
      "new Set(nodeModulesRoots).size !== nodeModulesRoots.length",
      "distinct packaged dependency graph requirement",
    ],
    ["fs.promises.lstat(directory)", "symlink-aware prebuild inspection"],
    [
      "!stat.isDirectory() || stat.isSymbolicLink()",
      "real prebuild directory enforcement",
    ],
    [
      "expected: `cbor-extract-linux-${architecture}`",
      "target-specific cbor-extract prebuild",
    ],
    ["expected: `linux-${architecture}`", "target-specific microtime prebuild"],
    [
      "if (!plan.inventory.includes(plan.expected))",
      "target preflight before destructive pruning",
    ],
    [
      "await fs.promises.rm(candidate, { recursive: true, force: false })",
      "fail-closed foreign prebuild removal",
    ],
    [
      "remaining.length !== 1 || remaining[0] !== plan.expected",
      "exact post-prune native inventory",
    ],
  ]) {
    requireFragment(
      errors,
      linuxPrunerFile,
      linuxPruner,
      fragment,
      description,
    );
  }
  const preflightIndex = linuxPruner.indexOf(
    "for (const plan of plans) {\n    plan.inventory =",
  );
  const removalIndex = linuxPruner.indexOf(
    "await fs.promises.rm(candidate, { recursive: true, force: false })",
  );
  if (
    preflightIndex < 0 ||
    removalIndex < 0 ||
    preflightIndex >= removalIndex
  ) {
    errors.push(
      `${linuxPrunerFile}: every expected target must be preflighted before native prebuild pruning`,
    );
  }

  const linuxPrunerTestFile =
    "app/packages/desktop/scripts/pruneLinuxNativePrebuilds.test.js";
  const linuxPrunerTest = files.get(linuxPrunerTestFile) ?? "";
  for (const [fragment, description] of [
    [
      "x64 pruning keeps only x64 Linux native prebuilds in both packaged graphs",
      "dual-graph x64 native prebuild pruning test",
    ],
    [
      "arm64 pruning keeps only arm64 Linux native prebuilds in both packaged graphs",
      "dual-graph arm64 native prebuild pruning test",
    ],
    [
      "unknown Linux architecture is rejected without pruning",
      "unknown native prebuild architecture rejection test",
    ],
    [
      "missing expected target in copied graph is rejected before any graph is pruned",
      "atomic dual-graph native prebuild preflight test",
    ],
    [
      "CLI requires both real desktop build node_modules paths",
      "exact desktop build dependency graph CLI test",
    ],
    ["path.join(root, 'node_modules')", "source dependency graph fixture"],
    [
      "path.join(root, 'app', 'dist', 'node_modules')",
      "webpack-copied dependency graph fixture",
    ],
    ["cbor-extract-darwin-arm64", "foreign Darwin ARM cbor fixture"],
    ["cbor-extract-win32-x64", "foreign Windows cbor fixture"],
    ["linux-arm", "foreign Linux ARMv7 fixture"],
    ["darwin-x64+arm64", "foreign universal Darwin microtime fixture"],
    ["win32-ia32", "foreign Windows IA32 microtime fixture"],
    ["win32-x64", "foreign Windows microtime fixture"],
  ]) {
    requireFragment(
      errors,
      linuxPrunerTestFile,
      linuxPrunerTest,
      fragment,
      description,
    );
  }

  const updaterVerifierFile = "app/scripts/verify-desktop-updater-metadata.rb";
  const updaterVerifier = files.get(updaterVerifierFile) ?? "";
  for (const [fragment, description] of [
    ["YAML.safe_load", "safe updater YAML parsing"],
    [
      "decoded == File.basename(decoded) && !decoded.empty?",
      "relative updater basename enforcement",
    ],
    [
      "options[:allowed].uniq.length == options[:allowed].length",
      "unique updater allowlist",
    ],
    ["File.size(path) == size", "exact updater asset size"],
    [
      "[Digest::SHA512.file(path).digest].pack('m0')",
      "base64 SHA-512 updater digest",
    ],
    ["declared == actual", "exact updater SHA-512 equality"],
    ["legacy_path = document['path']", "legacy updater path support"],
    ["legacy_sha512 = document['sha512']", "legacy updater SHA-512 support"],
    [
      "legacy path/sha512 must match one fully verified files entry",
      "legacy fields bound to modern entry",
    ],
    [
      "architecture_names.sort == installer_names.sort",
      "architecture coverage for every installer",
    ],
    ["when 'windows'", "Windows PE verifier"],
    ["/PE32.*Nullsoft Installer/i", "Windows NSIS launcher assertion"],
    [
      `command!('7z', 'x', '-y', "-o#{installer_directory}", path)`,
      "full isolated Windows NSIS extraction",
    ],
    [".to_s.tr('\\\\', '/')", "Windows archive path separator normalization"],
    [
      "payload_name = expected == 'x64' ? 'app-64.7z' : 'app-arm64.7z'",
      "Windows payload architecture binding",
    ],
    [
      'expected_payload_path = "$PLUGINSDIR/#{payload_name}"',
      "exact Windows NSIS payload path",
    ],
    ["File.basename(relative).match?", "all-path Windows payload discovery"],
    [
      "payload_paths == [expected_payload_path]",
      "exact Windows payload inventory",
    ],
    [
      "executable_names == ['Standard Red Notes.exe']",
      "exact top-level Windows application executable",
    ],
    ["optional_magic == 0x20b", "Windows PE32+ optional-header assertion"],
    ["when 'x64' then 0x8664", "Windows x64 PE machine assertion"],
    ["when 'arm64' then 0xaa64", "Windows arm64 PE machine assertion"],
    ["when 'appimage'", "AppImage verifier"],
    ["/ELF 64-bit/i", "AppImage ELF format assertion"],
    ["when 'zip'", "macOS ZIP verifier"],
    ["when 'dmg'", "macOS DMG verifier"],
    [
      "DMG_EXECUTABLE_SELECTOR = '-ir!*.app/Contents/MacOS/*'",
      "selective macOS DMG executable extraction",
    ],
    ["/Mach-O 64-bit/i", "macOS executable format assertion"],
    ["when 'deb'", "Debian package verifier"],
    ["dpkg-deb", "Debian control and payload inspection"],
    ["contains the opposite architecture", "opposite architecture rejection"],
    [
      "relative.scan(/\\.app[\\\\\\/]/).length == 1",
      "outer macOS app executable selection",
    ],
  ]) {
    requireFragment(
      errors,
      updaterVerifierFile,
      updaterVerifier,
      fragment,
      description,
    );
  }

  const updaterVerifierTestFile =
    "app/scripts/verify-desktop-updater-metadata.test.rb";
  const updaterVerifierTest = files.get(updaterVerifierTestFile) ?? "";
  for (const [fragment, description] of [
    ["'desktop.dmg'", "DMG updater fixture"],
    ["'desktop.zip'", "ZIP updater fixture"],
    ["'desktop.exe'", "PE updater fixture"],
    ["'desktop.AppImage'", "AppImage updater fixture"],
    ["'desktop.deb'", "Debian updater fixture"],
    [
      "test_accepts_modern_metadata_for_every_supported_installer_format",
      "valid modern updater metadata test",
    ],
    [
      "test_accepts_matching_legacy_fields",
      "valid legacy updater metadata test",
    ],
    [
      "test_dmg_inspection_excludes_standard_applications_symlink",
      "standard macOS Applications symlink regression test",
    ],
    [
      "test_accepts_windows_payloads_with_forward_and_backslash_archive_paths",
      "portable Windows archive path regression test",
    ],
    [
      "test_rejects_opposite_windows_payload",
      "opposite Windows payload rejection test",
    ],
    [
      "test_rejects_wrong_windows_payload",
      "unknown Windows payload rejection test",
    ],
    [
      "test_rejects_multiple_windows_payloads",
      "multiple Windows payload rejection test",
    ],
    [
      "test_rejects_missing_windows_payload",
      "missing Windows payload rejection test",
    ],
    [
      "test_rejects_windows_payload_outside_plugin_directory",
      "misplaced Windows payload rejection test",
    ],
    [
      "test_rejects_non_nsis_windows_container",
      "non-NSIS Windows container rejection test",
    ],
    [
      "test_rejects_windows_payload_with_wrong_pe_machine",
      "wrong Windows payload PE machine rejection test",
    ],
    ["test_rejects_non_basename_urls", "updater basename rejection test"],
    ["test_rejects_wrong_size", "updater size rejection test"],
    ["test_rejects_wrong_sha512", "updater SHA-512 rejection test"],
    [
      "test_rejects_wrong_architecture_for_every_supported_format",
      "all-format updater architecture rejection test",
    ],
    [
      "test_rejects_binary_content_that_does_not_match_the_declared_format",
      "all-format updater executable-type rejection test",
    ],
  ]) {
    requireFragment(
      errors,
      updaterVerifierTestFile,
      updaterVerifierTest,
      fragment,
      description,
    );
  }

  const ciFile = ".github/workflows/release-contract.yml";
  const ci = files.get(ciFile) ?? "";
  for (const triggerPath of [
    ".github/workflows/srn-mobile.yml",
    ".github/workflows/srn-openclaw.yml",
    "app/.github/workflows/**",
    "app/.github/upstream-workflows-disabled/**",
    "server/.github/workflows/**",
    "server/.github/upstream-workflows-disabled/**",
    "app/packages/mobile/fastlane/**",
    "app/packages/desktop/build/entitlements.mac.inherit.plist",
    "app/packages/desktop/scripts/notarizeMac.js",
    "app/packages/desktop/scripts/pruneLinuxNativePrebuilds.js",
    "app/packages/desktop/scripts/pruneLinuxNativePrebuilds.test.js",
    "app/packages/desktop/scripts/windowsSign.js",
    "app/scripts/verify-desktop-updater-metadata.rb",
    "app/scripts/verify-desktop-updater-metadata.test.rb",
    "scripts/analyze-release-impact.mjs",
    "scripts/analyze-release-impact.test.mjs",
    "scripts/compare-release-fingerprints.mjs",
    "scripts/compare-release-fingerprints.test.mjs",
    "scripts/fingerprint-release-tree.mjs",
    "scripts/fingerprint-release-tree.test.mjs",
    "scripts/native-cli-release.mjs",
    "scripts/package.json",
    "scripts/package-lock.json",
    "scripts/release-packaging-contract.mjs",
    "scripts/release-packaging-contract.test.mjs",
    "scripts/validate-release-contract.mjs",
    "scripts/validate-release-contract.test.mjs",
    "docs/ci-production-gates.md",
    "docs/releases-and-upgrades.md",
  ]) {
    const declaration = `- ${triggerPath}`;
    const count = countOccurrences(
      normalizeWorkflowYamlScalars(ci),
      declaration,
    );
    if (count !== 2) {
      errors.push(
        `${ciFile}: expected ${triggerPath} in both push and pull_request paths, found ${count}`,
      );
    }
  }
  requireFragment(
    errors,
    ciFile,
    ci,
    "node --test scripts/validate-release-contract.test.mjs",
    "validator tests",
  );
  requireFragment(
    errors,
    ciFile,
    ci,
    "node --test app/packages/desktop/scripts/pruneLinuxNativePrebuilds.test.js",
    "desktop Linux native prebuild pruning tests",
  );
  requireFragment(
    errors,
    ciFile,
    ci,
    "ruby app/scripts/verify-desktop-updater-metadata.test.rb",
    "desktop updater metadata verifier tests",
  );
  requireFragment(
    errors,
    ciFile,
    ci,
    "scripts/compare-release-fingerprints.test.mjs",
    "fail-closed fingerprint comparison tests",
  );
  requireFragment(
    errors,
    ciFile,
    ci,
    "node scripts/validate-release-contract.mjs",
    "release-contract validation",
  );
  for (const [fragment, description] of [
    ["fetch-depth: 0", "complete report history checkout"],
    ["git fetch --force --tags origin", "complete report tag fetch"],
    ["--all-workspaces all", "all-workspace release analysis"],
    ["--output release-impact.json", "machine-readable release report"],
    ["--report release-impact.md", "readable release report"],
    [
      `actions/upload-artifact@${RELEASE_POLICY_ACTIONS.uploadArtifact} # ${RELEASE_POLICY_ACTION_VERSIONS.uploadArtifact}`,
      "immutable release report artifact publication",
    ],
    ['cat release-impact.md >> "$GITHUB_STEP_SUMMARY"', "readable job summary"],
  ]) {
    requireFragment(errors, ciFile, ci, fragment, description);
  }
  for (const [name, owner] of Object.entries(RELEASE_POLICY_ACTION_OWNERS)) {
    requireFragment(
      errors,
      ciFile,
      ci,
      `${owner}@${RELEASE_POLICY_ACTIONS[name]} # ${RELEASE_POLICY_ACTION_VERSIONS[name]}`,
      `version-labelled immutable release-policy ${name} action`,
    );
  }
  validateImmutableActionAllowlist(errors, {
    actionOwners: RELEASE_POLICY_ACTION_OWNERS,
    actions: RELEASE_POLICY_ACTIONS,
    actionVersions: RELEASE_POLICY_ACTION_VERSIONS,
    file: ciFile,
    workflow: ci,
  });
  requireExactJobActionSequence(errors, ciFile, ci, "validate", [
    `${RELEASE_POLICY_ACTION_OWNERS.checkout}@${RELEASE_POLICY_ACTIONS.checkout}`,
    `${RELEASE_POLICY_ACTION_OWNERS.setupNode}@${RELEASE_POLICY_ACTIONS.setupNode}`,
    `${RELEASE_POLICY_ACTION_OWNERS.uploadArtifact}@${RELEASE_POLICY_ACTIONS.uploadArtifact}`,
  ]);
  requireFragment(
    errors,
    ciFile,
    ci,
    "persist-credentials: false",
    "nonpersistent release-contract checkout",
  );
  requireAdjacentNamedSteps(
    errors,
    ciFile,
    ci,
    "validate",
    "Install release policy dependencies",
    "Test validator failure cases",
  );
  requireAdjacentNamedSteps(
    errors,
    ciFile,
    ci,
    "validate",
    "Generate repository release inventory and impact report",
    "Upload machine and readable release reports",
  );

  const normalCiFile = ".github/workflows/ci.yml";
  const normalCi = files.get(normalCiFile) ?? "";
  const normalCiContracts = jobBlock(normalCi, "contracts");
  for (const [fragment, description] of [
    ["push:\n    branches: [main]", "main-push CI trigger"],
    ["pull_request:\n    branches: [main]", "main pull-request CI trigger"],
  ]) {
    requireFragment(errors, normalCiFile, normalCi, fragment, description);
  }
  for (const [fragment, description] of [
    ["fetch-depth: 0", "complete normal-CI report history checkout"],
    ["git fetch --force --tags origin", "complete normal-CI tag fetch"],
    ["--all-workspaces all", "normal-CI all-workspace analysis"],
    ["--output release-impact.json", "normal-CI machine report"],
    ["--report release-impact.md", "normal-CI readable report"],
    [
      approvedWorkflowAction("uploadArtifact"),
      "normal-CI release-impact evidence upload",
    ],
    [
      'cat release-impact.md >> "$GITHUB_STEP_SUMMARY"',
      "normal-CI readable summary",
    ],
    [
      "scripts/compare-release-fingerprints.test.mjs",
      "normal-CI fail-closed comparator tests",
    ],
    [
      RELEASE_POLICY_INSTALL_COMMAND,
      "normal-CI release-policy dependency install",
    ],
  ]) {
    requireFragment(
      errors,
      normalCiFile,
      normalCiContracts,
      fragment,
      description,
    );
  }
  if (countOccurrences(ci, RELEASE_POLICY_INSTALL_COMMAND) !== 1) {
    errors.push(
      `${ciFile}: release-contract CI must install release-policy dependencies exactly once`,
    );
  }
  const releaseContractInstallIndex = ci.indexOf(
    RELEASE_POLICY_INSTALL_COMMAND,
  );
  const releaseContractTestIndex = ci.indexOf(
    "node --test scripts/validate-release-contract.test.mjs",
  );
  const releaseContractImpactIndex = ci.indexOf(
    "node scripts/analyze-release-impact.mjs",
  );
  if (
    releaseContractInstallIndex < 0 ||
    releaseContractTestIndex <= releaseContractInstallIndex ||
    releaseContractImpactIndex <= releaseContractTestIndex
  ) {
    errors.push(
      `${ciFile}: release-policy dependencies must install before validator tests and impact reporting`,
    );
  }
  if (countOccurrences(normalCi, "--all-workspaces all") !== 1) {
    errors.push(
      `${normalCiFile}: normal CI must emit exactly one all-workspace impact report`,
    );
  }
  requireAdjacentNamedSteps(
    errors,
    normalCiFile,
    normalCi,
    "contracts",
    "Install release policy dependencies",
    "Validate CI, release, and documentation contracts",
  );
  if (countOccurrences(normalCi, RELEASE_POLICY_INSTALL_COMMAND) !== 1) {
    errors.push(
      `${normalCiFile}: normal CI must install release-policy dependencies exactly once`,
    );
  }
  if (
    normalCiContracts.indexOf(RELEASE_POLICY_INSTALL_COMMAND) < 0 ||
    normalCiContracts.indexOf("node scripts/analyze-release-impact.mjs") <=
      normalCiContracts.indexOf(RELEASE_POLICY_INSTALL_COMMAND)
  ) {
    errors.push(
      `${normalCiFile}: normal CI must install release-policy dependencies before impact reporting`,
    );
  }
  for (const forbiddenPublisher of [
    "contents: write",
    "packages: write",
    "id-token: write",
    "softprops/action-gh-release",
    "gh release create",
    "npm publish",
    "yarn npm publish",
    "docker push",
    "fastlane android prod",
    "fastlane ios prod",
  ]) {
    if (normalCi.includes(forbiddenPublisher)) {
      errors.push(
        `${normalCiFile}: normal CI impact reporting must not publish releases (${forbiddenPublisher})`,
      );
    }
  }

  const rootPackage = JSON.parse(files.get("package.json") ?? "{}");
  const expectedRootReleaseScripts = {
    "release:policy:install": RELEASE_POLICY_INSTALL_COMMAND,
    "release:contract":
      "yarn release:policy:install && yarn release:contract:run",
    "release:contract:run": "node scripts/validate-release-contract.mjs",
    "release:impact": "yarn release:policy:install && yarn release:impact:run",
    "release:impact:run": "node scripts/analyze-release-impact.mjs",
    "release:report": "yarn release:policy:install && yarn release:report:run",
    "release:report:run":
      "node scripts/analyze-release-impact.mjs --all-workspaces all --output release-impact.json --report release-impact.md",
    "test:release-impact":
      "yarn release:policy:install && yarn test:release-impact:run",
    "test:release-impact:run":
      "node --test scripts/analyze-release-impact.test.mjs scripts/fingerprint-release-tree.test.mjs scripts/release-packaging-contract.test.mjs scripts/compare-release-fingerprints.test.mjs",
    "test:release-contract":
      "yarn release:policy:install && yarn test:release-contract:run",
    "test:release-contract:run":
      "node --test scripts/validate-release-contract.test.mjs",
  };
  for (const [name, expected] of Object.entries(expectedRootReleaseScripts)) {
    if (rootPackage.scripts?.[name] !== expected) {
      errors.push(
        `package.json: ${name} must use the explicit pinned release-policy dependency boundary`,
      );
    }
  }
  if (
    !rootPackage.scripts?.["ci:contracts"]?.startsWith(
      "yarn release:policy:install && ",
    ) ||
    !rootPackage.scripts["ci:contracts"].includes(
      "yarn test:release-impact:run",
    ) ||
    !rootPackage.scripts["ci:contracts"].includes(
      "yarn test:release-contract:run",
    ) ||
    !rootPackage.scripts["ci:contracts"].includes("yarn release:contract:run")
  ) {
    errors.push(
      "package.json: ci:contracts must install release-policy dependencies once before direct release gate commands",
    );
  }

  const scriptRuntimePackage = JSON.parse(
    files.get("scripts/package.json") ?? "{}",
  );
  const scriptRuntimeLock = JSON.parse(
    files.get("scripts/package-lock.json") ?? "{}",
  );
  if (
    scriptRuntimePackage.private !== true ||
    JSON.stringify(scriptRuntimePackage.dependencies) !==
      JSON.stringify({ "@babel/parser": "7.29.7" })
  ) {
    errors.push(
      "scripts/package.json: release-policy runtime must contain only exact @babel/parser@7.29.7",
    );
  }
  if (
    scriptRuntimeLock.lockfileVersion !== 3 ||
    scriptRuntimeLock.packages?.[""]?.dependencies?.["@babel/parser"] !==
      "7.29.7" ||
    scriptRuntimeLock.packages?.["node_modules/@babel/parser"]?.version !==
      "7.29.7" ||
    !scriptRuntimeLock.packages?.["node_modules/@babel/parser"]?.integrity
  ) {
    errors.push(
      "scripts/package-lock.json: exact @babel/parser@7.29.7 resolution and integrity are required",
    );
  }

  const impactAnalyzerFile = "scripts/analyze-release-impact.mjs";
  const impactAnalyzer = files.get(impactAnalyzerFile) ?? "";
  for (const [fragment, description] of [
    ["shallow-history", "shallow-history fail-closed guard"],
    ["malformed-release-ref", "malformed release-ref guard"],
    ["ambiguous-release-history", "ambiguous history guard"],
    ["ambiguous-hybrid-release-history", "hybrid topology ambiguity guard"],
    ["release-version-collision", "hybrid package-version collision guard"],
    ["--no-renames", "rename-out and deletion diff coverage"],
    ["divergentNewerReleaseRefs", "diagnostic divergent-newer release refs"],
    ["no-ancestor-baseline", "explicit no-ancestor baseline policy"],
    ["publicationGate", "explicit publication gate"],
    ["--exclude-release-ref", "requested release self-tag exclusion"],
    [
      "excluded-release-ref-mismatch",
      "requested release self-tag head assertion",
    ],
    ["MAX_FORCE_REASON_LENGTH = 500", "bounded force reason"],
    ["invalid-force-reason", "single-line force reason guard"],
    ["createReleaseAnalysisContext", "shared release-analysis context"],
    ["discoverReleaseTargetSurface", "computed release trigger surface"],
    ["BigInt(", "arbitrary-precision tag ordering"],
    ["release-managed", "managed workspace classification"],
    ["publishable-unmanaged", "unmanaged workspace classification"],
    ['analysisStatus: "inventory-only"', "inventory-only unmanaged rows"],
    ["publicationPolicy", "explicit workspace publication policy"],
    [
      "discoverStandaloneManagedPackages",
      "standalone managed-package inventory",
    ],
    ["discoverWorkflowOwnership", "complete workflow ownership inventory"],
    ["WORKFLOW_TRIGGER_CONTRACTS", "exact workflow trigger inventory"],
    [
      "workflow-trigger-inventory-mismatch",
      "stale or missing workflow trigger-contract guard",
    ],
    [
      "unclassified-external-mutation-workflow",
      "unclassified external mutation guard",
    ],
    [
      "quarantined-workflow-reactivated",
      "quarantined publisher reactivation guard",
    ],
    [
      "validateDistributionWorkspaceSurfaces",
      "distribution workspace ownership validation",
    ],
    ["declaredTriggers", "reported declared workflow triggers"],
    ["rootDiscoverable", "root-discoverability workflow metadata"],
    ["embeddedPortable", "embedded-portability workflow metadata"],
    ["classificationCounts", "workflow classification summary"],
    ["scopeCounts", "workflow scope summary"],
    ["quarantineCounts", "quarantined workflow summary"],
    ["embeddedSupportCounts", "embedded support workflow summary"],
    ["renderReleaseImpactReport", "readable release report renderer"],
    [
      "...(semanticChange.migration",
      "one-time legacy semantic migration evidence",
    ],
    ["migrationReason", "legacy semantic migration rationale"],
    ["Unknown argument", "unknown CLI argument rejection"],
  ]) {
    requireFragment(
      errors,
      impactAnalyzerFile,
      impactAnalyzer,
      fragment,
      description,
    );
  }
  const impactAnalyzerTestFile = "scripts/analyze-release-impact.test.mjs";
  const impactAnalyzerTests = files.get(impactAnalyzerTestFile) ?? "";
  for (const [fragment, description] of [
    [
      'test("native executor trivia and formatting release no native product"',
      "format-only native no-release regression",
    ],
    [
      'test("product-local native semantics release only that product"',
      "product-scoped native release regression",
    ],
    [
      'test("legacy semantic baselines migrate with conservative full fanout"',
      "one-time legacy native fanout regression",
    ],
    [
      "assert.deepEqual(native.affectedProducts, NATIVE_CLI_RELEASE_PRODUCTS)",
      "all-native legacy migration assertion",
    ],
    [
      'test("semantic parser dependency changes release every managed product"',
      "semantic parser dependency fanout regression",
    ],
  ]) {
    requireFragment(
      errors,
      impactAnalyzerTestFile,
      impactAnalyzerTests,
      fragment,
      description,
    );
  }
  if (
    countOccurrences(impactAnalyzer, "releaseTargetsForPackage(packageName)") <
    3
  ) {
    errors.push(
      `${impactAnalyzerFile}: all workspace modes must use the managed-product category mapping`,
    );
  }
  for (const [target, versioning] of [
    ["srn-admin", "rolling-year"],
    ["srn-client", "rolling-year"],
    ["srn-desktop", "rolling-year"],
    ["srn-home-server", "rolling-year"],
    ["srn-mcp", "rolling-year"],
    ["srn-mobile", "semver"],
    ["srn-openclaw", "rolling-year-or-semver"],
    ["srn-server", "rolling-year"],
  ]) {
    requireFragment(
      errors,
      impactAnalyzerFile,
      releaseTargetBlock(impactAnalyzer, target),
      `versioning: "${versioning}"`,
      `${target} ${versioning} tag profile`,
    );
  }
  requireFragment(
    errors,
    impactAnalyzerFile,
    impactAnalyzer,
    'tagPrefix: `${packageName}@`,\n      versioning: "semver"',
    "independent workspace SemVer profile",
  );

  const comparisonScriptFile = "scripts/compare-release-fingerprints.mjs";
  const comparisonScript = files.get(comparisonScriptFile) ?? "";
  for (const [fragment, description] of [
    ["skip-unchanged", "unchanged release decision"],
    ["release-changed", "build fingerprint mismatch decision"],
    ["release-first", "first-release decision"],
    ["release-forced", "audited force decision"],
    ["no-ancestor-baseline", "divergent-history publication block"],
    ["divergent-release-history", "off-history publication block"],
    ["missing-prior-fingerprint", "missing baseline asset block"],
    ["unexpected-prior-fingerprint", "ambiguous baseline asset block"],
    ["draft-release-baseline", "draft release baseline block"],
    ["malformed-fingerprint", "malformed fingerprint block"],
    ["release-api-unavailable", "release API failure block"],
    ['decision: "blocked"', "persisted blocked evidence"],
    ['"tagName,isDraft,assets"', "exact published-release metadata query"],
  ]) {
    requireFragment(
      errors,
      comparisonScriptFile,
      comparisonScript,
      fragment,
      description,
    );
  }

  const releasesDocFile = "docs/releases-and-upgrades.md";
  const releasesDoc = files.get(releasesDocFile) ?? "";
  for (const [fragment, description] of [
    ["`blocked-release-history`", "divergent-tag publication block"],
    ["unique latest ancestor by", "hybrid topological baseline behavior"],
    ["release-version", "hybrid package-version collision policy"],
    ["`release-managed`", "managed workspace category"],
    ["`publishable-unmanaged`", "unmanaged workspace category"],
    ["does not infer or create publishing", "non-publisher disclaimer"],
    ["44 manifests discovered", "current Yarn-workspace inventory count"],
    ["`cli/srn-client/package.json`", "standalone CLI inventory scope"],
    ["all eight publishers", "complete managed-product count"],
    ["same stable-draft", "OpenClaw retry-safe draft publication"],
    ["--bundle", "documented local OpenClaw provenance bundle verification"],
    ["--source-digest", "documented OpenClaw source-commit verification"],
    ["--signer-workflow", "documented OpenClaw signer verification"],
    ["manual-only recovery path", "honest standalone desktop recovery scope"],
    ["not prove remote byte equality", "honest Snap remote-byte limitation"],
    ["```mermaid", "release decision diagram"],
  ]) {
    requireFragment(
      errors,
      releasesDocFile,
      releasesDoc,
      fragment,
      description,
    );
  }

  const fingerprintScriptFile = "scripts/fingerprint-release-tree.mjs";
  const fingerprintScript = files.get(fingerprintScriptFile) ?? "";
  for (const [fragment, description] of [
    ["srn-release-tree-v1", "versioned fingerprint schema"],
    [
      "fingerprint path escapes the selected root",
      "fingerprint traversal rejection",
    ],
    ["0.0.0-release-fingerprint", "rolling package-version normalization"],
  ]) {
    requireFragment(
      errors,
      fingerprintScriptFile,
      fingerprintScript,
      fragment,
      description,
    );
  }

  return errors;
}

export function runReleaseContractValidation(
  repositoryRoot = defaultRepositoryRoot,
) {
  const errors = validateReleaseContract(
    loadReleaseContractFiles(repositoryRoot),
  );
  if (errors.length > 0) {
    throw new Error(
      `Release contract validation failed:\n- ${errors.join("\n- ")}`,
    );
  }

  return {
    desktopLegs: 6,
    mobilePlatforms: 2,
    mobilePublicationStages:
      RELEASE_PACKAGING_CONTRACTS.mobile.publicationTopology.publishJobs.length,
    openClawPackages: 1,
    openClawSmokeTargets: OPENCLAW_SMOKE_TARGETS.length,
    toolTargets: TOOL_WORKFLOWS.length * TOOL_TARGETS.length,
    toolWorkflows: TOOL_WORKFLOWS.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const result = runReleaseContractValidation();
    console.log(
      `Release contract valid: ${result.toolWorkflows} tools x 6 targets (${result.toolTargets}), ` +
        `${result.openClawPackages} platform-neutral OpenClaw package x ${result.openClawSmokeTargets} native smoke targets, ` +
        `${result.desktopLegs} desktop OS/arch legs, ${result.mobilePlatforms} validated mobile builds + ${result.mobilePublicationStages} publication stages, ` +
        "Android armeabi-v7a+arm64-v8a+x86+x86_64, iOS device arm64.",
    );
    console.log(
      "The architecture-independent web/shared app graph is covered by the desktop release trigger.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
