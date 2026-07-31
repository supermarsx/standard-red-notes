#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  RELEASE_PACKAGING_CONTRACTS,
  fingerprintReleasePackaging,
} from "./release-packaging-contract.mjs";

const contract = RELEASE_PACKAGING_CONTRACTS["native-cli"];

export function parseNativeCliArguments(argv) {
  const command = argv[0];
  if (!new Set(["fingerprint", "package"]).has(command)) {
    throw new TypeError("expected command 'fingerprint' or 'package'");
  }
  const allowed =
    command === "fingerprint"
      ? new Set([
          "--bundle",
          "--github-output",
          "--out-dir",
          "--output",
          "--path",
          "--root",
          "--tool",
        ])
      : new Set(["--bundle", "--out-dir", "--tool"]);
  const repeatedPaths = [];
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new TypeError(
        `expected --name value arguments; received ${argv.join(" ")}`,
      );
    }
    if (!allowed.has(flag)) {
      throw new TypeError(
        `argument '${flag}' does not apply to native ${command}`,
      );
    }
    if (flag === "--path") {
      repeatedPaths.push(value);
    } else if (values.has(flag)) {
      throw new TypeError(`argument '${flag}' was supplied more than once`);
    } else {
      values.set(flag, value);
    }
  }
  return {
    bundle: values.get("--bundle"),
    command,
    githubOutput: values.get("--github-output"),
    output: values.get("--output"),
    outDir: values.get("--out-dir"),
    paths: repeatedPaths,
    root: values.get("--root"),
    tool: values.get("--tool"),
  };
}

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

function safeTool(value) {
  const tool = required(value, "tool");
  if (!/^srn-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool)) {
    throw new TypeError(`tool must be a safe srn-* basename: ${tool}`);
  }
  return tool;
}

function insideWorkingDirectory(value, name, workingDirectory) {
  const absolute = path.resolve(workingDirectory, required(value, name));
  const relation = path.relative(workingDirectory, absolute);
  if (
    relation === ".." ||
    relation.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relation)
  ) {
    throw new TypeError(`${name} must stay inside the working directory`);
  }
  return relation.replaceAll(path.sep, "/") || ".";
}

export function nativeCliPackagePlan({
  tool,
  bundle,
  outDir,
  packagingContract = contract,
  platform = process.platform,
  workingDirectory = process.cwd(),
}) {
  tool = safeTool(tool);
  bundle = insideWorkingDirectory(bundle, "bundle", workingDirectory);
  outDir = insideWorkingDirectory(outDir, "out-dir", workingDirectory);
  const executable = platform === "win32" ? "npx.cmd" : "npx";
  const invocations = packagingContract.targets.map((target) => {
    const output = path.posix.join(outDir, `${tool}-${target.output}`);
    const pkgTarget = `${packagingContract.embeddedRuntime}-${target.target}`;
    return {
      args: [
        "--yes",
        `${packagingContract.packager.name}@${packagingContract.packager.version}`,
        ...packagingContract.packager.flags,
        "--targets",
        pkgTarget,
        "--output",
        output,
        bundle,
      ],
      cwd: ".",
      executable,
      output,
      target: pkgTarget,
      type: "native-executable",
    };
  });
  const bundleDirectory = path.posix.dirname(bundle);
  const product = packagingContract.products?.[tool];
  for (const artifact of product?.supplementalArtifacts ?? []) {
    const output = path.posix.join(outDir, artifact.output);
    invocations.push({
      args: [
        ...artifact.flags,
        path.posix.relative(bundleDirectory, output),
        artifact.input,
      ],
      cwd: bundleDirectory,
      executable: artifact.executable,
      output,
      target: artifact.format,
      type: "supplemental-artifact",
    });
  }
  return { bundle, invocations, outDir, tool };
}

export async function fingerprintNativeCliRelease({
  tool,
  bundle,
  outDir,
  root,
  paths,
  packagingContract = contract,
  platform = process.platform,
  workingDirectory = process.cwd(),
}) {
  tool = safeTool(tool);
  const { products = {}, ...sharedContract } = packagingContract;
  const productContract = products[tool] ?? { supplementalArtifacts: [] };
  const executionPlan = nativeCliPackagePlan({
    tool,
    bundle,
    outDir,
    packagingContract,
    platform,
    workingDirectory,
  });
  return fingerprintReleasePackaging({
    contractName: "native-cli",
    contract: {
      ...sharedContract,
      executionPlan,
      product: productContract,
    },
    metadata: { tool },
    root: required(root, "root"),
    paths,
  });
}

export function packageNativeCli({
  tool,
  bundle,
  outDir,
  packagingContract = contract,
  platform = process.platform,
  spawn = spawnSync,
  workingDirectory = process.cwd(),
}) {
  const plan = nativeCliPackagePlan({
    tool,
    bundle,
    outDir,
    packagingContract,
    platform,
    workingDirectory,
  });
  mkdirSync(path.resolve(workingDirectory, plan.outDir), { recursive: true });
  for (const invocation of plan.invocations) {
    process.stdout.write(
      `${invocation.type} ${invocation.target} -> ${invocation.output}\n`,
    );
    const result = spawn(invocation.executable, invocation.args, {
      cwd: path.resolve(workingDirectory, invocation.cwd),
      encoding: "utf8",
      shell: false,
      stdio: "inherit",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `${invocation.type} command failed for ${invocation.target}`,
      );
    }
  }
  return plan;
}

async function main() {
  const options = parseNativeCliArguments(process.argv.slice(2));
  if (options.command === "package") {
    packageNativeCli(options);
    return;
  }
  if (options.paths.length === 0) {
    throw new TypeError("at least one --path is required");
  }
  const fingerprint = await fingerprintNativeCliRelease(options);
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
      `Native CLI release failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
