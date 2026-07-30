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
  ".github/workflows/srn-admin.yml",
  ".github/workflows/srn-openclaw.yml",
  ".github/workflows/srn-desktop.yml",
  ".github/workflows/srn-mobile.yml",
  ".github/workflows/release-contract.yml",
  "app/.github/workflows/desktop.release.reuse.yml",
  "app/.github/workflows/mobile.release.prod.yml",
  "app/packages/mobile/android/gradle.properties",
  "docs/releases-and-upgrades.md",
  "openclaw/package.json",
  "openclaw/scripts/package-release.mjs",
  "openclaw/scripts/release-config.mjs",
  "openclaw/scripts/verify-release.mjs",
  "package.json",
  "scripts/analyze-release-impact.mjs",
  "scripts/analyze-release-impact.test.mjs",
  "scripts/fingerprint-release-tree.mjs",
  "scripts/fingerprint-release-tree.test.mjs",
]);

const TOOL_WORKFLOWS = Object.freeze([
  ".github/workflows/srn-client.yml",
  ".github/workflows/srn-server.yml",
  ".github/workflows/srn-mcp.yml",
  ".github/workflows/srn-home-server.yml",
  ".github/workflows/srn-admin.yml",
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

const SELECTIVE_RELEASE_WORKFLOWS = Object.freeze([
  [".github/workflows/srn-admin.yml", "srn-admin", "build"],
  [".github/workflows/srn-client.yml", "srn-client", "lint"],
  [".github/workflows/srn-desktop.yml", "srn-desktop", "version"],
  [".github/workflows/srn-home-server.yml", "srn-home-server", "build"],
  [".github/workflows/srn-mcp.yml", "srn-mcp", "lint"],
  [".github/workflows/srn-mobile.yml", "srn-mobile", "version"],
  [".github/workflows/srn-openclaw.yml", "srn-openclaw", "context"],
  [".github/workflows/srn-server.yml", "srn-server", "lint"],
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
    if (writePermissions !== 1) {
      errors.push(
        `${file}: expected contents: write only on the publication job, found ${writePermissions}`,
      );
    }
    for (const [fragment, description] of [
      ["force_release:", "audited force-release input"],
      ["force_reason:", "audited force reason input"],
    ]) {
      requireFragment(errors, file, workflow, fragment, description);
    }

    const impact = jobBlock(workflow, "impact");
    if (!impact) {
      errors.push(`${file}: missing release-impact analysis job`);
    } else {
      for (const [fragment, description] of [
        ["fetch-depth: 0", "complete Git history checkout"],
        ["git fetch --force --tags origin", "complete release tag fetch"],
        [
          "node scripts/analyze-release-impact.mjs",
          "release-impact analyzer invocation",
        ],
        [`--target ${target}`, `${target} analyzer target`],
        ['--force "${FORCE_RELEASE}"', "force flag forwarding"],
        ['--force-reason "${FORCE_REASON}"', "force reason forwarding"],
        ["base_ref:", "selected base-ref output"],
        ["reason_codes:", "machine-readable impact reasons"],
      ]) {
        requireFragment(errors, file, impact, fragment, description);
      }
    }

    const firstJob = jobBlock(workflow, firstJobName);
    if (!firstJob) {
      errors.push(`${file}: missing source-gated ${firstJobName} job`);
    } else {
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
        ["FORCED: ${{ needs.impact.outputs.forced }}", "audited force output"],
        ['if [ "$FORCED" = "true" ]; then', "audited force-only bypass"],
        ['gh release download "$BASE_REF"', "prior fingerprint download"],
        [".fingerprint", "release surface fingerprint"],
        ['echo "changed=false" >> "$GITHUB_OUTPUT"', "successful no-op output"],
      ]) {
        requireFragment(errors, file, decide, fragment, description);
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
        "if: needs.decide.outputs.changed == 'true'",
        "unchanged-release publication guard",
      );
      requireFragment(
        errors,
        file,
        release,
        "permissions:\n      contents: write",
        "publication-only write permission",
      );
    }

    if (target !== "srn-mobile") {
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
    } else {
      requireFragment(
        errors,
        file,
        workflow,
        'git show-ref --verify --quiet "refs/tags/$tag"',
        "mobile tag collision guard",
      );
    }
  }

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

  const homeServerWorkflowFile = ".github/workflows/srn-home-server.yml";
  const homeServerBuild = jobBlock(
    files.get(homeServerWorkflowFile) ?? "",
    "build",
  );
  for (const [fragment, description] of [
    [
      "node ../../../scripts/fingerprint-release-tree.mjs",
      "normalized home-server release fingerprint",
    ],
    ["--path home-server.cjs", "home-server executable fingerprint input"],
    ["--path migrations", "home-server migration fingerprint input"],
  ]) {
    requireFragment(
      errors,
      homeServerWorkflowFile,
      homeServerBuild,
      fragment,
      description,
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
  for (const [fragment, description] of [
    ["branches: [main]", "OpenClaw auto-release trigger on main"],
    ['- "openclaw/**"', "OpenClaw workspace release trigger path"],
    ['- "srn-openclaw-v*"', "OpenClaw explicit release tag trigger"],
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
    [
      "needs: [context, package, decide, smoke]",
      "all-target OpenClaw release fan-in",
    ],
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
      ['version="${YY}.$((max + 1))"', "rolling YY.N OpenClaw version"],
      ['tag="${TOOL}-v${version}"', "namespaced OpenClaw release tag"],
      // openclaw/scripts/release-config.mjs only accepts a strict
      // `srn-openclaw-v<semver>` tag, and the release identity `YY.N` is not
      // semver, so the packaged artifact's version is computed separately.
      ["package_version=${version}.0", "semver package version for packaging"],
      // The explicit-tag escape hatch must keep asserting that the tag it was
      // handed is the version openclaw/package.json declares.
      [
        'if [ "${version}" != "${declared_version}" ]; then',
        "explicit-tag version assertion against openclaw/package.json",
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
        "--exclude package/release-package.json",
        "volatile source metadata exclusion",
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

  // Signing and publishing are separate jobs because permissions are per-job:
  // the attester signs with the Sigstore/attestation scopes and only reads the
  // repository, the publisher writes with nothing but `contents: write`.
  const openClawAttest = jobBlock(openClawWorkflow, "attest");
  if (!openClawAttest) {
    errors.push(`${openClawWorkflowFile}: missing OpenClaw attestation job`);
  } else {
    for (const [fragment, description] of [
      ["artifact-metadata: write", "artifact metadata permission"],
      ["attestations: write", "attestation permission"],
      ["id-token: write", "provenance signing permission"],
      ["outputs.bundle-path", "published Sigstore provenance bundle"],
      ['sha256sum "${provenance}" >> SHA256SUMS.txt', "provenance checksum"],
      // The attested payload is exactly what gets published, so it must reach
      // the publisher intact and an empty handoff must fail the job rather than
      // publish a release with no artifacts.
      [
        "name: srn-openclaw-attested-package",
        "attested payload handoff to the publisher",
      ],
      ["if-no-files-found: error", "required attested payload upload"],
    ]) {
      requireFragment(
        errors,
        openClawWorkflowFile,
        openClawAttest,
        fragment,
        description,
      );
    }
  }

  const openClawRelease = jobBlock(openClawWorkflow, "release");
  for (const [fragment, description] of [
    // Publication still fans in over every gate: attest needs
    // [context, package, smoke], so no failed smoke target can be published.
    ["needs: [context, decide, attest]", "attested OpenClaw release fan-in"],
    ["contents: write", "release publication permission"],
    [
      "name: srn-openclaw-attested-package",
      "attested payload as the published payload",
    ],
    [
      "sha256sum --check SHA256SUMS.txt",
      "attested payload re-verified before publication",
    ],
    ["--verify-tag", "existing tag verification"],
    // A tag handed to the workflow must already exist, so a typo cannot publish
    // a brand new tag; a rolling release derives its own tag and has nothing to
    // verify against.
    ['if [ "${VERIFY_TAG}" = "true" ]; then', "explicit-tag verification gate"],
    ['--title "${TOOL} ${VERSION}"', "srn-* OpenClaw release title convention"],
  ]) {
    requireFragment(
      errors,
      openClawWorkflowFile,
      openClawRelease,
      fragment,
      description,
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

  // Desktop must version and tag itself like every other srn-* component:
  // rolling `YY.N` discovered from the existing releases, published under a
  // NAMESPACED `srn-desktop-v<version>` tag. A bare `v<version>` tag would hand
  // desktop the repo-global tag namespace and the "Latest" release badge, which
  // is what the old `YY.M.<run>` scheme did.
  const rootDesktopVersion = jobBlock(rootDesktop, "version");
  if (!rootDesktopVersion) {
    errors.push(`${rootDesktopFile}: missing desktop version job`);
  } else {
    for (const [fragment, description] of [
      ['version="${YY}.$((max + 1))"', "rolling YY.N desktop version"],
      ["tag=${TOOL}-v${version}", "namespaced desktop release tag"],
      // electron-updater refuses a non-semver app version outright
      // (ERR_UPDATER_INVALID_VERSION), so the release identity `YY.N` and the
      // semver baked into the app must be computed separately.
      ["app_version=${version}.0", "semver app version for electron-updater"],
    ]) {
      requireFragment(
        errors,
        rootDesktopFile,
        rootDesktopVersion,
        fragment,
        description,
      );
    }
    if (/\btag=v\$\{version\}/.test(rootDesktopVersion)) {
      errors.push(
        `${rootDesktopFile}: desktop must not publish an unnamespaced v* tag`,
      );
    }
  }
  // The app version electron-builder bakes in must be the semver one.
  requireFragment(
    errors,
    rootDesktopFile,
    rootDesktop,
    "-c.extraMetadata.version=${{ needs.version.outputs.app_version }}",
    "semver app version injected into electron-builder",
  );

  // The Snap target was removed outright (snapcraft 8 dropped the `snapcraft
  // snap` subcommand electron-builder's legacy core22 path hardcodes), so the
  // build matrix is now the whole of the desktop pipeline. Its artifact upload
  // therefore carries the guard the Snap job used to: an empty upload must fail
  // the leg rather than silently release fewer installers than were built.
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
      ["find dist -type f -name app.asar", "actual packaged asar discovery"],
      ["yarn exec asar extract", "packaged desktop runtime extraction"],
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
  }
  // No desktop leg may be best-effort: every job in this workflow gates the
  // release, so a `continue-on-error` anywhere would let a broken installer
  // through. (This replaces the narrower guard that only covered the Snap job.)
  if (/continue-on-error:\s*true/.test(rootDesktop)) {
    errors.push(
      `${rootDesktopFile}: no desktop release leg may be best-effort (continue-on-error)`,
    );
  }

  const rootDesktopRelease = jobBlock(rootDesktop, "release");
  for (const [fragment, description] of [
    // Every remaining leg must gate the release, so a broken macOS, Windows or
    // Linux build can never publish. `build` is the whole OS/arch matrix.
    [
      "needs: [version, build, decide]",
      "desktop release fan-in over every leg",
    ],
    [
      "tag_name: ${{ needs.version.outputs.tag }}",
      "namespaced desktop release tag reference",
    ],
    [
      "name: srn-desktop ${{ needs.version.outputs.version }}",
      "srn-* desktop release title convention",
    ],
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
      /^\s*--latest=false\b/gm,
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
  }
  // The mirror image: desktop is the one component that must keep the pointer,
  // because that is how electron-updater finds its channel file at all.
  if (
    rootDesktop.includes("make_latest: 'false'") ||
    rootDesktop.includes("--latest=false")
  ) {
    errors.push(
      `${rootDesktopFile}: srn-desktop must claim the repo-global Latest pointer`,
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

  const rootMobileFingerprint = jobBlock(rootMobile, "fingerprint");
  if (!rootMobileFingerprint) {
    errors.push(`${rootMobileFile}: missing pre-publication fingerprint job`);
  } else {
    for (const [fragment, description] of [
      ["--platform android", "deterministic Android JavaScript bundle"],
      ["--platform ios", "deterministic iOS JavaScript bundle"],
      [
        "rm -rf html/Web.bundle/src/web-src .release-impact",
        "stale embedded-web payload cleanup",
      ],
      [
        "--normalize-package-version app/packages/mobile/package.json",
        "rolling mobile version normalization",
      ],
      [
        '--output "release-fingerprint/srn-mobile.fingerprint"',
        "normalized mobile release fingerprint",
      ],
      ["if-no-files-found: error", "required mobile fingerprint upload"],
    ]) {
      requireFragment(
        errors,
        rootMobileFile,
        rootMobileFingerprint,
        fragment,
        description,
      );
    }
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
        "needs: [version, decide, android, ios]",
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
      ["test -s srn-mobile.fingerprint", "mobile fingerprint release asset"],
      ['test "${#files[@]}" -eq 4', "complete mobile release payload"],
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
  for (const triggerPath of [
    ".github/workflows/srn-mobile.yml",
    ".github/workflows/srn-openclaw.yml",
    "scripts/analyze-release-impact.mjs",
    "scripts/analyze-release-impact.test.mjs",
    "scripts/fingerprint-release-tree.mjs",
    "scripts/fingerprint-release-tree.test.mjs",
    "docs/releases-and-upgrades.md",
  ]) {
    const declaration = `- '${triggerPath}'`;
    const count = countOccurrences(ci, declaration);
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
    "node scripts/validate-release-contract.mjs",
    "release-contract validation",
  );
  for (const [fragment, description] of [
    ["fetch-depth: 0", "complete report history checkout"],
    ["git fetch --force --tags origin", "complete report tag fetch"],
    ["--all-workspaces all", "all-workspace release analysis"],
    ["--output release-impact.json", "machine-readable release report"],
    ["--report release-impact.md", "readable release report"],
    ["actions/upload-artifact@v7", "release report artifact publication"],
    ['cat release-impact.md >> "$GITHUB_STEP_SUMMARY"', "readable job summary"],
  ]) {
    requireFragment(errors, ciFile, ci, fragment, description);
  }

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
  if (
    rootPackage.scripts?.["release:impact"] !==
    "node scripts/analyze-release-impact.mjs"
  ) {
    errors.push(
      "package.json: release:impact script is not wired to the analyzer",
    );
  }
  if (
    rootPackage.scripts?.["release:report"] !==
    "node scripts/analyze-release-impact.mjs --all-workspaces all --output release-impact.json --report release-impact.md"
  ) {
    errors.push(
      "package.json: release:report script is not wired to both report formats",
    );
  }
  if (
    rootPackage.scripts?.["test:release-impact"] !==
    "node --test scripts/analyze-release-impact.test.mjs scripts/fingerprint-release-tree.test.mjs"
  ) {
    errors.push(
      "package.json: test:release-impact script is not wired to analyzer and fingerprint tests",
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
    ["divergentNewerReleaseRefs", "diagnostic divergent-newer release refs"],
    ["no-ancestor-baseline", "explicit no-ancestor baseline policy"],
    ["createReleaseAnalysisContext", "shared release-analysis context"],
    ["BigInt(", "arbitrary-precision tag ordering"],
    ["release-managed", "managed workspace classification"],
    ["publishable-unmanaged", "unmanaged workspace classification"],
    [
      "discoverStandaloneManagedPackages",
      "standalone managed-package inventory",
    ],
    ["renderReleaseImpactReport", "readable release report renderer"],
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

  const releasesDocFile = "docs/releases-and-upgrades.md";
  const releasesDoc = files.get(releasesDocFile) ?? "";
  for (const [fragment, description] of [
    ["divergent off-history tag", "divergent-tag baseline behavior"],
    ["unique latest ancestor by", "hybrid topological baseline behavior"],
    ["release-version", "hybrid package-version collision policy"],
    ["`release-managed`", "managed workspace category"],
    ["`publishable-unmanaged`", "unmanaged workspace category"],
    ["does not infer or create publishing", "non-publisher disclaimer"],
    ["all 44 manifests", "current Yarn-workspace inventory count"],
    ["two standalone managed CLI manifests", "standalone CLI inventory scope"],
    ["all eight publishers", "complete managed-product count"],
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
