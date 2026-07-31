import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadReleaseContractFiles,
  validateReleaseContract,
} from "./validate-release-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseline = loadReleaseContractFiles(repositoryRoot);

function withFileChanged(file, update) {
  const files = new Map(baseline);
  files.set(file, update(files.get(file)));
  return files;
}

test("the repository satisfies the release contract", () => {
  assert.deepEqual(validateReleaseContract(baseline), []);
});

test("a missing native tool target is rejected", () => {
  const file = "scripts/release-packaging-contract.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace(
      '      Object.freeze({ output: "windows-arm64.exe", target: "win-arm64" }),\n',
      "",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /release-packaging-contract\.mjs: missing native target contract win-arm64/,
  );
});

test("an extra native tool target is rejected", () => {
  const file = "scripts/release-packaging-contract.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace(
      '      Object.freeze({ output: "linux-arm64", target: "linux-arm64" }),\n',
      '      Object.freeze({ output: "linux-arm64", target: "linux-arm64" }),\n      Object.freeze({ output: "linux-riscv64", target: "linux-riscv64" }),\n',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /release-packaging-contract\.mjs: missing exact native target matrix/,
  );
});

test("native workflows cannot bypass the canonical target plan", () => {
  const file = "scripts/native-cli-release.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "packagingContract.targets.map((target) =>",
      "[].map((target) =>",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /native-cli-release\.mjs: missing contract-driven target plan/,
  );
});

test("native execution cannot bypass its fingerprinted invocation plan", () => {
  const file = "scripts/native-cli-release.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "spawn(invocation.executable, invocation.args",
      'spawn("npx", ["--yes", "@yao-pkg/pkg@latest"]',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /native-cli-release\.mjs: missing canonical shell-free invocation execution/,
  );
});

test("native runtime, packager flags, and workflow actions cannot drift from the contract", () => {
  const contractFile = "scripts/release-packaging-contract.mjs";
  let files = withFileChanged(contractFile, (content) =>
    content
      .replace('embeddedRuntime: "node24"', 'embeddedRuntime: "node26"')
      .replace(
        'flags: Object.freeze(["--no-signature"])',
        "flags: Object.freeze([])",
      ),
  );
  let errors = validateReleaseContract(files).join("\n");
  assert.match(errors, /missing native embedded runtime contract/);
  assert.match(errors, /missing native packager flag contract/);

  files = withFileChanged(".github/workflows/srn-client.yml", (content) =>
    content.replaceAll("actions/setup-node@v7", "actions/setup-node@v8"),
  );
  errors = validateReleaseContract(files).join("\n");
  assert.match(errors, /srn-client\.yml: missing contract-bound native action/);
});

test("all publishers self-validate the release contract before impact analysis", () => {
  for (const file of [
    ".github/workflows/srn-admin.yml",
    ".github/workflows/srn-client.yml",
    ".github/workflows/srn-desktop.yml",
    ".github/workflows/srn-home-server.yml",
    ".github/workflows/srn-mcp.yml",
    ".github/workflows/srn-mobile.yml",
    ".github/workflows/srn-openclaw.yml",
    ".github/workflows/srn-server.yml",
  ]) {
    const files = withFileChanged(file, (content) =>
      content.replace(
        "        run: node scripts/validate-release-contract.mjs\n",
        "",
      ),
    );
    assert.match(
      validateReleaseContract(files).join("\n"),
      new RegExp(
        `${path.basename(file).replace(".", "\\.")}: missing in-chain packaging contract validation`,
      ),
    );
  }
});

test("publisher contract validation cannot move behind impact analysis", () => {
  const file = ".github/workflows/srn-mcp.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "      - name: Validate release packaging contract\n        run: node scripts/validate-release-contract.mjs\n\n      - id: impact",
        "      - id: impact",
      )
      .replace(
        '          } >> "$GITHUB_STEP_SUMMARY"\n',
        '          } >> "$GITHUB_STEP_SUMMARY"\n\n      - name: Validate release packaging contract\n        run: node scripts/validate-release-contract.mjs\n',
      ),
  );
  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-mcp\.yml: packaging contract validation must run before release-impact analysis/,
  );
});

test("a missing OpenClaw native smoke target is rejected", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "          - target: windows-arm64\n            runner: windows-11-arm\n            architecture: arm64\n",
      "",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /expected one windows-arm64 smoke target on windows-11-arm/,
  );
});

test("fake native OpenClaw archives are rejected", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replaceAll("-node-any.tgz", "-windows-x64.zip"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /platform-neutral OpenClaw must not publish fake native archives/,
  );
});

test("mutable OpenClaw action references are rejected", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
      "actions/checkout@v7",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /mutable action reference actions\/checkout@v7/,
  );
});

test("the real OpenClaw live E2E remains release-blocking", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "yarn workspace @standard-red-notes/openclaw test:e2e",
      "yarn workspace @standard-red-notes/openclaw build",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing real OpenClaw live MCP E2E gate/,
  );
});

test("every OpenClaw runtime dependency must stay bundled", () => {
  const file = "openclaw/package.json";
  const files = withFileChanged(file, (content) => {
    const packageJson = JSON.parse(content);
    packageJson.bundleDependencies = packageJson.bundleDependencies.filter(
      (dependency) => dependency !== "zod",
    );
    return JSON.stringify(packageJson);
  });

  assert.match(
    validateReleaseContract(files).join("\n"),
    /every runtime dependency must be bundled/,
  );
});

function withOpenClawPackage(update) {
  return withFileChanged("openclaw/package.json", (content) => {
    const packageJson = JSON.parse(content);
    update(packageJson);
    return JSON.stringify(packageJson);
  });
}

test("the Yarn-normalized OpenClaw manifest still satisfies the contract", () => {
  // `yarn install` rewrites the workspace manifest: `private: false` is dropped
  // because it is Yarn's default, and the single-entry `bin` map collapses to a
  // bare string. Both forms declare the same release package.
  const files = withOpenClawPackage((packageJson) => {
    delete packageJson.private;
    packageJson.bin = "dist/index.js";
  });

  assert.deepEqual(validateReleaseContract(files), []);
});

test("a private OpenClaw release package is rejected", () => {
  const files = withOpenClawPackage((packageJson) => {
    packageJson.private = true;
  });

  assert.match(
    validateReleaseContract(files).join("\n"),
    /release package must not be private/,
  );
});

test("a missing OpenClaw executable is rejected", () => {
  const files = withOpenClawPackage((packageJson) => {
    delete packageJson.bin;
  });

  assert.match(
    validateReleaseContract(files).join("\n"),
    /must expose bin\.openclaw as dist\/index\.js/,
  );
});

test("an OpenClaw executable pointing at the wrong entrypoint is rejected", () => {
  const files = withOpenClawPackage((packageJson) => {
    packageJson.bin = "dist/cli.js";
  });

  assert.match(
    validateReleaseContract(files).join("\n"),
    /must expose bin\.openclaw as dist\/index\.js/,
  );
});

test("an OpenClaw executable published under another name is rejected", () => {
  const files = withOpenClawPackage((packageJson) => {
    packageJson.bin = { claw: "dist/index.js" };
  });

  assert.match(
    validateReleaseContract(files).join("\n"),
    /must expose bin\.openclaw as dist\/index\.js/,
  );
});

// OpenClaw auto-releases on every push to main, versioned and tagged like every
// other srn-* component: rolling `YY.N` under a namespaced `srn-openclaw-v*`
// tag. The previous scheme released only from a pushed tag.
const openClawWorkflowFile = ".github/workflows/srn-openclaw.yml";

test("dropping the OpenClaw auto-release trigger is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace("    branches: [main]\n", ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing OpenClaw auto-release trigger on main/,
  );
});

test("dropping the OpenClaw workspace trigger path is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace('      - "openclaw/**"\n', ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing OpenClaw workspace release trigger path/,
  );
});

test("an unnamespaced OpenClaw release tag is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace('tag="${TOOL}-v${version}"', 'tag="v${version}"'),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: OpenClaw must not publish an unnamespaced v\* tag/,
  );
});

test("dropping the namespaced OpenClaw tag is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      'tag="${TOOL}-v${version}"',
      'tag="srn-openclaw-${version}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing namespaced OpenClaw release tag/,
  );
});

test("reverting OpenClaw to a tag-parsed version is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      'version="${YY}.${next}"',
      'version="$(date -u +%y).${GITHUB_RUN_NUMBER}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing rolling YY\.N OpenClaw version/,
  );
});

test("OpenClaw rolling versions cannot reuse an explicit SemVer package identity", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      '            while git show-ref --verify --quiet "refs/tags/${TOOL}-v${YY}.${next}.0"; do\n',
      "            while false; do\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing explicit SemVer package-version reservation/,
  );
});

// release-config.mjs only accepts `srn-openclaw-v<semver>`, and `26.1` is not
// semver, so the packaged artifact must carry `26.1.0`.
test("packaging OpenClaw under the non-semver release version is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      "            package_version=${version}.0\n",
      "            package_version=${version}\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing semver package version for packaging/,
  );
});

test("packaging OpenClaw with the release identity instead of the semver tag is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      '--tag "${{ needs.context.outputs.package_tag }}"',
      '--tag "${{ needs.context.outputs.tag }}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing semver packaging tag/,
  );
});

// Without the stamp the packaged tarball would ship openclaw/package.json's
// placeholder development version, and package-release.mjs's own tag/manifest
// equality assertion would no longer be satisfiable by the rolling version.
test("dropping the OpenClaw release version stamp is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      "            manifest.version = process.env.PACKAGE_VERSION;\n",
      "",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing release version stamped into the packaged manifest/,
  );
});

test("dropping the explicit-tag version assertion is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      'if [ "${version}" != "${declared_version}" ]; then',
      "if false; then",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing explicit-tag version assertion against openclaw\/package\.json/,
  );
});

// --verify-tag must stay conditional on an explicitly requested tag: unguarded
// it would abort every rolling release, and dropping the guard's condition
// would let a mistyped manual tag be created by the release step.
test("dropping the OpenClaw explicit-tag verification gate is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace('if [ "${VERIFY_TAG}" = "true" ]; then', "if true; then"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing explicit-tag verification gate/,
  );
});

test("a non-srn-* OpenClaw release title is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      '--title "${TOOL} ${VERSION}"',
      '--title "OpenClaw ${VERSION}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing srn-\* OpenClaw release title convention/,
  );
});

// Signing and publishing are separate jobs because permissions are per-job.
// Held together, `gh release create` returned "HTTP 403: Resource not
// accessible by integration" from POST /releases even though the runner
// reported `Contents: write`, while every other srn-* publisher -- carrying
// `contents: write` and nothing else -- publishes fine.
test("removing the OpenClaw attestation job is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(/\r?\n  attest:\r?\n/, "\n  Removed-attest:\n"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing OpenClaw attestation job/,
  );
});

test("an attestation scope on the OpenClaw publish job is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      "      contents: write\n    steps:\n      - name: Download attested release package",
      "      contents: write\n      attestations: write\n    steps:\n      - name: Download attested release package",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /publish job must not request 'attestations: write'/,
  );
});

test("dropping the attested payload from the OpenClaw release fan-in is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      "needs: [context, decide, attest]",
      "needs: [context, attest]",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing attested OpenClaw release fan-in/,
  );
});

test("a best-effort attested payload handoff is rejected", () => {
  const files = withFileChanged(openClawWorkflowFile, (content) =>
    content.replace(
      "          name: srn-openclaw-attested-package\n          path: out/*\n          if-no-files-found: error\n",
      "          name: srn-openclaw-attested-package\n          path: out/*\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing required attested payload upload/,
  );
});

// Yarn's node-modules linker writes node_modules/.bin/* as symlinks on Linux,
// which the release payload walk rejected outright -- no OpenClaw release could
// be packaged at all. The allowance that unblocks it must stay scoped to
// `.bin`, because a walk that skips symlinks anywhere can step over a link to a
// native addon and silently defeat the platform-neutrality guard.
const openClawPackagerFile = "openclaw/scripts/package-release.mjs";

test("dropping the bin-shim symlink allowance is rejected", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      '    } else if (entry.isSymbolicLink() && path.basename(directory) === ".bin") {\n',
      "    } else if (false) {\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: missing bin-shim-only symlink allowance/,
  );
});

test("broadening the symlink allowance beyond .bin is rejected", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      'entry.isSymbolicLink() && path.basename(directory) === ".bin"',
      "entry.isSymbolicLink()",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: 1 symlink allowance\(s\) but 0 scoped to \.bin/,
  );
});

test("a second unscoped symlink allowance is rejected", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      "    } else if (entry.isSymbolicLink() &&",
      "    } else if (entry.isSymbolicLink()) {\n      continue;\n    } else if (entry.isSymbolicLink() &&",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: 2 symlink allowance\(s\) but 1 scoped to \.bin/,
  );
});

// openclaw is a root yarn workspace, so an install collapses its `bin` map to
// the bare string form and drops `private: false`. This validator already
// accepts that shape (cb979521); the release scripts must accept exactly the
// same one, or a manifest that passes the contract would fail the release.
const openClawVerifierFile = "openclaw/scripts/verify-release.mjs";

test("a packager that rejects the Yarn-normalized bin shape is rejected", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      'const unscopedName = String(packageJson.name ?? "").replace(/^@[^/]+\\//, "");\n  return unscopedName === "openclaw" ? bin : undefined;',
      "return undefined;",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: missing bin string form scoped to the openclaw executable/,
  );
});

test("a verifier that rejects the Yarn-normalized bin shape is rejected", () => {
  const files = withFileChanged(openClawVerifierFile, (content) =>
    content.replace(
      'const unscopedName = String(packageJson.name ?? "").replace(/^@[^/]+\\//, "");\n  return unscopedName === "openclaw" ? bin : undefined;',
      "return undefined;",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /verify-release\.mjs: missing bin string form scoped to the openclaw executable/,
  );
});

test("dropping the packaged bin target assertion is rejected", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      "package bin.openclaw must point to dist/index.js",
      "package bin is fine",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: missing packaged bin target assertion/,
  );
});

test("dropping the installed bin target assertion is rejected", () => {
  const files = withFileChanged(openClawVerifierFile, (content) =>
    content.replace('binTarget(packageJson) !== "dist/index.js"', "false"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /verify-release\.mjs: missing installed bin target assertion/,
  );
});

test("the native addon rejection survives the symlink allowance", () => {
  const files = withFileChanged(openClawPackagerFile, (content) =>
    content.replace(
      "platform-neutral package cannot contain native addons",
      "package contains native addons",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /package-release\.mjs: missing native addon rejection/,
  );
});

test("a missing app Windows release job is rejected", () => {
  const file = "app/.github/workflows/desktop.release.reuse.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(/\r?\n  Windows:\r?\n/, "\n  Removed-Windows:\n"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /desktop\.release\.reuse\.yml: missing Windows job/,
  );
});

// The desktop Snap target was removed outright: snapcraft 8 dropped the
// `snapcraft snap` subcommand that electron-builder's legacy core22 path
// hardcodes, and migrating to snapcraft.core24 was declined. What remains --
// the OS/arch build matrix -- must still gate the release completely.
const desktopWorkflowFile = ".github/workflows/srn-desktop.yml";

test("the desktop pipeline carries no Snap target", () => {
  const workflow = baseline.get(desktopWorkflowFile);

  // Prose about why Snap went away is fine; a Snap job, a snapcraft install or
  // a snap electron-builder invocation is not.
  assert.doesNotMatch(workflow, /\r?\n {2}snap:\r?\n/);
  assert.doesNotMatch(
    workflow,
    /snap install snapcraft|--linux snap|srn-desktop-linux-snap/,
  );
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.deepEqual(validateReleaseContract(baseline), []);
});

test("a removed desktop build matrix is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(/\r?\n  build:\r?\n/, "\n  Removed-build:\n"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing desktop build matrix/,
  );
});

test("a partial desktop build matrix is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace("      fail-fast: false\n", ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing complete desktop build matrix/,
  );
});

test("a best-effort desktop installer upload is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace("          if-no-files-found: error\n", ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing required desktop installer upload/,
  );
});

test("a best-effort desktop build leg is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      "    runs-on: ${{ matrix.os }}\n",
      "    runs-on: ${{ matrix.os }}\n    continue-on-error: true\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /no desktop release leg may be best-effort/,
  );
});

test("dropping the build matrix from the desktop release fan-in is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      "needs: [version, build, decide]",
      "needs: [version, decide]",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing desktop release fan-in over every leg/,
  );
});

// Desktop versions and tags like every other srn-* component: rolling `YY.N`
// under a namespaced `srn-desktop-v*` tag. The old `YY.M.<run>` scheme tagged a
// bare `v*`, taking the repo-global tag namespace and the "Latest" badge.
test("an unnamespaced desktop release tag is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace('echo "tag=${TOOL}-v${version}"', 'echo "tag=v${version}"'),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: desktop must not publish an unnamespaced v\* tag/,
  );
});

test("dropping the namespaced desktop tag is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      'echo "tag=${TOOL}-v${version}"',
      'echo "tag=srn-desktop-${version}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing namespaced desktop release tag/,
  );
});

test("reverting the desktop version to the run-number scheme is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      'version="${YY}.$((max + 1))"',
      'version="$(date -u +%y).$(date -u +%-m).${GITHUB_RUN_NUMBER}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing rolling YY\.N desktop version/,
  );
});

// electron-updater throws ERR_UPDATER_INVALID_VERSION on a non-semver app
// version, and `26.1` is not semver, so the app must be built with `YY.N.0`.
test("baking the non-semver release version into the app is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      "-c.extraMetadata.version=${{ needs.version.outputs.app_version }}",
      "-c.extraMetadata.version=${{ needs.version.outputs.version }}",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing semver app version injected into electron-builder/,
  );
});

test("a non-srn-* desktop release title is rejected", () => {
  const files = withFileChanged(desktopWorkflowFile, (content) =>
    content.replace(
      "name: srn-desktop ${{ needs.version.outputs.version }}",
      "name: Standard Red Notes Desktop ${{ needs.version.outputs.version }}",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: missing srn-\* desktop release title convention/,
  );
});

test("suppressed desktop checksum failures are rejected", () => {
  const file = ".github/workflows/srn-desktop.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      'sha256sum "${files[@]}" > SHA256SUMS.txt',
      'sha256sum "${files[@]}" > SHA256SUMS.txt || true',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /desktop checksum failures must not be suppressed/,
  );
});

test("root mobile release paths must be monorepo-relative", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replaceAll(
      "node-version-file: app/.nvmrc",
      "node-version-file: .nvmrc",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing app-relative Node version path/,
  );
});

test("root Android architecture validation is required", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("for arch in arm64-v8a x86_64", "for arch in arm64-v8a"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing required Android native architectures/,
  );
});

test("root iOS release artifact upload is required", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("name: srn-mobile-ios", "name: removed-ios-artifact"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing validated iOS artifact upload/,
  );
});

test("missing Android release architectures are rejected", () => {
  const file = "app/packages/mobile/android/gradle.properties";
  const files = withFileChanged(file, (content) =>
    content.replace(",x86_64", ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /reactNativeArchitectures is missing x86_64/,
  );
});

test("a missing iOS arm64 artifact assertion is rejected", () => {
  const file = "app/.github/workflows/mobile.release.prod.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("Verify iOS device arm64 artifact", "Verify iOS artifact"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /missing iOS device architecture assertion step/,
  );
});

test("a non-desktop softprops release that claims the Latest pointer is rejected", () => {
  const file = ".github/workflows/srn-admin.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("          make_latest: 'false'\n", ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-admin\.yml: 1 'uses: softprops\/action-gh-release' release step\(s\) but 0 'make_latest: 'false'' opt-out\(s\)/,
  );
});

test("a non-desktop gh release that claims the Latest pointer is rejected", () => {
  const file = ".github/workflows/srn-server.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("--latest=false", "--draft=false"),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-server\.yml: 1 'gh release create' release step\(s\) but 0 '--latest=false' opt-out\(s\)/,
  );
});

test("a second non-desktop release step without the opt-out is rejected", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      'gh release create "${TAG}"',
      'gh release create "${TAG}-extra"\n          gh release create "${TAG}"',
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: 2 'gh release create' release step\(s\) but 1 '--latest=false' opt-out\(s\)/,
  );
});

test("srn-desktop giving away the Latest pointer is rejected", () => {
  const file = ".github/workflows/srn-desktop.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "          draft: false\n",
      "          draft: false\n          make_latest: 'false'\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-desktop\.yml: srn-desktop must claim the repo-global Latest pointer/,
  );
});

test("every publisher must fetch complete history and tags before impact analysis", () => {
  const file = ".github/workflows/srn-server.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace("          fetch-depth: 0\n", "")
      .replace("          git fetch --force --tags origin\n", ""),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-server\.yml: missing complete Git history checkout/,
  );
  assert.match(errors, /srn-server\.yml: missing complete release tag fetch/);
});

test("a publisher cannot tag without the unchanged-artifact decision", () => {
  const file = ".github/workflows/srn-home-server.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "  release:\n    name: release\n    needs: [decide, package]\n    if: needs.decide.outputs.changed == 'true'\n",
      "  release:\n    name: release\n    needs: [package]\n",
    ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-home-server\.yml: release publication does not depend on decide/,
  );
  assert.match(
    errors,
    /srn-home-server\.yml: missing unchanged-release publication guard/,
  );
});

test("fingerprints must compare against the analyzer-selected base", () => {
  const file = ".github/workflows/srn-client.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "BASE_REF: ${{ needs.impact.outputs.base_ref }}",
      "BASE_REF: srn-client-v00.1",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-client\.yml: missing analyzer-selected fingerprint base/,
  );
});

test("home-server fingerprints include the shipped migration payload", () => {
  const file = ".github/workflows/srn-home-server.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("            --path dist/bundle/migrations \\\n", ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-home-server\.yml: missing home-server migration fingerprint input/,
  );
});

test("home-server migration packaging remains in the canonical product plan", () => {
  const file = "scripts/release-packaging-contract.mjs";
  const files = withFileChanged(file, (content) =>
    content.replace('            executable: "zip",\n', ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /release-packaging-contract\.mjs: missing home-server migration archive executable/,
  );
});

test("desktop packaging fingerprints bind lock, patches, config, toolchain, and target args", () => {
  const file = ".github/workflows/srn-desktop.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace('            cp ../../yarn.lock "$contract/app-yarn.lock"\n', "")
      .replace(
        '            cp -a ../../.yarn/patches "$contract/yarn-patches"\n',
        "",
      )
      .replace(
        '            cp package.json "$contract/desktop-package.json"\n',
        "",
      )
      .replace(
        '              --metadata "electronVersion=${electron_version}" \\\n',
        "",
      )
      .replace("actions/setup-python@v6", "actions/setup-python@v7")
      .replace(
        "builder: '--linux AppImage deb --arm64'",
        "builder: '--linux AppImage rpm --arm64'",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");
  assert.match(errors, /missing desktop lockfile packaging input/);
  assert.match(errors, /missing desktop Yarn patch inputs/);
  assert.match(errors, /missing desktop electron-builder configuration input/);
  assert.match(errors, /missing effective Electron metadata/);
  assert.match(errors, /missing contract-bound desktop Python action/);
  assert.match(errors, /missing Linux arm64 build leg/);
  assert.match(errors, /missing contract-bound desktop target or runner/);
});

test("OpenClaw package fingerprints normalize release-only metadata", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace("--normalize-package-version package/package.json \\\n", "")
      .replace(
        "--normalize-json-field package/release-package.json=/release/sourceCommit \\\n",
        "",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(errors, /missing rolling package-version normalization/);
  assert.match(errors, /missing volatile source-commit normalization/);
});

test("mobile packaging fingerprints bind dependency locks and native toolchains", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace("            --path app/yarn.lock \\\n", "")
      .replace("            --path app/packages/mobile/Gemfile.lock \\\n", "")
      .replace("actions/setup-java@v5.5.0", "actions/setup-java@v6")
      .replaceAll("ruby/setup-ruby@v1.319.0", "ruby/setup-ruby@v2")
      .replace(
        "maxim-lobanov/setup-xcode@v1.7.0",
        "maxim-lobanov/setup-xcode@v2",
      )
      .replace("java-version: '17'", "java-version: '21'")
      .replaceAll("ruby-version: '3.4.7'", "ruby-version: '3.5.0'")
      .replace("xcode-version: '26'", "xcode-version: '27'")
      .replace("runs-on: macos-15", "runs-on: macos-16"),
  );
  const errors = validateReleaseContract(files).join("\n");
  assert.match(
    errors,
    /missing mobile deterministic packaging input 'app\/yarn\.lock'/,
  );
  assert.match(
    errors,
    /missing mobile deterministic packaging input 'app\/packages\/mobile\/Gemfile\.lock'/,
  );
  assert.match(errors, /missing contract-bound Android Java action/);
  assert.match(errors, /missing contract-bound mobile Ruby action/);
  assert.match(errors, /missing contract-bound Xcode action/);
  assert.match(errors, /missing contract-bound Java version/);
  assert.match(errors, /missing contract-bound Ruby version/);
  assert.match(errors, /missing contract-bound Xcode version/);
  assert.match(
    errors,
    /missing contract-bound mobile runner or publication command/,
  );
});

test("mobile publication cannot include a stale embedded web payload", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "          rm -rf html/Web.bundle/src/web-src .release-impact\n",
      "          rm -rf .release-impact\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-mobile\.yml: missing stale embedded-web payload cleanup/,
  );
});

test("release-contract CI runs when release analysis or OpenClaw gating changes", () => {
  const file = ".github/workflows/release-contract.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace("      - '.github/workflows/srn-openclaw.yml'\n", "")
      .replace("      - 'scripts/fingerprint-release-tree.mjs'\n", "")
      .replace("      - 'scripts/compare-release-fingerprints.mjs'\n", "")
      .replace("      - 'scripts/validate-release-contract.mjs'\n", ""),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /release-contract\.yml: expected \.github\/workflows\/srn-openclaw\.yml in both push and pull_request paths, found 1/,
  );
  assert.match(
    errors,
    /release-contract\.yml: expected scripts\/fingerprint-release-tree\.mjs in both push and pull_request paths, found 1/,
  );
  assert.match(
    errors,
    /release-contract\.yml: expected scripts\/compare-release-fingerprints\.mjs in both push and pull_request paths, found 1/,
  );
  assert.match(
    errors,
    /release-contract\.yml: expected scripts\/validate-release-contract\.mjs in both push and pull_request paths, found 1/,
  );
});

test("publisher concurrency and write permissions stay product-scoped", () => {
  const file = ".github/workflows/srn-admin.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "permissions:\n  contents: read",
        "permissions:\n  contents: write",
      )
      .replace(
        "concurrency:\n  group: srn-admin-release\n  cancel-in-progress: false\n\n",
        "",
      )
      .replace("    permissions:\n      contents: write\n", ""),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-admin\.yml: missing read-only workflow permissions/,
  );
  assert.match(errors, /srn-admin\.yml: missing per-product concurrency/);
  assert.match(
    errors,
    /srn-admin\.yml: missing non-cancelling release concurrency/,
  );
  assert.match(
    errors,
    /srn-admin\.yml: missing publication-only write permission/,
  );
});

test("rolling versions use every tag rather than a truncated release list", () => {
  const file = ".github/workflows/srn-server.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      'git tag --list "${prefix}*"',
      "gh release list --limit 200 --json tagName --jq '.[].tagName'",
    ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-server\.yml: missing collision-safe rolling version source/,
  );
  assert.match(
    errors,
    /srn-server\.yml: rolling versions must use complete tag history/,
  );
});

test("mobile refuses to reuse an existing version tag", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      '          if git show-ref --verify --quiet "refs/tags/$tag"; then\n',
      "          if false; then\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-mobile\.yml: missing mobile tag collision guard/,
  );
});

test("release-contract CI produces both complete report formats", () => {
  const file = ".github/workflows/release-contract.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace("            --all-workspaces all \\\n", "")
      .replace("            --output release-impact.json \\\n", "")
      .replace("            --report release-impact.md\n", "")
      .replace(
        "        uses: actions/upload-artifact@v7\n",
        "        run: true\n",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /release-contract\.yml: missing all-workspace release analysis/,
  );
  assert.match(
    errors,
    /release-contract\.yml: missing machine-readable release report/,
  );
  assert.match(
    errors,
    /release-contract\.yml: missing readable release report/,
  );
  assert.match(
    errors,
    /release-contract\.yml: missing release report artifact publication/,
  );
});

test("product tag profiles and workspace classification cannot drift", () => {
  const file = "scripts/analyze-release-impact.mjs";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        '  "srn-mobile": {\n    ...appProductConfig,\n    tagPrefix: "@standardnotes/mobile@",\n    versioning: "semver",',
        '  "srn-mobile": {\n    ...appProductConfig,\n    tagPrefix: "@standardnotes/mobile@",\n    versioning: "rolling-year",',
      )
      .replace(
        "    const releaseTargets = releaseTargetsForPackage(packageName);",
        "    const releaseTargets = [];",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing srn-mobile semver tag profile/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: all workspace modes must use the managed-product category mapping/,
  );
});

test("hybrid history ambiguity and package-version collisions stay fail-closed", () => {
  const file = "scripts/analyze-release-impact.mjs";
  const files = withFileChanged(file, (content) =>
    content
      .replace('"ambiguous-hybrid-release-history"', '"hybrid-history-ignored"')
      .replace('"release-version-collision"', '"release-version-ignored"'),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing hybrid topology ambiguity guard/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing hybrid package-version collision guard/,
  );
});

test("computed dependency closure must remain covered by publisher paths", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("      - 'app/packages/api/**'\n", ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-mobile\.yml: push paths do not cover release dependency '@standardnotes\/api' at 'app\/packages\/api\/\*\*'/,
  );
});

test("desktop trigger paths cover reusable and shared build configuration", () => {
  const file = ".github/workflows/srn-desktop.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "      - 'app/.github/workflows/desktop.release.reuse.yml'\n",
        "",
      )
      .replace("      - 'app/babel.config.js'\n", ""),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-desktop\.yml: push paths do not cover release configuration 'app\/\.github\/workflows\/desktop\.release\.reuse\.yml'/,
  );
  assert.match(
    errors,
    /srn-desktop\.yml: push paths do not cover release configuration 'app\/babel\.config\.js'/,
  );
});

test("product publishers do not wake for shared release-gate changes", () => {
  const file = ".github/workflows/srn-client.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "      - 'cli/srn-client/**'\n",
      "      - 'cli/srn-client/**'\n      - 'scripts/**'\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-client\.yml: product publisher paths must not include shared release gate 'scripts\/analyze-release-impact\.mjs'/,
  );
});

test("force inputs can only come from an audited manual dispatch", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "FORCE_RELEASE: ${{ github.event_name == 'workflow_dispatch' && inputs.force_release || false }}",
      "FORCE_RELEASE: ${{ startsWith(github.ref, 'refs/tags/') || inputs.force_release }}",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-openclaw\.yml: missing manual-only force source/,
  );
});

test("an explicit OpenClaw tag is excluded from its own prior-release baseline", () => {
  const file = ".github/workflows/srn-openclaw.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "          EXCLUDED_RELEASE_REF: ${{ startsWith(github.ref, 'refs/tags/srn-openclaw-v') && github.ref_name || (github.event_name == 'workflow_dispatch' && inputs.tag) || '' }}\n",
        "",
      )
      .replace(
        '            --exclude-release-ref "${EXCLUDED_RELEASE_REF}" \\\n',
        "",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-openclaw\.yml: missing explicit OpenClaw release-ref exclusion/,
  );
  assert.match(
    errors,
    /srn-openclaw\.yml: missing explicit OpenClaw self-tag exclusion forwarding/,
  );
});

test("mobile branch analysis cannot silently become publication", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "if: needs.impact.outputs.changed == 'true' && needs.impact.outputs.publish_requested == 'true'",
        "if: needs.impact.outputs.changed == 'true'",
      )
      .replace(
        '              echo "force_release requires publish_release=true; an analysis-only dispatch cannot force publication." >&2\n',
        "",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-mobile\.yml: missing mobile impact-versus-publication gate/,
  );
  assert.match(
    errors,
    /srn-mobile\.yml: missing fail-closed manual force intent/,
  );
});

test("workflow-created mobile tags cannot recursively trigger publication", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "      - '@standardnotes/web@*'\n",
      "      - '@standardnotes/web@*'\n      - '@standardnotes/mobile@*'\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /workflow-created mobile tags must not recursively trigger mobile publication/,
  );
});

test("normal CI always publishes one non-releasing all-workspace report", () => {
  const file = ".github/workflows/ci.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace("          fetch-depth: 0\n", "")
      .replace("          git fetch --force --tags origin\n", "")
      .replace("            --all-workspaces all \\\n", "")
      .replace(
        "        uses: actions/upload-artifact@v7.0.0\n",
        "        run: true\n",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /ci\.yml: missing complete normal-CI report history checkout/,
  );
  assert.match(errors, /ci\.yml: missing complete normal-CI tag fetch/);
  assert.match(errors, /ci\.yml: missing normal-CI all-workspace analysis/);
  assert.match(
    errors,
    /ci\.yml: normal CI must emit exactly one all-workspace impact report/,
  );
  assert.match(
    errors,
    /ci\.yml: missing normal-CI release-impact evidence upload/,
  );
});

test("normal CI release reporting cannot gain a publisher", () => {
  const file = ".github/workflows/ci.yml";
  const files = withFileChanged(
    file,
    (content) =>
      `${content}\n# accidental publisher\ngh release create bad-tag\n`,
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /normal CI impact reporting must not publish releases \(gh release create\)/,
  );
});

test("normal CI release reporting cannot gain publication permissions", () => {
  const file = ".github/workflows/ci.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "permissions:\n  contents: read",
      "permissions:\n  contents: write",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /normal CI impact reporting must not publish releases \(contents: write\)/,
  );
});

test("every publisher uses the fail-closed shared fingerprint comparator", () => {
  const file = ".github/workflows/srn-client.yml";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        "node scripts/compare-release-fingerprints.mjs",
        'gh release download "$BASE_REF"',
      )
      .replace(
        "BASELINE_STATUS: ${{ needs.impact.outputs.baseline_status }}",
        "BASELINE_STATUS: ancestor",
      ),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /srn-client\.yml: missing shared fail-closed fingerprint comparator/,
  );
  assert.match(
    errors,
    /srn-client\.yml: fingerprint comparison must use the shared fail-closed comparator/,
  );
  assert.match(
    errors,
    /srn-client\.yml: missing analyzer-selected baseline status/,
  );
});

test("fingerprint comparator failure modes remain explicit and blocking", () => {
  const file = "scripts/compare-release-fingerprints.mjs";
  const files = withFileChanged(file, (content) =>
    content
      .replace('"missing-prior-fingerprint"', '"missing-prior-ignored"')
      .replace('decision: "blocked"', 'decision: "release-changed"'),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /compare-release-fingerprints\.mjs: missing missing baseline asset block/,
  );
  assert.match(
    errors,
    /compare-release-fingerprints\.mjs: missing persisted blocked evidence/,
  );
});

test("unmanaged and private workspaces stay inventory-only", () => {
  const file = "scripts/analyze-release-impact.mjs";
  const files = withFileChanged(file, (content) =>
    content
      .replace(
        'analysisStatus: "inventory-only"',
        'analysisStatus: "release-managed"',
      )
      .replaceAll("publicationPolicy", "legacyPolicy"),
  );
  const errors = validateReleaseContract(files).join("\n");

  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing inventory-only unmanaged rows/,
  );
  assert.match(
    errors,
    /analyze-release-impact\.mjs: missing explicit workspace publication policy/,
  );
});
