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
  const file = ".github/workflows/srn-client.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      '["${TOOL}-windows-arm64.exe"]="${PKG_NODE}-win-arm64"',
      "",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-client\.yml: expected one win-arm64 target/,
  );
});

test("a missing srn-admin native tool target is rejected", () => {
  const file = ".github/workflows/srn-admin.yml";
  const files = withFileChanged(file, (content) =>
    content.replace('["${TOOL}-linux-arm64"]="${PKG_NODE}-linux-arm64"', ""),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /srn-admin\.yml: expected one linux-arm64 target/,
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
    content.replace("needs: [version, build]", "needs: [version]"),
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
