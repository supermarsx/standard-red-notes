import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  analyzeDefinitionImpact,
  analyzeAllWorkspacePackages,
  analyzeProductImpact,
  analyzeRepositoryReleaseImpact,
  analyzeWorkspacePackageImpact,
  createReleaseAnalysisContext,
  discoverStandaloneManagedPackages,
  discoverWorkspaceInventory,
  renderReleaseImpactReport,
  ReleaseImpactError,
} from "./analyze-release-impact.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const EXPECTED_REPOSITORY_WORKSPACES = `
root	@standard-red-notes/mcp	release-managed
root	@standard-red-notes/openclaw	release-managed
app	@standardnotes/api	publishable-unmanaged
app	@standardnotes/clipper	private
app	@standardnotes/desktop	release-managed
app	@standardnotes/encryption	private
app	@standardnotes/features	publishable-unmanaged
app	@standardnotes/filepicker	private
app	@standardnotes/files	private
app	@standardnotes/icons	private
app	@standardnotes/mobile	release-managed
app	@standardnotes/models	publishable-unmanaged
app	@standardnotes/releases	publishable-unmanaged
app	@standardnotes/responses	publishable-unmanaged
app	@standardnotes/services	private
app	@standardnotes/sncrypto-common	publishable-unmanaged
app	@standardnotes/sncrypto-web	publishable-unmanaged
app	@standardnotes/snjs	publishable-unmanaged
app	@standardnotes/styles	publishable-unmanaged
app	@standardnotes/toast	private
app	@standardnotes/ui-services	private
app	@standardnotes/utils	publishable-unmanaged
app	@standardnotes/web	private
server	@standard-red-notes/websocket-gateway	private
server	@standardnotes/analytics	private
server	@standardnotes/api-gateway	publishable-unmanaged
server	@standardnotes/auth-server	release-managed
server	@standardnotes/common	publishable-unmanaged
server	@standardnotes/domain-core	publishable-unmanaged
server	@standardnotes/domain-events	publishable-unmanaged
server	@standardnotes/domain-events-infra	publishable-unmanaged
server	@standardnotes/files-server	publishable-unmanaged
server	@standardnotes/grpc	publishable-unmanaged
server	@standardnotes/home-server	release-managed
server	@standardnotes/predicates	publishable-unmanaged
server	@standardnotes/revisions-server	publishable-unmanaged
server	@standardnotes/scheduler-server	private
server	@standardnotes/security	publishable-unmanaged
server	@standardnotes/settings	publishable-unmanaged
server	@standardnotes/sncrypto-node	publishable-unmanaged
server	@standardnotes/syncing-server	publishable-unmanaged
server	@standardnotes/time	publishable-unmanaged
server	@standardnotes/websockets-server	private
server	inversify-express-utils	private
`
  .trim()
  .split("\n");

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

function manifest(name, dependencies = {}, isPrivate = false) {
  return `${JSON.stringify(
    {
      name,
      version: "1.0.0",
      private: isPrivate,
      dependencies,
    },
    null,
    2,
  )}\n`;
}

function repositoryFixture() {
  const repo = mkdtempSync(path.join(os.tmpdir(), "srn-release-repository-"));
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.email", "release-impact@example.invalid");
  git(repo, "config", "user.name", "Release Impact Tests");

  write(
    repo,
    "package.json",
    `${JSON.stringify(
      {
        name: "fixture-repository",
        private: true,
        workspaces: ["mcp", "openclaw", "packages/*"],
      },
      null,
      2,
    )}\n`,
  );
  write(repo, "yarn.lock", "# root\n");
  write(
    repo,
    "mcp/package.json",
    manifest("@standard-red-notes/mcp", {}, true),
  );
  write(repo, "mcp/index.js", "export {};\n");
  write(
    repo,
    "openclaw/package.json",
    manifest("@standard-red-notes/openclaw"),
  );
  write(repo, "openclaw/index.js", "export {};\n");
  write(
    repo,
    "packages/upstream/package.json",
    manifest("@standardnotes/upstream"),
  );
  write(
    repo,
    "packages/private/package.json",
    manifest("@fixture/private", {}, true),
  );

  for (const [workspaceRoot, packages] of [
    [
      "app",
      [
        ["desktop", "@standardnotes/desktop", true],
        ["mobile", "@standardnotes/mobile", true],
      ],
    ],
    [
      "server",
      [
        ["auth", "@standardnotes/auth-server", false],
        [
          "home-server",
          "@standardnotes/home-server",
          false,
          { "@standardnotes/auth-server": "workspace:*" },
        ],
      ],
    ],
  ]) {
    write(
      repo,
      `${workspaceRoot}/package.json`,
      `${JSON.stringify(
        {
          name: `${workspaceRoot}-fixture`,
          private: true,
          workspaces: ["packages/*"],
        },
        null,
        2,
      )}\n`,
    );
    write(repo, `${workspaceRoot}/yarn.lock`, `# ${workspaceRoot}\n`);
    for (const [directory, name, isPrivate, dependencies = {}] of packages) {
      write(
        repo,
        `${workspaceRoot}/packages/${directory}/package.json`,
        manifest(name, dependencies, isPrivate),
      );
      write(
        repo,
        `${workspaceRoot}/packages/${directory}/index.js`,
        "export {};\n",
      );
    }
  }

  write(
    repo,
    "cli/srn-client/package.json",
    manifest("@standard-red-notes/srn-client", {}, true),
  );
  write(repo, "cli/srn-client/index.js", "export {};\n");
  write(
    repo,
    "cli/srn-server/package.json",
    manifest("@standard-red-notes/srn-server", {}, true),
  );
  write(repo, "cli/srn-server/index.js", "export {};\n");
  commit(repo, "repository fixture");
  return {
    repo,
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
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
    assert.deepEqual(result.dependencyClosure, ["@fixture/a", "@fixture/b"]);
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

test("SemVer prerelease and build metadata remain analyzable", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0-beta.1+build.7");
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

    assert.equal(result.baseRef, "@fixture/a@1.0.0-beta.1+build.7");
    assert.equal(result.changed, true);
  } finally {
    context.cleanup();
  }
});

test("the latest ancestor is selected and newer divergent tags are reported", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0");
    git(context.repo, "switch", "-c", "release-side");
    write(
      context.repo,
      "packages/a/src/index.js",
      "export const a = 'release side';\n",
    );
    commit(context.repo, "divergent release");
    git(context.repo, "tag", "@fixture/a@2.0.0");
    git(context.repo, "switch", "main");

    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
    });
    assert.equal(result.baseRef, "@fixture/a@1.0.0");
    assert.equal(result.baselineStatus, "ancestor-with-newer-divergent-tags");
    assert.deepEqual(result.divergentNewerReleaseRefs, ["@fixture/a@2.0.0"]);
    assert.equal(result.changed, false);
    assert.ok(
      result.reasons.some(({ code }) => code === "divergent-newer-release"),
    );
  } finally {
    context.cleanup();
  }
});

test("only-divergent history is explicit and cannot become a false first release", () => {
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

    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
    });
    assert.equal(result.firstRelease, false);
    assert.equal(result.noAncestorBaseline, true);
    assert.equal(result.baselineStatus, "no-ancestor");
    assert.equal(result.changed, true);
    assert.deepEqual(result.divergentNewerReleaseRefs, ["@fixture/a@2.0.0"]);
    assert.equal(result.reasons[0].code, "no-ancestor-baseline");
  } finally {
    context.cleanup();
  }
});

test("rolling two-part release tags select a valid baseline", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "srn-fixture-v26.9");
    git(context.repo, "tag", "srn-fixture-v26.10");
    const result = analyzeDefinitionImpact({
      repo: context.repo,
      definition: {
        tagPrefix: "srn-fixture-v",
        versioning: "rolling-year",
        packageDirs: [{ name: "srn-fixture", directory: "packages/a" }],
        configPaths: [],
        configPrefixes: [],
      },
      identity: "srn-fixture",
    });
    assert.equal(result.baseRef, "srn-fixture-v26.10");
    assert.equal(result.changed, false);
  } finally {
    context.cleanup();
  }
});

test("rolling profiles reject SemVer-shaped and decorated tags", () => {
  for (const invalidVersion of ["26.7.0", "26.7-beta.1", "26.7+build.1"]) {
    const context = fixture();
    try {
      git(context.repo, "tag", `srn-fixture-v${invalidVersion}`);
      assert.throws(
        () =>
          analyzeDefinitionImpact({
            repo: context.repo,
            definition: {
              tagPrefix: "srn-fixture-v",
              versioning: "rolling-year",
              packageDirs: [{ name: "srn-fixture", directory: "packages/a" }],
              configPaths: [],
              configPrefixes: [],
            },
            identity: "srn-fixture",
          }),
        (error) =>
          error instanceof ReleaseImpactError &&
          error.code === "malformed-release-ref",
      );
    } finally {
      context.cleanup();
    }
  }
});

test("SemVer profiles reject two-part rolling versions", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@26.7");
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

test("the hybrid profile selects a later explicit SemVer ancestor over rolling identity", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "srn-fixture-v26.9");
    write(
      context.repo,
      "packages/a/src/index.js",
      "export const a = 'explicit release';\n",
    );
    commit(context.repo, "explicit release");
    git(context.repo, "tag", "srn-fixture-v1.2.3");
    const result = analyzeDefinitionImpact({
      repo: context.repo,
      definition: {
        tagPrefix: "srn-fixture-v",
        versioning: "rolling-year-or-semver",
        packageDirs: [{ name: "srn-fixture", directory: "packages/a" }],
        configPaths: [],
        configPrefixes: [],
      },
      identity: "srn-fixture",
    });
    assert.equal(result.baseRef, "srn-fixture-v1.2.3");
    assert.equal(result.baselinePolicy, "latest-topological-ancestor");
    assert.equal(result.changed, false);
  } finally {
    context.cleanup();
  }
});

test("hybrid rolling and stable SemVer identities cannot map to one package version", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "srn-fixture-v26.9");
    git(context.repo, "tag", "srn-fixture-v26.9.0");
    assert.throws(
      () =>
        analyzeDefinitionImpact({
          repo: context.repo,
          definition: {
            tagPrefix: "srn-fixture-v",
            versioning: "rolling-year-or-semver",
            packageDirs: [{ name: "srn-fixture", directory: "packages/a" }],
            configPaths: [],
            configPrefixes: [],
          },
          identity: "srn-fixture",
        }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "release-version-collision",
    );
  } finally {
    context.cleanup();
  }
});

test("hybrid release ancestors on incomparable merge branches fail closed", () => {
  const context = fixture();
  try {
    git(context.repo, "switch", "-c", "rolling-release");
    write(
      context.repo,
      "packages/a/rolling.js",
      "export const rolling = true;\n",
    );
    commit(context.repo, "rolling branch");
    git(context.repo, "tag", "srn-fixture-v26.9");

    git(context.repo, "switch", "main");
    git(context.repo, "switch", "-c", "explicit-release");
    write(
      context.repo,
      "packages/a/explicit.js",
      "export const explicit = true;\n",
    );
    commit(context.repo, "explicit branch");
    git(context.repo, "tag", "srn-fixture-v1.2.3");

    git(context.repo, "switch", "main");
    git(
      context.repo,
      "merge",
      "--no-ff",
      "rolling-release",
      "-m",
      "merge rolling",
    );
    git(
      context.repo,
      "merge",
      "--no-ff",
      "explicit-release",
      "-m",
      "merge explicit",
    );

    assert.throws(
      () =>
        analyzeDefinitionImpact({
          repo: context.repo,
          definition: {
            tagPrefix: "srn-fixture-v",
            versioning: "rolling-year-or-semver",
            packageDirs: [{ name: "srn-fixture", directory: "packages/a" }],
            configPaths: [],
            configPrefixes: [],
          },
          identity: "srn-fixture",
        }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "ambiguous-hybrid-release-history",
    );
  } finally {
    context.cleanup();
  }
});

test("an explicit hybrid base reports every off-history tag without cross-profile ordering", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "srn-fixture-v26.9");
    git(context.repo, "switch", "-c", "explicit-side");
    write(
      context.repo,
      "packages/a/explicit.js",
      "export const explicit = true;\n",
    );
    commit(context.repo, "explicit side");
    git(context.repo, "tag", "srn-fixture-v1.2.3");
    git(context.repo, "switch", "main");

    const result = analyzeDefinitionImpact({
      repo: context.repo,
      definition: {
        tagPrefix: "srn-fixture-v",
        versioning: "rolling-year-or-semver",
        packageDirs: [{ name: "srn-fixture", directory: "packages/a" }],
        configPaths: [],
        configPrefixes: [],
      },
      identity: "srn-fixture",
      baseRef: "srn-fixture-v26.9",
    });
    assert.equal(result.changed, false);
    assert.equal(result.baselineStatus, "ancestor-with-divergent-tags");
    assert.deepEqual(result.divergentReleaseRefs, ["srn-fixture-v1.2.3"]);
    assert.deepEqual(result.divergentNewerReleaseRefs, []);
  } finally {
    context.cleanup();
  }
});

test("unbounded numeric version components are ordered exactly", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@9007199254740992.0.0");
    git(context.repo, "tag", "@fixture/a@9007199254740993.0.0");
    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
    });
    assert.equal(result.baseRef, "@fixture/a@9007199254740993.0.0");
  } finally {
    context.cleanup();
  }
});

test("direct package changes are distinguished from dependency changes", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0");
    write(
      context.repo,
      "packages/a/src/index.js",
      "export const a = 'direct';\n",
    );
    commit(context.repo, "direct package change");
    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
    });
    assert.ok(
      result.reasons.some(
        ({ code, package: changedPackage }) =>
          code === "target-package-change" && changedPackage === "@fixture/a",
      ),
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

test("a migration-only dependency change selects the home-server product", () => {
  const context = repositoryFixture();
  try {
    git(context.repo, "tag", "srn-home-server-v26.1");
    const migration =
      "server/packages/auth/src/Infra/Typeorm/Migrations/9999999999999-AddFixture.ts";
    write(context.repo, migration, "export class AddFixture {}\n");
    commit(context.repo, "add auth migration");

    const result = analyzeProductImpact({
      repo: context.repo,
      target: "srn-home-server",
    });
    assert.equal(result.changed, true);
    assert.deepEqual(result.matchedFiles, [migration]);
    assert.ok(
      result.reasons.some(
        ({ code, package: changedPackage }) =>
          code === "workspace-dependency-change" &&
          changedPackage === "@standardnotes/auth-server",
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

test("repository mode inventories every workspace without inventing publishers", () => {
  const context = repositoryFixture();
  try {
    const analysisContext = createReleaseAnalysisContext(context.repo);
    const result = analyzeRepositoryReleaseImpact({
      repo: context.repo,
      context: analysisContext,
    });

    assert.equal(result.mode, "repository");
    assert.equal(result.products.length, 8);
    assert.equal(result.standaloneManagedPackages.length, 2);
    assert.deepEqual(result.inventoryCounts, {
      managedProducts: 8,
      yarnWorkspaces: 8,
      standaloneManagedPackages: 2,
    });
    assert.deepEqual(result.categoryCounts, {
      "release-managed": 6,
      "publishable-unmanaged": 1,
      private: 1,
    });
    assert.equal(result.workspaces.length, 8);
    assert.equal(
      result.workspaces.find(
        ({ identity }) => identity === "@standardnotes/upstream",
      ).category,
      "publishable-unmanaged",
    );
    assert.equal(
      result.workspaces.find(({ identity }) => identity === "@fixture/private")
        .category,
      "private",
    );
    assert.equal(
      result.workspaces.find(
        ({ identity }) => identity === "@standardnotes/desktop",
      ).category,
      "release-managed",
    );
    assert.ok(analysisContext.workspaces.size >= 3);

    const report = renderReleaseImpactReport(result);
    for (const required of [
      "## Managed release products",
      "## Standalone managed packages",
      "## Yarn workspace inventory",
      "@standardnotes/upstream",
      "publishable-unmanaged",
      "does not assert that this repository publishes",
    ]) {
      assert.match(report, new RegExp(required.replaceAll("*", "\\*")));
    }
  } finally {
    context.cleanup();
  }
});

test("repository CLI writes JSON, Markdown, and GitHub outputs", () => {
  const context = repositoryFixture();
  try {
    const githubOutput = path.join(context.repo, "github-output.txt");
    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/analyze-release-impact.mjs"),
        "--repo",
        context.repo,
        "--all-workspaces",
        "all",
        "--output",
        "release-impact.json",
        "--report",
        "release-impact.md",
        "--github-output",
        githubOutput,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    const machine = JSON.parse(
      readFileSync(path.join(context.repo, "release-impact.json"), "utf8"),
    );
    assert.equal(machine.products.length, 8);
    assert.equal(machine.workspaces.length, 8);
    assert.equal(machine.standaloneManagedPackages.length, 2);
    assert.match(
      readFileSync(path.join(context.repo, "release-impact.md"), "utf8"),
      /## Yarn workspace inventory/,
    );
    assert.match(readFileSync(githubOutput, "utf8"), /result_json=/);
  } finally {
    context.cleanup();
  }
});

test("the repository Yarn-workspace snapshot covers all 44 manifests", () => {
  const result = discoverWorkspaceInventory({ repo: repositoryRoot });
  const actual = result.workspaces.map(
    ({ workspaceRoot, identity, category }) =>
      `${workspaceRoot}\t${identity}\t${category}`,
  );

  assert.equal(actual.length, 44);
  assert.deepEqual(result.categoryCounts, {
    "release-managed": 6,
    "publishable-unmanaged": 24,
    private: 14,
  });
  assert.deepEqual(actual, EXPECTED_REPOSITORY_WORKSPACES);

  const standalone = discoverStandaloneManagedPackages({
    repo: repositoryRoot,
  });
  assert.deepEqual(
    standalone.packages.map(
      ({ identity, releaseTarget, manifestPath }) =>
        `${identity}\t${releaseTarget}\t${manifestPath}`,
    ),
    [
      "@standard-red-notes/srn-client\tsrn-client\tcli/srn-client/package.json",
      "@standard-red-notes/srn-server\tsrn-server\tcli/srn-server/package.json",
    ],
  );
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
