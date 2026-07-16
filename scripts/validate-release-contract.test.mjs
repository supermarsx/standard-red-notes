import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadReleaseContractFiles, validateReleaseContract } from "./validate-release-contract.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
    content.replace('["${TOOL}-windows-arm64.exe"]="${PKG_NODE}-win-arm64"', ""),
  );

  assert.match(validateReleaseContract(files).join("\n"), /srn-client\.yml: expected one win-arm64 target/);
});

test("a missing app Windows release job is rejected", () => {
  const file = "app/.github/workflows/desktop.release.reuse.yml";
  const files = withFileChanged(file, (content) => content.replace(/\r?\n  Windows:\r?\n/, "\n  Removed-Windows:\n"));

  assert.match(validateReleaseContract(files).join("\n"), /desktop\.release\.reuse\.yml: missing Windows job/);
});

test("a best-effort desktop Snap release is rejected", () => {
  const file = ".github/workflows/srn-desktop.yml";
  const files = withFileChanged(file, (content) =>
    content.replace(
      "  snap:\n    name: snap (linux-x64)\n    needs: version\n    runs-on: ubuntu-latest\n",
      "  snap:\n    name: snap (linux-x64)\n    needs: version\n    runs-on: ubuntu-latest\n    continue-on-error: true\n",
    ),
  );

  assert.match(validateReleaseContract(files).join("\n"), /Snap job must block a broken desktop release/);
});

test("suppressed desktop checksum failures are rejected", () => {
  const file = ".github/workflows/srn-desktop.yml";
  const files = withFileChanged(file, (content) =>
    content.replace('sha256sum "${files[@]}" > SHA256SUMS.txt', 'sha256sum "${files[@]}" > SHA256SUMS.txt || true'),
  );

  assert.match(validateReleaseContract(files).join("\n"), /desktop checksum failures must not be suppressed/);
});

test("root mobile release paths must be monorepo-relative", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replaceAll("node-version-file: app/.nvmrc", "node-version-file: .nvmrc"),
  );

  assert.match(validateReleaseContract(files).join("\n"), /missing app-relative Node version path/);
});

test("root Android architecture validation is required", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("for arch in arm64-v8a x86_64", "for arch in arm64-v8a"),
  );

  assert.match(validateReleaseContract(files).join("\n"), /missing required Android native architectures/);
});

test("root iOS release artifact upload is required", () => {
  const file = ".github/workflows/srn-mobile.yml";
  const files = withFileChanged(file, (content) =>
    content.replace("name: srn-mobile-ios", "name: removed-ios-artifact"),
  );

  assert.match(validateReleaseContract(files).join("\n"), /missing validated iOS artifact upload/);
});

test("missing Android release architectures are rejected", () => {
  const file = "app/packages/mobile/android/gradle.properties";
  const files = withFileChanged(file, (content) => content.replace(",x86_64", ""));

  assert.match(validateReleaseContract(files).join("\n"), /reactNativeArchitectures is missing x86_64/);
});

test("a missing iOS arm64 artifact assertion is rejected", () => {
  const file = "app/.github/workflows/mobile.release.prod.yml";
  const files = withFileChanged(file, (content) => content.replace("Verify iOS device arm64 artifact", "Verify iOS artifact"));

  assert.match(validateReleaseContract(files).join("\n"), /missing iOS device architecture assertion step/);
});
