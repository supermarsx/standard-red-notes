import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeAllWorkspacePackages,
  analyzeWorkspacePackageImpact,
  ReleaseImpactError,
} from "./analyze-release-impact.mjs";

function git(repo, ...args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(repo, file, content) {
  const absolute = path.join(repo, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function manifest(name, dependencies = {}) {
  return `${JSON.stringify(
    {
      name,
      version: "1.0.0",
      private: false,
      dependencies,
    },
    null,
    2,
  )}\n`;
}

function commit(repo, message) {
  git(repo, "add", ".");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function fixture() {
  const repo = mkdtempSync(path.join(os.tmpdir(), "srn-release-impact-"));
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "release-impact@example.invalid");
  git(repo, "config", "user.name", "Release Impact Tests");
  write(
    repo,
    "package.json",
    `${JSON.stringify(
      {
        name: "fixture",
        private: true,
        workspaces: ["packages/*"],
      },
      null,
      2,
    )}\n`,
  );
  write(repo, "yarn.lock", "# fixture lock\n");
  write(
    repo,
    "packages/a/package.json",
    manifest("@fixture/a", { "@fixture/b": "workspace:*" }),
  );
  write(repo, "packages/a/src/index.js", "export const a = 'a';\n");
  write(repo, "packages/b/package.json", manifest("@fixture/b"));
  write(repo, "packages/b/src/index.js", "export const b = 'b';\n");
  write(repo, "packages/c/package.json", manifest("@fixture/c"));
  write(repo, "packages/c/src/index.js", "export const c = 'c';\n");
  write(repo, "docs/guide.md", "# Fixture docs\n");
  const baseline = commit(repo, "initial");
  return {
    repo,
    baseline,
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}

function tagAll(repo) {
  git(repo, "tag", "@fixture/a@1.0.0");
  git(repo, "tag", "@fixture/b@1.0.0");
  git(repo, "tag", "@fixture/c@1.0.0");
}

test("docs-only and unrelated workspace changes do not release a package", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0");
    write(context.repo, "docs/guide.md", "# Updated docs\n");
    write(
      context.repo,
      "packages/c/src/index.js",
      "export const c = 'unrelated';\n",
    );
    commit(context.repo, "docs and unrelated package");

    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
    });

    assert.equal(result.changed, false);
    assert.deepEqual(result.matchedFiles, []);
    assert.deepEqual(result.ignoredFiles, [
      "docs/guide.md",
      "packages/c/src/index.js",
    ]);
  } finally {
    context.cleanup();
  }
});

test("a transitive workspace dependency change releases its consumer", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0");
    write(
      context.repo,
      "packages/b/src/index.js",
      "export const b = 'changed dependency';\n",
    );
    commit(context.repo, "change dependency");

    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.matchedFiles, ["packages/b/src/index.js"]);
    assert.ok(
      result.reasons.some(
        (reason) =>
          reason.code === "workspace-dependency-change" &&
          reason.package === "@fixture/b",
      ),
    );
  } finally {
    context.cleanup();
  }
});

test("a package with no matching release tag is an auditable first release", () => {
  const context = fixture();
  try {
    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/c",
      workspaceRoot: "root",
    });

    assert.equal(result.changed, true);
    assert.equal(result.firstRelease, true);
    assert.equal(result.baseRef, null);
    assert.equal(result.reasons[0].code, "first-release");
  } finally {
    context.cleanup();
  }
});

test("an explicitly requested missing base ref fails closed", () => {
  const context = fixture();
  try {
    assert.throws(
      () =>
        analyzeWorkspacePackageImpact({
          repo: context.repo,
          packageName: "@fixture/a",
          workspaceRoot: "root",
          baseRef: "@fixture/a@9.9.9",
        }),
      (error) =>
        error instanceof ReleaseImpactError && error.code === "missing-ref",
    );
  } finally {
    context.cleanup();
  }
});

test("a malformed matching release ref fails closed", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@not-a-version");
    assert.throws(
      () =>
        analyzeWorkspacePackageImpact({
          repo: context.repo,
          packageName: "@fixture/a",
          workspaceRoot: "root",
        }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "malformed-release-ref",
    );
  } finally {
    context.cleanup();
  }
});

test("a valid independent-package prerelease tag remains analyzable", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0-beta.1");
    write(
      context.repo,
      "packages/a/src/index.js",
      "export const a = 'after prerelease';\n",
    );
    commit(context.repo, "change after prerelease");

    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
    });

    assert.equal(result.baseRef, "@fixture/a@1.0.0-beta.1");
    assert.equal(result.changed, true);
  } finally {
    context.cleanup();
  }
});

test("divergent release history is rejected instead of choosing an unsafe diff", () => {
  const context = fixture();
  try {
    git(context.repo, "switch", "-c", "release-side");
    write(
      context.repo,
      "packages/a/src/index.js",
      "export const a = 'release side';\n",
    );
    commit(context.repo, "divergent release");
    git(context.repo, "tag", "@fixture/a@2.0.0");
    git(context.repo, "switch", "main");

    assert.throws(
      () =>
        analyzeWorkspacePackageImpact({
          repo: context.repo,
          packageName: "@fixture/a",
          workspaceRoot: "root",
        }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "divergent-release-history",
    );
  } finally {
    context.cleanup();
  }
});

test("shared workspace build configuration changes are release-impacting", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0");
    write(context.repo, "yarn.lock", "# changed dependency resolution\n");
    commit(context.repo, "update lock");

    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.matchedFiles, ["yarn.lock"]);
    assert.ok(
      result.reasons.some(
        (reason) => reason.code === "release-build-config-change",
      ),
    );
  } finally {
    context.cleanup();
  }
});

test("forced releases require and preserve an auditable reason", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0");
    assert.throws(
      () =>
        analyzeWorkspacePackageImpact({
          repo: context.repo,
          packageName: "@fixture/a",
          workspaceRoot: "root",
          force: true,
        }),
      (error) =>
        error instanceof ReleaseImpactError && error.code === "unaudited-force",
    );

    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
      force: true,
      forceReason: "manual recovery of a compromised artifact",
    });
    assert.equal(result.changed, true);
    assert.equal(result.forced, true);
    assert.equal(
      result.forceReason,
      "manual recovery of a compromised artifact",
    );
    assert.equal(result.reasons[0].code, "forced-release");
  } finally {
    context.cleanup();
  }
});

test("all-workspaces mode reports only changed packages and their dependents", () => {
  const context = fixture();
  try {
    tagAll(context.repo);
    write(
      context.repo,
      "packages/b/src/index.js",
      "export const b = 'changed dependency';\n",
    );
    commit(context.repo, "change dependency");

    const result = analyzeAllWorkspacePackages({
      repo: context.repo,
      workspaceRoot: "root",
    });

    assert.equal(result.mode, "all-workspaces");
    assert.deepEqual(result.changedPackages, ["@fixture/a", "@fixture/b"]);
    assert.equal(
      result.packages.find((entry) => entry.identity === "@fixture/c").changed,
      false,
    );
  } finally {
    context.cleanup();
  }
});

test("the CLI rejects unknown flags instead of silently weakening analysis", () => {
  const context = fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/analyze-release-impact.mjs"),
        "--repo",
        context.repo,
        "--package",
        "@fixture/a",
        "--workspace-root",
        "root",
        "--typo-base",
        "@fixture/a@1.0.0",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown argument '--typo-base'/);
  } finally {
    context.cleanup();
  }
});

test("the CLI rejects flags that do not apply to the selected mode", () => {
  const context = fixture();
  try {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/analyze-release-impact.mjs"),
        "--repo",
        context.repo,
        "--target",
        "srn-mcp",
        "--workspace-root",
        "root",
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /--workspace-root is supported only with --package/,
    );
  } finally {
    context.cleanup();
  }
});
