#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(scriptPath), "..");

export const RELEASE_CONTRACT_FILES = Object.freeze([
  ".github/workflows/srn-client.yml",
  ".github/workflows/srn-server.yml",
  ".github/workflows/srn-mcp.yml",
  ".github/workflows/srn-home-server.yml",
  ".github/workflows/srn-desktop.yml",
  ".github/workflows/release-contract.yml",
  "app/.github/workflows/desktop.release.reuse.yml",
  "app/.github/workflows/mobile.release.prod.yml",
  "app/packages/mobile/android/gradle.properties",
  "package.json",
]);

const TOOL_WORKFLOWS = Object.freeze([
  ".github/workflows/srn-client.yml",
  ".github/workflows/srn-server.yml",
  ".github/workflows/srn-mcp.yml",
  ".github/workflows/srn-home-server.yml",
]);

const TOOL_TARGETS = Object.freeze([
  ["windows-x64.exe", "win-x64"],
  ["windows-arm64.exe", "win-arm64"],
  ["macos-x64", "macos-x64"],
  ["macos-arm64", "macos-arm64"],
  ["linux-x64", "linux-x64"],
  ["linux-arm64", "linux-arm64"],
]);

function countOccurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

function requireFragment(errors, file, text, fragment, description) {
  if (!text.includes(fragment)) {
    errors.push(`${file}: missing ${description}`);
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

export function loadReleaseContractFiles(repositoryRoot = defaultRepositoryRoot) {
  return new Map(
    RELEASE_CONTRACT_FILES.map((file) => [file, readFileSync(path.join(repositoryRoot, file), "utf8")]),
  );
}

export function validateReleaseContract(files) {
  const errors = [];

  for (const file of TOOL_WORKFLOWS) {
    const workflow = files.get(file) ?? "";
    requireFragment(errors, file, workflow, '"@yao-pkg/pkg@${PKG_VERSION}"', "@yao-pkg/pkg packaging command");

    for (const [output, target] of TOOL_TARGETS) {
      const declaration = `["\${TOOL}-${output}"]="\${PKG_NODE}-${target}"`;
      const count = countOccurrences(workflow, declaration);
      if (count !== 1) {
        errors.push(`${file}: expected one ${target} target declaration, found ${count}`);
      }
    }
  }

  const rootDesktopFile = ".github/workflows/srn-desktop.yml";
  const rootDesktop = files.get(rootDesktopFile) ?? "";
  for (const [fragment, description] of [
    ["- 'app/packages/**'", "packaged app workspace trigger"],
    ["builder: '--mac dmg zip --x64 --arm64'", "macOS x64+arm64 build leg"],
    ["builder: '--win nsis --x64 --arm64'", "Windows x64+arm64 build leg"],
    ["builder: '--linux AppImage deb --x64'", "Linux x64 build leg"],
    ["builder: '--linux AppImage deb --arm64'", "Linux arm64 build leg"],
    ["name: srn-desktop-${{ matrix.label }}", "per-leg desktop artifact upload"],
    ["pattern: srn-desktop-*", "desktop release artifact fan-in"],
  ]) {
    requireFragment(errors, rootDesktopFile, rootDesktop, fragment, description);
  }

  const appDesktopFile = "app/.github/workflows/desktop.release.reuse.yml";
  const appDesktop = files.get(appDesktopFile) ?? "";
  const windows = jobBlock(appDesktop, "Windows");
  if (!windows) {
    errors.push(`${appDesktopFile}: missing Windows job`);
  } else {
    for (const [fragment, description] of [
      ["runs-on: windows-latest", "Windows runner"],
      ["--win nsis --x64 --arm64", "Windows NSIS x64+arm64 build"],
      ["name: dist-windows", "Windows artifact upload"],
      ["packages/desktop/dist/*.exe", "Windows installer artifact path"],
      ["packages/desktop/dist/*.blockmap", "Windows update blockmap path"],
    ]) {
      requireFragment(errors, appDesktopFile, windows, fragment, description);
    }
  }

  const mac = jobBlock(appDesktop, "Mac");
  requireFragment(errors, appDesktopFile, mac, "--mac --x64", "macOS x64 build");
  requireFragment(errors, appDesktopFile, mac, "--mac --arm64", "macOS arm64 build");

  for (const [job, builder] of [
    ["Linux-AppImage-X64", "--linux --x64"],
    ["Linux-AppImage-ARM64", "--linux --arm64"],
    ["Linux-Deb-X64", "--linux --x64"],
    ["Linux-Deb-ARM64", "--linux --arm64"],
  ]) {
    const block = jobBlock(appDesktop, job);
    if (!block) {
      errors.push(`${appDesktopFile}: missing ${job} job`);
    } else {
      requireFragment(errors, appDesktopFile, block, builder, `${job} packaging command`);
    }
  }

  const publish = jobBlock(appDesktop, "Publish");
  requireFragment(errors, appDesktopFile, publish, "Windows,", "Windows Publish dependency");
  requireFragment(errors, appDesktopFile, publish, "pattern: dist-*", "all-platform artifact fan-in");

  const mobileFile = "app/.github/workflows/mobile.release.prod.yml";
  const mobile = files.get(mobileFile) ?? "";
  for (const [fragment, description] of [
    ["Verify universal Android release architectures", "Android architecture assertion step"],
    ["app-prod-release.apk", "universal Android APK contract"],
    ["app-prod-release.aab", "universal Android AAB contract"],
    ["for arch in arm64-v8a x86_64", "required Android native architectures"],
    ['^lib/$arch/.+\\\\.so$', "APK native payload assertion"],
    ['^base/lib/$arch/.+\\\\.so$', "AAB native payload assertion"],
    ["Verify iOS device arm64 artifact", "iOS device architecture assertion step"],
    ["lipo -archs", "iOS binary architecture inspection"],
    ["iOS device artifact is missing arm64", "iOS arm64 requirement"],
    ["Simulator architecture found in iOS device artifact", "iOS simulator-architecture rejection"],
  ]) {
    requireFragment(errors, mobileFile, mobile, fragment, description);
  }

  const gradleFile = "app/packages/mobile/android/gradle.properties";
  const gradle = files.get(gradleFile) ?? "";
  const architectures = /^reactNativeArchitectures=(.+)$/m.exec(gradle)?.[1]?.split(",") ?? [];
  for (const architecture of ["arm64-v8a", "x86_64"]) {
    if (!architectures.includes(architecture)) {
      errors.push(`${gradleFile}: reactNativeArchitectures is missing ${architecture}`);
    }
  }

  const ciFile = ".github/workflows/release-contract.yml";
  const ci = files.get(ciFile) ?? "";
  requireFragment(errors, ciFile, ci, "node --test scripts/validate-release-contract.test.mjs", "validator tests");
  requireFragment(errors, ciFile, ci, "node scripts/validate-release-contract.mjs", "release-contract validation");

  const rootPackage = JSON.parse(files.get("package.json") ?? "{}");
  if (rootPackage.scripts?.["release:contract"] !== "node scripts/validate-release-contract.mjs") {
    errors.push("package.json: release:contract script is not wired to the validator");
  }
  if (rootPackage.scripts?.["test:release-contract"] !== "node --test scripts/validate-release-contract.test.mjs") {
    errors.push("package.json: test:release-contract script is not wired to the validator tests");
  }

  return errors;
}

export function runReleaseContractValidation(repositoryRoot = defaultRepositoryRoot) {
  const errors = validateReleaseContract(loadReleaseContractFiles(repositoryRoot));
  if (errors.length > 0) {
    throw new Error(`Release contract validation failed:\n- ${errors.join("\n- ")}`);
  }

  return {
    desktopLegs: 6,
    toolTargets: TOOL_WORKFLOWS.length * TOOL_TARGETS.length,
    toolWorkflows: TOOL_WORKFLOWS.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const result = runReleaseContractValidation();
    console.log(
      `Release contract valid: ${result.toolWorkflows} tools x 6 targets (${result.toolTargets}), ` +
        `${result.desktopLegs} desktop OS/arch legs, Android arm64-v8a+x86_64, iOS device arm64.`,
    );
    console.log("The architecture-independent web/shared app graph is covered by the desktop release trigger.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
