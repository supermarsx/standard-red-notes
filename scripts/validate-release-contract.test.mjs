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
