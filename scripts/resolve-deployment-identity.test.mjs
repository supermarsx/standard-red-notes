import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveDeploymentIdentity } from "./resolve-deployment-identity.mjs";

function git(repositoryRoot, ...args) {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function repositoryFixture() {
  const repositoryRoot = mkdtempSync(
    path.join(tmpdir(), "srn-deploy-identity-"),
  );
  git(repositoryRoot, "init", "--quiet");
  git(repositoryRoot, "config", "user.name", "CI Test");
  git(repositoryRoot, "config", "user.email", "ci@example.invalid");
  writeFileSync(path.join(repositoryRoot, "tracked.txt"), "one\n");
  git(repositoryRoot, "add", "tracked.txt");
  git(repositoryRoot, "commit", "--quiet", "-m", "fixture");
  return repositoryRoot;
}

test("resolves only the exact clean checked-out commit", () => {
  const repositoryRoot = repositoryFixture();
  try {
    const revision = git(repositoryRoot, "rev-parse", "HEAD");
    assert.deepEqual(
      resolveDeploymentIdentity({
        repositoryRoot,
        expectedRevision: revision,
        version: "ci-123.1",
      }),
      { revision, version: "ci-123.1" },
    );
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("refuses tracked and untracked checkout changes", () => {
  for (const dirtyPath of ["tracked.txt", "untracked.txt"]) {
    const repositoryRoot = repositoryFixture();
    try {
      const revision = git(repositoryRoot, "rev-parse", "HEAD");
      writeFileSync(path.join(repositoryRoot, dirtyPath), "changed\n");
      assert.throws(
        () =>
          resolveDeploymentIdentity({
            repositoryRoot,
            expectedRevision: revision,
            version: "ci-123.1",
          }),
        /dirty checkout/,
      );
    } finally {
      rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test("rejects a different commit and unsafe version metadata", () => {
  const repositoryRoot = repositoryFixture();
  try {
    assert.throws(
      () =>
        resolveDeploymentIdentity({
          repositoryRoot,
          expectedRevision: "0".repeat(40),
          version: "ci-123.1",
        }),
      /does not match expected revision/,
    );
    const revision = git(repositoryRoot, "rev-parse", "HEAD");
    assert.throws(
      () =>
        resolveDeploymentIdentity({
          repositoryRoot,
          expectedRevision: revision,
          version: "unsafe version",
        }),
      /safe ASCII token/,
    );
  } finally {
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
