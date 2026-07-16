import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadCiContractFiles,
  validateCiContract,
} from "./validate-ci-contract.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const baseline = loadCiContractFiles(repositoryRoot);

function withFileChanged(file, update) {
  const files = new Map(baseline);
  files.set(file, update(files.get(file)));
  return files;
}

test("the repository satisfies the CI production-gate contract", () => {
  assert.deepEqual(validateCiContract(baseline), []);
});

test("continue-on-error is rejected", () => {
  const files = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace(
      "timeout-minutes: 12",
      "timeout-minutes: 12\n    continue-on-error: true",
    ),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /forbidden continue-on-error/,
  );
});

test("a missing immutable app install is rejected", () => {
  const files = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace(
      "working-directory: app\n        run: yarn install --immutable",
      "working-directory: app\n        run: yarn install",
    ),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /check must perform exactly three immutable workspace installs/,
  );
});

test("a missing backup and restore drill is rejected", () => {
  const files = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace(
      "run: yarn ops:backup-restore",
      "run: echo restore-disabled",
    ),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /container-smoke backup and restore drill/,
  );
});

test("publishing permissions are rejected", () => {
  const files = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace("contents: read", "contents: write"),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /forbidden contents write permission/,
  );
});

test("an unbounded exhaustive job is rejected", () => {
  const files = withFileChanged(".github/workflows/ci.yml", (content) => {
    const marker = "  exhaustive-e2e:";
    const start = content.indexOf(marker);
    const timeout = content.indexOf("    timeout-minutes: 120", start);
    return `${content.slice(0, timeout)}${content.slice(timeout + "    timeout-minutes: 120\n".length)}`;
  });
  assert.match(
    validateCiContract(files).join("\n"),
    /missing exhaustive-e2e timeout/,
  );
});

test("root CI script wiring is enforced", () => {
  const files = withFileChanged("package.json", (content) =>
    content.replace('"ci:contracts":', '"ci:contracts-disabled":'),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /ci:contracts script is not wired/,
  );
});
