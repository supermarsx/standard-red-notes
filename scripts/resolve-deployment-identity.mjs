#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const revisionPattern = /^[0-9a-f]{40}$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/;

function git(repositoryRoot, args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function resolveDeploymentIdentity({
  repositoryRoot = defaultRepositoryRoot,
  expectedRevision,
  version,
}) {
  if (!revisionPattern.test(expectedRevision ?? "")) {
    throw new Error(
      "expected revision must be exactly 40 lowercase hexadecimal characters",
    );
  }
  if (!versionPattern.test(version ?? "")) {
    throw new Error("version must be a 1-128 character safe ASCII token");
  }

  const revision = git(repositoryRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  if (revision !== expectedRevision) {
    throw new Error(
      `checked-out commit ${revision} does not match expected revision ${expectedRevision}`,
    );
  }

  const dirty = git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (dirty !== "") {
    throw new Error(
      "refusing to publish deployment identity from a dirty checkout",
    );
  }

  return { revision, version };
}

function parseArgs(argv) {
  const result = { repositoryRoot: defaultRepositoryRoot };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--expect-revision", "--version", "--repository"].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--expect-revision") result.expectedRevision = value;
    if (flag === "--version") result.version = value;
    if (flag === "--repository") result.repositoryRoot = path.resolve(value);
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const identity = resolveDeploymentIdentity(
      parseArgs(process.argv.slice(2)),
    );
    process.stdout.write(
      `SRN_DEPLOY_REVISION=${identity.revision}\nSRN_DEPLOY_VERSION=${identity.version}\n`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
