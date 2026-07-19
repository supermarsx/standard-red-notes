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

test("a best-effort desktop Snap release is rejected", () => {
  const file = ".github/workflows/srn-desktop.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "  snap:\n    name: snap (linux-x64)\n    needs: version\n    runs-on: ubuntu-latest\n",
      "  snap:\n    name: snap (linux-x64)\n    needs: version\n    runs-on: ubuntu-latest\n    continue-on-error: true\n",
    ),
  );

  assert.match(
    validateReleaseContract(files).join("\n"),
    /Snap job must block a broken desktop release/,
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
