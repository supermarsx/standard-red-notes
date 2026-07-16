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
  ".github/workflows/srn-openclaw.yml",
  ".github/workflows/srn-desktop.yml",
  ".github/workflows/srn-mobile.yml",
  ".github/workflows/release-contract.yml",
  "app/.github/workflows/desktop.release.reuse.yml",
  "app/.github/workflows/mobile.release.prod.yml",
  "app/packages/mobile/android/gradle.properties",
  "openclaw/package.json",
  "openclaw/scripts/package-release.mjs",
  "openclaw/scripts/release-config.mjs",
  "openclaw/scripts/verify-release.mjs",
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

const OPENCLAW_SMOKE_TARGETS = Object.freeze([
  ["windows-x64", "windows-2025", "x64"],
  ["windows-arm64", "windows-11-arm", "arm64"],
  ["linux-x64", "ubuntu-24.04", "x64"],
  ["linux-arm64", "ubuntu-24.04-arm", "arm64"],
  ["macos-x64", "macos-15-intel", "x64"],
  ["macos-arm64", "macos-15", "arm64"],
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

export function loadReleaseContractFiles(
  repositoryRoot = defaultRepositoryRoot,
) {
  return new Map(
    RELEASE_CONTRACT_FILES.map((file) => [
      file,
      readFileSync(path.join(repositoryRoot, file), "utf8"),
    ]),
  );
}

export function validateReleaseContract(files) {
  const errors = [];

  for (const file of TOOL_WORKFLOWS) {
    const workflow = files.get(file) ?? "";
    requireFragment(
      errors,
      file,
      workflow,
      '"@yao-pkg/pkg@${PKG_VERSION}"',
      "@yao-pkg/pkg packaging command",
    );

    for (const [output, target] of TOOL_TARGETS) {
      const declaration = `["\${TOOL}-${output}"]="\${PKG_NODE}-${target}"`;
      const count = countOccurrences(workflow, declaration);
      if (count !== 1) {
        errors.push(
          `${file}: expected one ${target} target declaration, found ${count}`,
        );
      }
    }
  }

  const openClawWorkflowFile = ".github/workflows/srn-openclaw.yml";
  const openClawWorkflow = files.get(openClawWorkflowFile) ?? "";
  for (const [fragment, description] of [
    ['- "srn-openclaw-v*"', "OpenClaw release tag trigger"],
    ["workflow_dispatch:", "manual OpenClaw release trigger"],
    ['NODE_VERSION: "26.5.0"', "pinned Node 26 release runtime"],
    ['YARN_VERSION: "4.17.1"', "pinned Yarn release version"],
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
      "actions/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373",
      "pinned OpenClaw build provenance action",
    ],
    ["needs: [context, package, smoke]", "all-target OpenClaw release fan-in"],
    ["gh release create", "tagged OpenClaw GitHub release publication"],
  ]) {
    requireFragment(
      errors,
      openClawWorkflowFile,
      openClawWorkflow,
      fragment,
      description,
    );
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

  const openClawRelease = jobBlock(openClawWorkflow, "release");
  for (const [fragment, description] of [
    ["artifact-metadata: write", "artifact metadata permission"],
    ["attestations: write", "attestation permission"],
    ["id-token: write", "provenance signing permission"],
    ["outputs.bundle-path", "published Sigstore provenance bundle"],
    ['sha256sum "${provenance}" >> SHA256SUMS.txt', "provenance checksum"],
    ["--verify-tag", "existing tag verification"],
  ]) {
    requireFragment(
      errors,
      openClawWorkflowFile,
      openClawRelease,
      fragment,
      description,
    );
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

  const actionReferences = [
    ...openClawWorkflow.matchAll(/^\s*(?:-\s+)?uses:\s+([^@\s]+)@([^\s#]+)/gm),
  ];
  if (actionReferences.length === 0) {
    errors.push(
      `${openClawWorkflowFile}: expected immutable action references`,
    );
  }
  for (const [, action, reference] of actionReferences) {
    if (!/^[0-9a-f]{40}$/.test(reference)) {
      errors.push(
        `${openClawWorkflowFile}: mutable action reference ${action}@${reference}; pin a full commit SHA`,
      );
    }
  }

  const openClawPackageFile = "openclaw/package.json";
  const openClawPackage = JSON.parse(files.get(openClawPackageFile) ?? "{}");
  if (openClawPackage.private !== false) {
    errors.push(
      `${openClawPackageFile}: release package must set private to boolean false`,
    );
  }
  if (openClawPackage.engines?.node !== ">=26.0.0") {
    errors.push(
      `${openClawPackageFile}: release package must require Node >=26.0.0`,
    );
  }
  if (openClawPackage.bin?.openclaw !== "dist/index.js") {
    errors.push(
      `${openClawPackageFile}: release package must expose bin.openclaw`,
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
    [
      "productionDependenciesBundled: true",
      "bundled dependency manifest assertion",
    ],
    ["SHA256SUMS.txt", "release checksum manifest"],
  ]) {
    requireFragment(
      errors,
      openClawPackagerFile,
      openClawPackager,
      fragment,
      description,
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
  for (const [fragment, description] of [
    ["- 'app/packages/**'", "packaged app workspace trigger"],
    ["builder: '--mac dmg zip --x64 --arm64'", "macOS x64+arm64 build leg"],
    ["builder: '--win nsis --x64 --arm64'", "Windows x64+arm64 build leg"],
    ["builder: '--linux AppImage deb --x64'", "Linux x64 build leg"],
    ["builder: '--linux AppImage deb --arm64'", "Linux arm64 build leg"],
    [
      "name: srn-desktop-${{ matrix.label }}",
      "per-leg desktop artifact upload",
    ],
    ["pattern: srn-desktop-*", "desktop release artifact fan-in"],
  ]) {
    requireFragment(
      errors,
      rootDesktopFile,
      rootDesktop,
      fragment,
      description,
    );
  }

  const rootSnap = jobBlock(rootDesktop, "snap");
  if (!rootSnap) {
    errors.push(`${rootDesktopFile}: missing release-blocking Snap job`);
  } else {
    if (rootSnap.includes("continue-on-error: true")) {
      errors.push(
        `${rootDesktopFile}: Snap job must block a broken desktop release`,
      );
    }
    requireFragment(
      errors,
      rootDesktopFile,
      rootSnap,
      "if-no-files-found: error",
      "required Snap artifact upload",
    );
  }

  const rootDesktopRelease = jobBlock(rootDesktop, "release");
  for (const [fragment, description] of [
    ["mapfile -d '' files", "bounded desktop checksum input collection"],
    [
      'sha256sum "${files[@]}" > SHA256SUMS.txt',
      "strict desktop checksum generation",
    ],
    ["sha256sum --check SHA256SUMS.txt", "desktop checksum verification"],
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
  requireFragment(
    errors,
    appDesktopFile,
    mac,
    "--mac --x64",
    "macOS x64 build",
  );
  requireFragment(
    errors,
    appDesktopFile,
    mac,
    "--mac --arm64",
    "macOS arm64 build",
  );

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
      requireFragment(
        errors,
        appDesktopFile,
        block,
        builder,
        `${job} packaging command`,
      );
    }
  }

  const publish = jobBlock(appDesktop, "Publish");
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
    "pattern: dist-*",
    "all-platform artifact fan-in",
  );

  const rootMobileFile = ".github/workflows/srn-mobile.yml";
  const rootMobile = files.get(rootMobileFile) ?? "";
  for (const [fragment, description] of [
    ["- '@standardnotes/web@*'", "mobile release tag trigger"],
    ["workflow_dispatch:", "manual mobile release trigger"],
    ["node-version-file: app/.nvmrc", "app-relative Node version path"],
    ["path: app/.yarn/cache", "app-relative Yarn cache path"],
    ["hashFiles('app/yarn.lock')", "app-relative Yarn lock hash"],
  ]) {
    requireFragment(errors, rootMobileFile, rootMobile, fragment, description);
  }

  const rootAndroid = jobBlock(rootMobile, "android");
  if (!rootAndroid) {
    errors.push(`${rootMobileFile}: missing Android release job`);
  } else {
    for (const [fragment, description] of [
      [
        "working-directory: app/packages/mobile",
        "Android app-relative working directory",
      ],
      ["bundle exec fastlane android prod", "Android production release lane"],
      [
        "Verify universal Android release architectures",
        "Android architecture assertion step",
      ],
      ["for arch in arm64-v8a x86_64", "required Android native architectures"],
      ["^lib/$arch/.+\\\\.so$", "APK native payload assertion"],
      ["^base/lib/$arch/.+\\\\.so$", "AAB native payload assertion"],
      ["name: srn-mobile-android", "validated Android artifact upload"],
      ["if-no-files-found: error", "required Android artifacts"],
    ]) {
      requireFragment(
        errors,
        rootMobileFile,
        rootAndroid,
        fragment,
        description,
      );
    }
  }

  const rootIos = jobBlock(rootMobile, "ios");
  if (!rootIos) {
    errors.push(`${rootMobileFile}: missing iOS release job`);
  } else {
    for (const [fragment, description] of [
      ["runs-on: macos-15", "iOS macOS runner"],
      [
        "working-directory: app/packages/mobile",
        "iOS app-relative working directory",
      ],
      ["bundle exec fastlane ios prod", "iOS production release lane"],
      [
        "Verify iOS device arm64 artifact",
        "iOS device architecture assertion step",
      ],
      ["lipo -archs", "iOS binary architecture inspection"],
      ["iOS device artifact is missing arm64", "iOS arm64 requirement"],
      [
        "Simulator architecture found in iOS device artifact",
        "iOS simulator-architecture rejection",
      ],
      ["name: srn-mobile-ios", "validated iOS artifact upload"],
      ["if-no-files-found: error", "required iOS artifact"],
    ]) {
      requireFragment(errors, rootMobileFile, rootIos, fragment, description);
    }
  }

  const rootMobileRelease = jobBlock(rootMobile, "release");
  if (!rootMobileRelease) {
    errors.push(`${rootMobileFile}: missing mobile release fan-in job`);
  } else {
    for (const [fragment, description] of [
      [
        "needs: [version, android, ios]",
        "validated Android and iOS release dependencies",
      ],
      ["pattern: srn-mobile-*", "mobile artifact fan-in"],
      [
        "standard-red-notes-android-universal-${VERSION}.apk",
        "Android APK release assertion",
      ],
      [
        "standard-red-notes-android-${VERSION}.aab",
        "Android AAB release assertion",
      ],
      [
        "standard-red-notes-ios-arm64-${VERSION}.ipa",
        "iOS IPA release assertion",
      ],
      [
        'sha256sum "${files[@]}" > SHA256SUMS.txt',
        "strict mobile checksum generation",
      ],
      ["sha256sum --check SHA256SUMS.txt", "mobile checksum verification"],
      ["uses: softprops/action-gh-release@v3", "mobile GitHub release"],
    ]) {
      requireFragment(
        errors,
        rootMobileFile,
        rootMobileRelease,
        fragment,
        description,
      );
    }
    if (/sha256sum[^\n]*\|\|\s*true/.test(rootMobileRelease)) {
      errors.push(
        `${rootMobileFile}: mobile checksum failures must not be suppressed`,
      );
    }
  }

  const mobileFile = "app/.github/workflows/mobile.release.prod.yml";
  const mobile = files.get(mobileFile) ?? "";
  for (const [fragment, description] of [
    [
      "Verify universal Android release architectures",
      "Android architecture assertion step",
    ],
    ["app-prod-release.apk", "universal Android APK contract"],
    ["app-prod-release.aab", "universal Android AAB contract"],
    ["for arch in arm64-v8a x86_64", "required Android native architectures"],
    ["^lib/$arch/.+\\\\.so$", "APK native payload assertion"],
    ["^base/lib/$arch/.+\\\\.so$", "AAB native payload assertion"],
    [
      "Verify iOS device arm64 artifact",
      "iOS device architecture assertion step",
    ],
    ["lipo -archs", "iOS binary architecture inspection"],
    ["iOS device artifact is missing arm64", "iOS arm64 requirement"],
    [
      "Simulator architecture found in iOS device artifact",
      "iOS simulator-architecture rejection",
    ],
  ]) {
    requireFragment(errors, mobileFile, mobile, fragment, description);
  }

  const gradleFile = "app/packages/mobile/android/gradle.properties";
  const gradle = files.get(gradleFile) ?? "";
  const architectures =
    /^reactNativeArchitectures=(.+)$/m.exec(gradle)?.[1]?.split(",") ?? [];
  for (const architecture of ["arm64-v8a", "x86_64"]) {
    if (!architectures.includes(architecture)) {
      errors.push(
        `${gradleFile}: reactNativeArchitectures is missing ${architecture}`,
      );
    }
  }

  const ciFile = ".github/workflows/release-contract.yml";
  const ci = files.get(ciFile) ?? "";
  requireFragment(
    errors,
    ciFile,
    ci,
    ".github/workflows/srn-mobile.yml",
    "root mobile workflow trigger path",
  );
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
    "node scripts/validate-release-contract.mjs",
    "release-contract validation",
  );

  const rootPackage = JSON.parse(files.get("package.json") ?? "{}");
  if (
    rootPackage.scripts?.["release:contract"] !==
    "node scripts/validate-release-contract.mjs"
  ) {
    errors.push(
      "package.json: release:contract script is not wired to the validator",
    );
  }
  if (
    rootPackage.scripts?.["test:release-contract"] !==
    "node --test scripts/validate-release-contract.test.mjs"
  ) {
    errors.push(
      "package.json: test:release-contract script is not wired to the validator tests",
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
        `${result.desktopLegs} desktop OS/arch legs, ${result.mobilePlatforms} executable mobile release jobs, ` +
        "Android arm64-v8a+x86_64, iOS device arm64.",
    );
    console.log(
      "The architecture-independent web/shared app graph is covered by the desktop release trigger.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
