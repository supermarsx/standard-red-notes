import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  analyzeDefinitionImpact,
  analyzeAllWorkspacePackages,
  analyzeProductImpact,
  analyzeRepositoryReleaseImpact,
  analyzeWorkspacePackageImpact,
  createReleaseAnalysisContext,
  discoverReleaseTargetSurface,
  discoverStandaloneManagedPackages,
  discoverWorkflowOwnership,
  discoverWorkspaceInventory,
  renderReleaseImpactReport,
  ReleaseImpactError,
} from "./analyze-release-impact.mjs";
import {
  classifyNativeCliExecutorSemanticChange,
  classifyReleasePackagingContractSemanticChange,
  nativeCliExecutorIdentity,
  NATIVE_CLI_RELEASE_PRODUCTS,
  RELEASE_PACKAGING_CONTRACT_PRODUCTS,
} from "./native-cli-release.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const EXPECTED_REPOSITORY_WORKSPACES = `
root	@standard-red-notes/mcp	release-managed
root	@standard-red-notes/openclaw	release-managed
app	@standardnotes/api	publishable-unmanaged
app	@standardnotes/clipper	distribution-surface
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
app	@standardnotes/web	distribution-surface
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

const FIXTURE_CANONICAL_WORKFLOWS = [
  ["srn-admin", "srn-admin"],
  ["srn-client", "srn-client"],
  ["srn-desktop", "srn-desktop"],
  ["srn-home-server", "srn-home-server"],
  ["srn-mcp", "srn-mcp"],
  ["srn-mobile", "srn-mobile"],
  ["srn-openclaw", "srn-openclaw"],
  ["srn-server", "srn-server"],
];

const FIXTURE_NATIVE_EXECUTOR = `
export const NATIVE_CLI_PRODUCT_SEMANTICS = Object.freeze({
  "srn-admin": Object.freeze({ planSchema: 1 }),
  "srn-client": Object.freeze({ planSchema: 1 }),
  "srn-home-server": Object.freeze({ planSchema: 1, supplementalArtifactPlanSchema: 1 }),
  "srn-mcp": Object.freeze({ planSchema: 1 }),
  "srn-server": Object.freeze({ planSchema: 1 }),
});

const NATIVE_CLI_PRODUCT_AST_BINDINGS = Object.freeze({
  "srn-home-server": Object.freeze(["appendHomeServerSupplementalInvocations"]),
});

function appendHomeServerSupplementalInvocations(invocations) {
  invocations.push("home-v1");
}

const NATIVE_CLI_PRODUCT_PLAN_APPENDERS = Object.freeze({
  "srn-home-server": appendHomeServerSupplementalInvocations,
});

export function sharedPlan(value) {
  return value + 1;
}
`.trimStart();

const REFORMATTED_FIXTURE_NATIVE_EXECUTOR = `
// Trivia and layout must not create five product releases.
export const NATIVE_CLI_PRODUCT_SEMANTICS = Object.freeze(
  {
    'srn-admin': Object.freeze({ planSchema: 1 }),
    'srn-client': Object.freeze({ planSchema: 1 }),
    'srn-home-server': Object.freeze({
      planSchema: 1,
      supplementalArtifactPlanSchema: 1,
    }),
    'srn-mcp': Object.freeze({ planSchema: 1 }),
    'srn-server': Object.freeze({ planSchema: 1 }),
  },
)

const NATIVE_CLI_PRODUCT_AST_BINDINGS = Object.freeze({
  'srn-home-server': Object.freeze([
    'appendHomeServerSupplementalInvocations',
  ]),
})

function appendHomeServerSupplementalInvocations(invocations) {
  // Home-server packaging comment.
  invocations.push('home-v1')
}

const NATIVE_CLI_PRODUCT_PLAN_APPENDERS = Object.freeze({
  'srn-home-server': appendHomeServerSupplementalInvocations,
})

export function sharedPlan(value) { return value + 1 }
`.trimStart();

const FIXTURE_RELEASE_PACKAGING_CONTRACT = `
export const RELEASE_PACKAGING_CONTRACTS = Object.freeze({
  "native-cli": Object.freeze({
    schemaVersion: 1,
    embeddedRuntime: "node24",
    products: Object.freeze({
      "srn-home-server": Object.freeze({ supplementalArtifact: "home-v1" }),
    }),
  }),
  desktop: Object.freeze({ schemaVersion: 1, builder: "desktop-v1" }),
  mobile: Object.freeze({ schemaVersion: 1, builder: "mobile-v1" }),
  openclaw: Object.freeze({ schemaVersion: 1, builder: "openclaw-v1" }),
});

export function fingerprintContract(value) {
  return value + 1;
}
`.trimStart();

const REFORMATTED_FIXTURE_RELEASE_PACKAGING_CONTRACT = `
// Contract layout is not release impact.
export const RELEASE_PACKAGING_CONTRACTS = Object.freeze(
  {
    'native-cli': Object.freeze({
      schemaVersion: 1,
      embeddedRuntime: 'node24',
      products: Object.freeze({
        'srn-home-server': Object.freeze({
          supplementalArtifact: 'home-v1',
        }),
      }),
    }),
    desktop: Object.freeze({ schemaVersion: 1, builder: 'desktop-v1' }),
    mobile: Object.freeze({ schemaVersion: 1, builder: 'mobile-v1' }),
    openclaw: Object.freeze({ schemaVersion: 1, builder: 'openclaw-v1' }),
  },
)

export function fingerprintContract(value) { return value + 1 }
`.trimStart();

const FIXTURE_QUARANTINED_WORKFLOWS = [
  "clipper.release.prod.yml",
  "git-sync.yml",
  "ios.testflight.yml",
  "publish.yml",
  "releases.notify.yml",
  "web.release.prod.yml",
];

const FIXTURE_SERVER_QUARANTINED_WORKFLOWS = [
  "analytics.yml",
  "api-gateway.yml",
  "auth.yml",
  "common-deploy.yml",
  "common-docker-image.yml",
  "common-self-hosting.yml",
  "common-server-application.yml",
  "files.yml",
  "publish.yml",
  "revisions.yml",
  "scheduler.yml",
  "syncing-server.yml",
  "websockets.yml",
];

function writeRepositoryWorkflowInventory(repo) {
  for (const [filename, target] of FIXTURE_CANONICAL_WORKFLOWS) {
    write(
      repo,
      `.github/workflows/${filename}.yml`,
      `name: ${filename}\non:\n  push:\n    branches: [main]\n    paths:\n      - '${filename}/**'\n  workflow_dispatch:\njobs:\n  impact:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node scripts/analyze-release-impact.mjs --target ${target}\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create fixture\n`,
    );
  }
  write(
    repo,
    ".github/workflows/ci.yml",
    "name: ci\non:\n  push:\n    branches: [main]\n  pull_request:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo check\n  container-smoke:\n    runs-on: ubuntu-latest\n    outputs:\n      publication_attempt: ${{ steps.identity.outputs.attempt }}\n      publication_tag: ${{ steps.identity.outputs.tag }}\n    steps:\n      - id: identity\n        run: echo identity\n  production-gate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo production gate\n  publish-containers:\n    if: github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'supermarsx/standard-red-notes'\n    needs: [container-smoke, production-gate]\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      packages: write\n    env:\n      APP_IMAGE: ghcr.io/supermarsx/standard-red-notes-app\n      SERVER_IMAGE: ghcr.io/supermarsx/standard-red-notes-server\n      PUBLISH_ATTEMPT: ${{ needs.container-smoke.outputs.publication_attempt }}\n      PUBLISH_TAG: ${{ needs.container-smoke.outputs.publication_tag }}\n      IMAGE_PLATFORM: linux/amd64\n    steps:\n      - run: docker push \"$APP_IMAGE:$PUBLISH_TAG\" && docker push \"$SERVER_IMAGE:$PUBLISH_TAG\"\n",
  );
  write(
    repo,
    ".github/workflows/release-contract.yml",
    "name: release contract\non:\n  push:\n    branches: [main]\n    paths:\n      - '.github/workflows/**'\n  pull_request:\n  workflow_dispatch:\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo check\n",
  );
  for (const filename of [
    "desktop.release.prod.yml",
    "mobile.release.prod.yml",
  ]) {
    write(
      repo,
      `app/.github/workflows/${filename}`,
      `name: ${filename}\non:\n  workflow_dispatch:\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create fixture\n`,
    );
  }
  write(
    repo,
    "app/.github/workflows/desktop.release.reuse.yml",
    "name: desktop reuse\non:\n  workflow_call:\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create fixture\n",
  );
  write(
    repo,
    "app/.github/workflows/codeql-analysis.yml",
    "name: codeql\non:\n  push:\n  pull_request:\n  schedule:\n    - cron: '0 0 * * *'\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo check\n",
  );
  write(
    repo,
    "app/.github/workflows/pr.yml",
    "name: app pr\non:\n  pull_request:\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo check\n",
  );
  for (const filename of FIXTURE_QUARANTINED_WORKFLOWS) {
    const triggers = ["clipper.release.prod.yml", "git-sync.yml"].includes(
      filename,
    )
      ? "  push:\n  workflow_dispatch:\n"
      : ["ios.testflight.yml", "releases.notify.yml"].includes(filename)
        ? "  workflow_dispatch:\n"
        : "  push:\n";
    write(
      repo,
      `app/.github/upstream-workflows-disabled/${filename}`,
      `name: quarantined ${filename}\non:\n${triggers}jobs:\n  mutate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo disabled\n`,
    );
  }
  write(
    repo,
    ".github/workflows/docs-pages.yml",
    "name: docs pages\non:\n  push:\n    branches: [main]\n  pull_request:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/deploy-pages@fixture\n",
  );
  write(
    repo,
    "app/.github/workflows/snjs.pr.yml",
    "name: snjs pr\non:\n  pull_request:\n  workflow_dispatch:\njobs:\n  publish-test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker push standardnotes/snjs:test\n",
  );
  write(
    repo,
    "app/.github/workflows/snjs.upgrade.event.yml",
    "name: snjs upgrade\non:\n  workflow_dispatch:\n  repository_dispatch:\njobs:\n  update:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: peter-evans/create-pull-request@fixture\n",
  );
  for (const filename of [
    "common-e2e.yml",
    "e2e-home-server.yml",
    "e2e-self-hosted.yml",
  ]) {
    write(
      repo,
      `server/.github/workflows/${filename}`,
      `name: ${filename}\non:\n  workflow_call:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n`,
    );
  }
  write(
    repo,
    "server/.github/workflows/e2e-test-suite.yml",
    "name: e2e suite\non:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n",
  );
  write(
    repo,
    "server/.github/workflows/pr.yml",
    "name: server pr\non:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n",
  );
  for (const filename of FIXTURE_SERVER_QUARANTINED_WORKFLOWS) {
    const triggers = filename.startsWith("common-")
      ? "  workflow_call:\n"
      : filename === "publish.yml"
        ? "  push:\n"
        : "  push:\n  workflow_dispatch:\n";
    write(
      repo,
      `server/.github/upstream-workflows-disabled/${filename}`,
      `name: quarantined server ${filename}\non:\n${triggers}jobs:\n  mutate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo disabled\n`,
    );
  }
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
        ["clipper", "@standardnotes/clipper", true],
        ["desktop", "@standardnotes/desktop", true],
        ["mobile", "@standardnotes/mobile", true],
        ["web", "@standardnotes/web", true],
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
  write(repo, "scripts/native-cli-release.mjs", FIXTURE_NATIVE_EXECUTOR);
  write(
    repo,
    "scripts/release-packaging-contract.mjs",
    FIXTURE_RELEASE_PACKAGING_CONTRACT,
  );
  write(
    repo,
    "scripts/package.json",
    '{"private":true,"dependencies":{"@babel/parser":"7.29.7"}}\n',
  );
  write(
    repo,
    "scripts/package-lock.json",
    '{"lockfileVersion":3,"packages":{}}\n',
  );
  write(
    repo,
    "app/scripts/verify-desktop-updater-metadata.rb",
    "abort 'invalid' unless ARGV.length == 2\n",
  );
  writeRepositoryWorkflowInventory(repo);
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

function tagNativeProducts(repo) {
  for (const target of NATIVE_CLI_RELEASE_PRODUCTS) {
    git(repo, "tag", `${target}-v26.1`);
  }
}

function analyzeNativeProducts(repo) {
  return Object.fromEntries(
    NATIVE_CLI_RELEASE_PRODUCTS.map((target) => [
      target,
      analyzeProductImpact({ repo, target }),
    ]),
  );
}

function tagReleasePackagingProducts(repo) {
  for (const target of RELEASE_PACKAGING_CONTRACT_PRODUCTS) {
    const tag =
      target === "srn-mobile"
        ? "@standardnotes/mobile@1.0.0"
        : `${target}-v26.1`;
    git(repo, "tag", tag);
  }
}

function analyzeReleasePackagingProducts(repo) {
  return Object.fromEntries(
    RELEASE_PACKAGING_CONTRACT_PRODUCTS.map((target) => [
      target,
      analyzeProductImpact({ repo, target }),
    ]),
  );
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

test("renames out of a dependency closure retain the deleted source path", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0");
    mkdirSync(path.join(context.repo, "archive"), { recursive: true });
    git(context.repo, "mv", "packages/b/src/index.js", "archive/removed-b.js");
    commit(context.repo, "move dependency source outside the workspace");

    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.matchedFiles, ["packages/b/src/index.js"]);
    assert.deepEqual(result.ignoredFiles, ["archive/removed-b.js"]);
  } finally {
    context.cleanup();
  }
});

test("deleted dependency files remain release-impacting", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0");
    rmSync(path.join(context.repo, "packages/b/src/index.js"));
    commit(context.repo, "delete dependency source");

    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
    });

    assert.equal(result.changed, true);
    assert.deepEqual(result.matchedFiles, ["packages/b/src/index.js"]);
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
    git(context.repo, "branch", "@fixture/a@9.9.9");
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
    assert.equal(result.publicationGate, "blocked-release-history");
    assert.deepEqual(result.divergentNewerReleaseRefs, ["@fixture/a@2.0.0"]);
    assert.equal(result.changed, true);
    assert.ok(
      result.reasons.some(({ code }) => code === "divergent-newer-release"),
    );
  } finally {
    context.cleanup();
  }
});

test("older divergent tags are reported without being mislabeled as newer", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0");
    git(context.repo, "switch", "-c", "older-release-side");
    write(
      context.repo,
      "packages/a/src/index.js",
      "export const a = 'older release side';\n",
    );
    commit(context.repo, "older divergent release");
    git(context.repo, "tag", "@fixture/a@0.9.0");
    git(context.repo, "switch", "main");

    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
    });

    assert.equal(result.baseRef, "@fixture/a@1.0.0");
    assert.equal(result.baselineStatus, "ancestor-with-divergent-tags");
    assert.equal(result.publicationGate, "blocked-release-history");
    assert.deepEqual(result.divergentReleaseRefs, ["@fixture/a@0.9.0"]);
    assert.deepEqual(result.divergentNewerReleaseRefs, []);
    assert.equal(result.changed, true);
    assert.ok(result.reasons.some(({ code }) => code === "divergent-release"));
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
    assert.equal(result.publicationGate, "blocked-release-history");
    assert.equal(result.changed, true);
    assert.deepEqual(result.divergentNewerReleaseRefs, ["@fixture/a@2.0.0"]);
    assert.equal(result.reasons[0].code, "no-ancestor-baseline");
  } finally {
    context.cleanup();
  }
});

test("an explicit release request can exclude its own head tag from the prior baseline", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0");
    write(
      context.repo,
      "packages/a/src/index.js",
      "export const a = 'explicit release';\n",
    );
    commit(context.repo, "explicit release head");
    git(context.repo, "tag", "@fixture/a@2.0.0");

    const result = analyzeWorkspacePackageImpact({
      repo: context.repo,
      packageName: "@fixture/a",
      workspaceRoot: "root",
      excludeReleaseRef: "@fixture/a@2.0.0",
    });

    assert.equal(result.excludedReleaseRef, "@fixture/a@2.0.0");
    assert.equal(result.baseRef, "@fixture/a@1.0.0");
    assert.equal(result.changed, true);
    assert.equal(result.publicationGate, "build-and-compare");
  } finally {
    context.cleanup();
  }
});

test("an excluded release ref must match both the product and requested head", () => {
  const context = fixture();
  try {
    git(context.repo, "tag", "@fixture/a@1.0.0");
    write(
      context.repo,
      "packages/a/src/index.js",
      "export const a = 'new head';\n",
    );
    commit(context.repo, "new head");

    assert.throws(
      () =>
        analyzeWorkspacePackageImpact({
          repo: context.repo,
          packageName: "@fixture/a",
          workspaceRoot: "root",
          excludeReleaseRef: "@fixture/a@1.0.0",
        }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "excluded-release-ref-mismatch",
    );
    assert.throws(
      () =>
        analyzeWorkspacePackageImpact({
          repo: context.repo,
          packageName: "@fixture/a",
          workspaceRoot: "root",
          excludeReleaseRef: "@fixture/b@1.0.0",
        }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "mismatched-release-ref",
    );
    git(context.repo, "branch", "@fixture/a@2.0.0");
    assert.throws(
      () =>
        analyzeWorkspacePackageImpact({
          repo: context.repo,
          packageName: "@fixture/a",
          workspaceRoot: "root",
          excludeReleaseRef: "@fixture/a@2.0.0",
        }),
      (error) =>
        error instanceof ReleaseImpactError && error.code === "missing-ref",
    );
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
    assert.equal(result.changed, true);
    assert.equal(result.baselineStatus, "ancestor-with-divergent-tags");
    assert.equal(result.publicationGate, "blocked-release-history");
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

test("native executor trivia and formatting release no native product", () => {
  const context = repositoryFixture();
  try {
    tagNativeProducts(context.repo);
    write(
      context.repo,
      "scripts/native-cli-release.mjs",
      REFORMATTED_FIXTURE_NATIVE_EXECUTOR,
    );
    commit(context.repo, "format native executor");

    for (const result of Object.values(analyzeNativeProducts(context.repo))) {
      assert.equal(result.changed, false);
      assert.deepEqual(result.matchedFiles, []);
      assert.ok(result.ignoredFiles.includes("scripts/native-cli-release.mjs"));
    }
  } finally {
    context.cleanup();
  }
});

test("native executor identities are semantic and product-scoped", () => {
  const clientChange = FIXTURE_NATIVE_EXECUTOR.replace(
    '"srn-client": Object.freeze({ planSchema: 1 })',
    '"srn-client": Object.freeze({ planSchema: 2 })',
  );
  const homeChange = FIXTURE_NATIVE_EXECUTOR.replace('"home-v1"', '"home-v2"');
  for (const product of NATIVE_CLI_RELEASE_PRODUCTS) {
    const base = nativeCliExecutorIdentity(FIXTURE_NATIVE_EXECUTOR, product);
    const reformatted = nativeCliExecutorIdentity(
      REFORMATTED_FIXTURE_NATIVE_EXECUTOR,
      product,
    );
    const client = nativeCliExecutorIdentity(clientChange, product);
    const home = nativeCliExecutorIdentity(homeChange, product);
    assert.equal(reformatted.sha256, base.sha256);
    assert.equal(client.sha256 === base.sha256, product !== "srn-client");
    assert.equal(home.sha256 === base.sha256, product !== "srn-home-server");
    assert.deepEqual(base.normalizer, {
      encoding: "canonical-json",
      name: "srn-babel-semantic-ast",
      version: "1",
    });
  }
});

test("a missing native semantic parser fails closed explicitly", (t) => {
  const isolated = mkdtempSync(
    path.join(os.tmpdir(), "srn-native-semantic-parser-"),
  );
  t.after(() => rmSync(isolated, { recursive: true, force: true }));
  for (const file of [
    "fingerprint-release-tree.mjs",
    "native-cli-release.mjs",
    "release-packaging-contract.mjs",
  ]) {
    copyFileSync(
      path.join(repositoryRoot, "scripts", file),
      path.join(isolated, file),
    );
  }
  const entry = pathToFileURL(
    path.join(isolated, "native-cli-release.mjs"),
  ).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const module = await import(${JSON.stringify(entry)});
       const source = module.nativeCliExecutorImplementationSource();
       const result = module.classifyNativeCliExecutorSemanticChange({ beforeSource: source, afterSource: source + "\\n// trivia\\n" });
       let identityError;
       try { module.nativeCliExecutorIdentity(source, "srn-client"); } catch (error) { identityError = error; }
       if (result.classification !== "ambiguous" || !result.error?.includes("semantic JavaScript parser is unavailable") || !identityError?.message.includes("npm ci --prefix scripts")) process.exit(9);`,
    ],
    {
      cwd: isolated,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    },
  );
  assert.equal(result.status, 0, result.stderr);
});

test("shared native executor behavior releases every native product", () => {
  const context = repositoryFixture();
  try {
    tagNativeProducts(context.repo);
    write(
      context.repo,
      "scripts/native-cli-release.mjs",
      FIXTURE_NATIVE_EXECUTOR.replace("return value + 1", "return value + 2"),
    );
    commit(context.repo, "change shared native behavior");

    for (const result of Object.values(analyzeNativeProducts(context.repo))) {
      assert.equal(result.changed, true);
      assert.deepEqual(result.matchedFiles, ["scripts/native-cli-release.mjs"]);
      assert.ok(
        result.reasons.some(
          ({ code, products }) =>
            code === "native-executor-shared-semantic-change" &&
            products.length === NATIVE_CLI_RELEASE_PRODUCTS.length,
        ),
      );
    }
  } finally {
    context.cleanup();
  }
});

test("product-local native semantics release only that product", () => {
  const context = repositoryFixture();
  try {
    tagNativeProducts(context.repo);
    write(
      context.repo,
      "scripts/native-cli-release.mjs",
      FIXTURE_NATIVE_EXECUTOR.replace(
        '"srn-client": Object.freeze({ planSchema: 1 })',
        '"srn-client": Object.freeze({ planSchema: 2 })',
      ),
    );
    commit(context.repo, "change client native semantics");

    const decisions = analyzeNativeProducts(context.repo);
    for (const [target, result] of Object.entries(decisions)) {
      assert.equal(result.changed, target === "srn-client");
    }
    assert.ok(
      decisions["srn-client"].reasons.some(
        ({ code, products }) =>
          code === "native-executor-product-semantic-change" &&
          products.join(",") === "srn-client",
      ),
    );
  } finally {
    context.cleanup();
  }
});

test("home-server supplemental behavior releases only home-server", () => {
  const context = repositoryFixture();
  try {
    tagNativeProducts(context.repo);
    write(
      context.repo,
      "scripts/native-cli-release.mjs",
      FIXTURE_NATIVE_EXECUTOR.replace('"home-v1"', '"home-v2"'),
    );
    commit(context.repo, "change home-server supplemental packaging");

    const decisions = analyzeNativeProducts(context.repo);
    for (const [target, result] of Object.entries(decisions)) {
      assert.equal(result.changed, target === "srn-home-server");
    }
  } finally {
    context.cleanup();
  }
});

test("ambiguous native executor edits fail closed for every native product", () => {
  const context = repositoryFixture();
  try {
    tagNativeProducts(context.repo);
    write(
      context.repo,
      "scripts/native-cli-release.mjs",
      "export const malformed = ;\n",
    );
    commit(context.repo, "make native semantics ambiguous");

    for (const target of NATIVE_CLI_RELEASE_PRODUCTS) {
      assert.throws(
        () => analyzeProductImpact({ repo: context.repo, target }),
        (error) =>
          error instanceof ReleaseImpactError &&
          error.code === "ambiguous-native-executor-semantics",
      );
    }
  } finally {
    context.cleanup();
  }
});

test("release packaging contracts classify semantic scopes exactly", () => {
  const cases = [
    {
      affectedProducts: [],
      source: REFORMATTED_FIXTURE_RELEASE_PACKAGING_CONTRACT,
    },
    {
      affectedProducts: [...RELEASE_PACKAGING_CONTRACT_PRODUCTS],
      source: FIXTURE_RELEASE_PACKAGING_CONTRACT.replace(
        "return value + 1",
        "return value + 2",
      ),
    },
    {
      affectedProducts: [...NATIVE_CLI_RELEASE_PRODUCTS],
      source: FIXTURE_RELEASE_PACKAGING_CONTRACT.replace(
        'embeddedRuntime: "node24"',
        'embeddedRuntime: "node25"',
      ),
    },
    {
      affectedProducts: ["srn-desktop"],
      source: FIXTURE_RELEASE_PACKAGING_CONTRACT.replace(
        'builder: "desktop-v1"',
        'builder: "desktop-v2"',
      ),
    },
    {
      affectedProducts: ["srn-home-server"],
      source: FIXTURE_RELEASE_PACKAGING_CONTRACT.replace(
        'supplementalArtifact: "home-v1"',
        'supplementalArtifact: "home-v2"',
      ),
    },
  ];
  for (const { affectedProducts, source } of cases) {
    assert.deepEqual(
      classifyReleasePackagingContractSemanticChange({
        beforeSource: FIXTURE_RELEASE_PACKAGING_CONTRACT,
        afterSource: source,
      }).affectedProducts,
      affectedProducts,
    );
  }
});

test("legacy semantic baselines migrate with conservative full fanout", () => {
  const native = classifyNativeCliExecutorSemanticChange({
    beforeSource: "export const legacyNativeExecutor = true;\n",
    afterSource: FIXTURE_NATIVE_EXECUTOR,
  });
  assert.equal(native.classification, "shared");
  assert.equal(native.migration, true);
  assert.deepEqual(native.affectedProducts, NATIVE_CLI_RELEASE_PRODUCTS);

  const packaging = classifyReleasePackagingContractSemanticChange({
    beforeSource: "export const legacyPackaging = true;\n",
    afterSource: FIXTURE_RELEASE_PACKAGING_CONTRACT,
  });
  assert.equal(packaging.classification, "shared");
  assert.equal(packaging.migration, true);
  assert.deepEqual(
    packaging.affectedProducts,
    RELEASE_PACKAGING_CONTRACT_PRODUCTS,
  );
});

test("home-server packaging contract changes release only home-server", () => {
  const context = repositoryFixture();
  try {
    tagReleasePackagingProducts(context.repo);
    write(
      context.repo,
      "scripts/release-packaging-contract.mjs",
      FIXTURE_RELEASE_PACKAGING_CONTRACT.replace(
        'supplementalArtifact: "home-v1"',
        'supplementalArtifact: "home-v2"',
      ),
    );
    commit(context.repo, "change home-server packaging contract");

    const decisions = analyzeReleasePackagingProducts(context.repo);
    for (const [target, result] of Object.entries(decisions)) {
      assert.equal(result.changed, target === "srn-home-server");
    }
    assert.ok(
      decisions["srn-home-server"].reasons.some(
        ({ code, products }) =>
          code === "release-packaging-contract-product-semantic-change" &&
          products.join(",") === "srn-home-server",
      ),
    );
  } finally {
    context.cleanup();
  }
});

test("release packaging contract trivia releases no managed product", () => {
  const context = repositoryFixture();
  try {
    tagReleasePackagingProducts(context.repo);
    write(
      context.repo,
      "scripts/release-packaging-contract.mjs",
      REFORMATTED_FIXTURE_RELEASE_PACKAGING_CONTRACT,
    );
    commit(context.repo, "format release packaging contract");

    for (const result of Object.values(
      analyzeReleasePackagingProducts(context.repo),
    )) {
      assert.equal(result.changed, false);
      assert.ok(
        result.ignoredFiles.includes("scripts/release-packaging-contract.mjs"),
      );
    }
  } finally {
    context.cleanup();
  }
});

test("ambiguous release packaging contracts fail closed for every product", () => {
  const context = repositoryFixture();
  try {
    tagReleasePackagingProducts(context.repo);
    write(
      context.repo,
      "scripts/release-packaging-contract.mjs",
      "export const RELEASE_PACKAGING_CONTRACTS = ;\n",
    );
    commit(context.repo, "make release packaging contract ambiguous");

    for (const target of RELEASE_PACKAGING_CONTRACT_PRODUCTS) {
      assert.throws(
        () => analyzeProductImpact({ repo: context.repo, target }),
        (error) =>
          error instanceof ReleaseImpactError &&
          error.code === "ambiguous-release-packaging-contract-semantics",
      );
    }
  } finally {
    context.cleanup();
  }
});

test("desktop updater metadata verification releases only desktop", () => {
  const context = repositoryFixture();
  try {
    tagReleasePackagingProducts(context.repo);
    write(
      context.repo,
      "app/scripts/verify-desktop-updater-metadata.rb",
      "abort 'invalid' unless ARGV.length == 3\n",
    );
    commit(context.repo, "harden desktop updater verification");

    const decisions = analyzeReleasePackagingProducts(context.repo);
    for (const [target, result] of Object.entries(decisions)) {
      assert.equal(result.changed, target === "srn-desktop");
    }
    assert.ok(
      decisions["srn-desktop"].reasons.some(
        ({ code, paths }) =>
          code === "release-build-config-change" &&
          paths.join(",") === "app/scripts/verify-desktop-updater-metadata.rb",
      ),
    );

    const surface = discoverReleaseTargetSurface({
      repo: context.repo,
      target: "srn-desktop",
    });
    assert.ok(
      surface.configPaths.includes(
        "app/scripts/verify-desktop-updater-metadata.rb",
      ),
    );
  } finally {
    context.cleanup();
  }
});

test("semantic parser dependency changes release every managed product", () => {
  const context = repositoryFixture();
  try {
    tagReleasePackagingProducts(context.repo);
    write(
      context.repo,
      "scripts/package-lock.json",
      '{"lockfileVersion":3,"packages":{"node_modules/@babel/parser":{"version":"7.29.7"}}}\n',
    );
    commit(context.repo, "update semantic parser dependency lock");

    for (const result of Object.values(
      analyzeReleasePackagingProducts(context.repo),
    )) {
      assert.equal(result.changed, true);
      assert.ok(
        result.reasons.some(
          ({ code, paths }) =>
            code === "release-build-config-change" &&
            paths.join(",") === "scripts/package-lock.json",
        ),
      );
      assert.ok(result.configPaths.includes("scripts/package.json"));
      assert.ok(result.configPaths.includes("scripts/package-lock.json"));
    }
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
      forceReason: "  manual recovery of a compromised artifact  ",
    });
    assert.equal(result.changed, true);
    assert.equal(result.forced, true);
    assert.equal(
      result.forceReason,
      "manual recovery of a compromised artifact",
    );
    assert.equal(result.reasons[0].code, "forced-release");
    assert.equal(result.publicationGate, "force-requested");

    assert.throws(
      () =>
        analyzeWorkspacePackageImpact({
          repo: context.repo,
          packageName: "@fixture/a",
          workspaceRoot: "root",
          force: true,
          forceReason: "x".repeat(501),
        }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "force-reason-too-long",
    );
    assert.throws(
      () =>
        analyzeWorkspacePackageImpact({
          repo: context.repo,
          packageName: "@fixture/a",
          workspaceRoot: "root",
          force: true,
          forceReason: "line one\nline two",
        }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "invalid-force-reason",
    );
    assert.throws(
      () =>
        analyzeWorkspacePackageImpact({
          repo: context.repo,
          packageName: "@fixture/a",
          workspaceRoot: "root",
          force: true,
          forceReason: "line one\u2028line two",
        }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "invalid-force-reason",
    );
    assert.throws(
      () =>
        analyzeWorkspacePackageImpact({
          repo: context.repo,
          packageName: "@fixture/a",
          workspaceRoot: "root",
          forceReason: "not actually forced",
        }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "unexpected-force-reason",
    );
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
      yarnWorkspaces: 10,
      standaloneManagedPackages: 2,
      workflowOwners: 42,
      distributionSurfaces: 2,
    });
    assert.deepEqual(result.categoryCounts, {
      "release-managed": 6,
      "distribution-surface": 2,
      "publishable-unmanaged": 1,
      private: 1,
    });
    assert.equal(result.workspaces.length, 10);
    assert.equal(
      result.workspaces.find(
        ({ identity }) => identity === "@standardnotes/upstream",
      ).category,
      "publishable-unmanaged",
    );
    const unmanaged = result.workspaces.find(
      ({ identity }) => identity === "@standardnotes/upstream",
    );
    assert.equal(unmanaged.analysisStatus, "inventory-only");
    assert.equal(unmanaged.publicationPolicy, "unmanaged");
    assert.equal(unmanaged.changed, null);
    assert.equal(unmanaged.tagPrefix, null);
    assert.equal(
      result.workspaces.find(({ identity }) => identity === "@fixture/private")
        .category,
      "private",
    );
    const privateWorkspace = result.workspaces.find(
      ({ identity }) => identity === "@fixture/private",
    );
    assert.equal(privateWorkspace.analysisStatus, "inventory-only");
    assert.equal(privateWorkspace.publicationPolicy, "disabled-private");
    assert.equal(privateWorkspace.changed, null);
    assert.equal(
      result.workspaces.find(
        ({ identity }) => identity === "@standardnotes/desktop",
      ).category,
      "release-managed",
    );
    for (const identity of ["@standardnotes/clipper", "@standardnotes/web"]) {
      const surface = result.workspaces.find(
        (entry) => entry.identity === identity,
      );
      assert.equal(surface.category, "distribution-surface");
      assert.equal(surface.analysisStatus, "distribution-surface");
      assert.equal(
        surface.publicationPolicy,
        "upstream-distribution-publisher-quarantined",
      );
      assert.equal(
        surface.packagePublicationPolicy,
        "not-applicable-distribution-surface",
      );
      assert.notEqual(surface.publicationPolicy, "disabled-private");
    }
    assert.deepEqual(result.workflowOwnership.classificationCounts, {
      "canonical-change-gated": 8,
      "noncanonical-manual-recovery": 2,
      "canonical-support": 1,
      "quarantined-upstream-mutation": 19,
      "noncanonical-external-mutation": 3,
      "protected-main-container-publication": 1,
      "root-nonmutating-support": 1,
      "embedded-nonmutating-support": 7,
    });
    assert.deepEqual(result.workflowOwnership.scopeCounts, {
      rootDiscoverable: 11,
      embeddedPortable: 12,
      quarantined: 19,
    });
    assert.deepEqual(result.workflowOwnership.quarantineCounts, {
      app: 6,
      server: 13,
      total: 19,
    });
    assert.deepEqual(result.workflowOwnership.embeddedSupportCounts, {
      app: 2,
      server: 5,
      total: 7,
    });
    const workflowsByPath = new Map(
      result.workflowOwnership.workflows.map((entry) => [entry.path, entry]),
    );
    const rootDesktop = workflowsByPath.get(
      ".github/workflows/srn-desktop.yml",
    );
    assert.equal(rootDesktop.rootDiscoverable, true);
    assert.equal(rootDesktop.embeddedPortable, false);
    assert.equal(rootDesktop.status, "root-active");
    assert.deepEqual(rootDesktop.rootTriggers, ["push", "workflow_dispatch"]);
    assert.deepEqual(rootDesktop.targets, [
      "GitHub Releases: desktop installers",
    ]);
    const rootCi = workflowsByPath.get(".github/workflows/ci.yml");
    assert.equal(rootCi.classification, "protected-main-container-publication");
    assert.equal(rootCi.targetKind, "validation-and-container-distribution");
    assert.deepEqual(rootCi.rootTriggers, [
      "pull_request",
      "push",
      "schedule",
      "workflow_dispatch",
    ]);
    assert.deepEqual(rootCi.targets, [
      "repository checks and test artifacts",
      "GHCR ghcr.io/supermarsx/standard-red-notes-app:sha-<40-char-commit>-run-<run-id>.<producer-attempt> (linux/amd64)",
      "GHCR ghcr.io/supermarsx/standard-red-notes-server:sha-<40-char-commit>-run-<run-id>.<producer-attempt> (linux/amd64)",
    ]);
    const embeddedDesktop = workflowsByPath.get(
      "app/.github/workflows/desktop.release.prod.yml",
    );
    assert.equal(embeddedDesktop.rootDiscoverable, false);
    assert.equal(embeddedDesktop.embeddedPortable, true);
    assert.equal(embeddedDesktop.status, "non-root-active");
    assert.deepEqual(embeddedDesktop.portableTriggers, ["workflow_dispatch"]);
    assert.ok(embeddedDesktop.targets.includes("Snap Store"));
    assert.deepEqual(
      workflowsByPath.get(".github/workflows/docs-pages.yml").rootTriggers,
      ["pull_request", "push", "workflow_dispatch"],
    );
    assert.equal(
      result.workflowOwnership.workflows.filter(
        (entry) =>
          entry.classification === "embedded-nonmutating-support" &&
          entry.path.startsWith("server/"),
      ).length,
      5,
    );
    assert.equal(result.distributionSurfaces.length, 2);
    assert.equal(
      result.workflowOwnership.workflows.find(({ path: workflowPath }) =>
        workflowPath.endsWith("releases.notify.yml"),
      ).targetKind,
      "non-package-external-mutation",
    );
    assert.equal(
      result.workflowOwnership.workflows.find(({ path: workflowPath }) =>
        workflowPath.endsWith("git-sync.yml"),
      ).targetKind,
      "non-package-external-mutation",
    );
    assert.ok(analysisContext.workspaces.size >= 3);

    const report = renderReleaseImpactReport(result);
    for (const required of [
      "## Managed release products",
      "## Workflow and distribution ownership",
      "### Shipped workspace distribution surfaces",
      "## Standalone managed packages",
      "## Yarn workspace inventory",
      "@standardnotes/upstream",
      "publishable-unmanaged",
      "does not assert that this repository publishes",
      "inventory-only",
      "not evaluated",
      "upstream-distribution-publisher-quarantined",
      "non-package-external-mutation",
      "rootDiscoverable",
      "embeddedPortable",
      "non-root-active",
      "server=13",
    ]) {
      assert.match(report, new RegExp(required.replaceAll("*", "\\*")));
    }

    const blockedReport = renderReleaseImpactReport({
      ...result,
      products: result.products.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              changed: true,
              publicationGate: "blocked-release-history",
              reasons: [{ code: "divergent-release" }],
              divergentReleaseRefs: [`${entry.tagPrefix}99.1`],
            }
          : entry,
      ),
    });
    assert.match(blockedReport, /blocked-release-history/);
    assert.match(blockedReport, /divergent-release/);
  } finally {
    context.cleanup();
  }
});

test("workflow ownership fails closed when a quarantined publisher is reactivated", () => {
  const context = repositoryFixture();
  try {
    const filename = "clipper.release.prod.yml";
    write(
      context.repo,
      `app/.github/workflows/${filename}`,
      readFileSync(
        path.join(
          context.repo,
          "app/.github/upstream-workflows-disabled",
          filename,
        ),
        "utf8",
      ),
    );
    commit(context.repo, "reactivate quarantined workflow");

    assert.throws(
      () => discoverWorkflowOwnership({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "quarantined-workflow-reactivated",
    );
  } finally {
    context.cleanup();
  }
});

test("workflow ownership fails closed when the exact quarantine inventory is incomplete", () => {
  const context = repositoryFixture();
  try {
    rmSync(
      path.join(
        context.repo,
        "app/.github/upstream-workflows-disabled/releases.notify.yml",
      ),
    );
    commit(context.repo, "remove quarantined workflow");

    assert.throws(
      () => discoverWorkflowOwnership({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "missing-quarantined-workflow",
    );
  } finally {
    context.cleanup();
  }
});

test("server workflow ownership fails closed when a quarantined publisher is reactivated", () => {
  const context = repositoryFixture();
  try {
    const filename = "analytics.yml";
    write(
      context.repo,
      `server/.github/workflows/${filename}`,
      readFileSync(
        path.join(
          context.repo,
          "server/.github/upstream-workflows-disabled",
          filename,
        ),
        "utf8",
      ),
    );
    commit(context.repo, "reactivate server publisher");

    assert.throws(
      () => discoverWorkflowOwnership({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "quarantined-workflow-reactivated",
    );
  } finally {
    context.cleanup();
  }
});

test("server workflow ownership requires all 13 quarantined mutations", () => {
  const context = repositoryFixture();
  try {
    rmSync(
      path.join(
        context.repo,
        "server/.github/upstream-workflows-disabled/common-deploy.yml",
      ),
    );
    commit(context.repo, "remove server quarantine entry");

    assert.throws(
      () => discoverWorkflowOwnership({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "missing-quarantined-workflow",
    );
  } finally {
    context.cleanup();
  }
});

test("server workflow ownership rejects unknown embedded mutations", () => {
  const context = repositoryFixture();
  try {
    write(
      context.repo,
      "server/.github/workflows/automation.yml",
      "name: server automation\non:\n  workflow_dispatch:\njobs:\n  mutate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker push standardnotes/unknown:latest\n",
    );
    commit(context.repo, "add unknown server mutation");

    assert.throws(
      () => discoverWorkflowOwnership({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "unclassified-external-mutation-workflow",
    );
  } finally {
    context.cleanup();
  }
});

test("server workflow ownership rejects moving embedded support across its boundary", () => {
  const context = repositoryFixture();
  try {
    const filename = "common-e2e.yml";
    const activePath = path.join(
      context.repo,
      "server/.github/workflows",
      filename,
    );
    write(
      context.repo,
      `server/.github/upstream-workflows-disabled/${filename}`,
      readFileSync(activePath, "utf8"),
    );
    rmSync(activePath);
    commit(context.repo, "move server support workflow");

    assert.throws(
      () => discoverWorkflowOwnership({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "release-workflow-misplaced",
    );
  } finally {
    context.cleanup();
  }
});

test("every activation class enforces its exact trigger contract", () => {
  const context = repositoryFixture();
  try {
    write(
      context.repo,
      ".github/workflows/docs-pages.yml",
      "name: docs pages\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/deploy-pages@fixture\n",
    );
    commit(context.repo, "drop docs pull request trigger");

    assert.throws(
      () => discoverWorkflowOwnership({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "workflow-activation-mismatch",
    );
  } finally {
    context.cleanup();
  }
});

test("protected-main CI publication requires the coordinated GHCR app and server targets", () => {
  const context = repositoryFixture();
  try {
    const workflowPath = path.join(context.repo, ".github/workflows/ci.yml");
    const original = readFileSync(workflowPath, "utf8");
    const mutated = original.replace(
      "ghcr.io/supermarsx/standard-red-notes-server",
      "ghcr.io/supermarsx/standard-red-notes-unclassified",
    );
    assert.notEqual(mutated, original);
    write(context.repo, ".github/workflows/ci.yml", mutated);
    commit(context.repo, "break coordinated GHCR target");

    assert.throws(
      () => discoverWorkflowOwnership({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "workflow-publication-contract-mismatch" &&
        error.message.includes("server GHCR target"),
    );
  } finally {
    context.cleanup();
  }
});

test("workflow ownership rejects an unclassified production workflow", () => {
  const context = repositoryFixture();
  try {
    write(
      context.repo,
      ".github/workflows/mystery.release.prod.yml",
      "name: mystery publisher\non:\n  workflow_dispatch:\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo publish\n",
    );
    commit(context.repo, "add unknown production workflow");

    assert.throws(
      () => discoverWorkflowOwnership({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "unclassified-external-mutation-workflow",
    );
  } finally {
    context.cleanup();
  }
});

test("workflow ownership rejects an unclassified external mutation hidden behind a neutral filename", () => {
  const context = repositoryFixture();
  try {
    write(
      context.repo,
      "app/.github/workflows/automation.yml",
      "name: automation\non:\n  workflow_dispatch:\njobs:\n  mutate:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker push standardnotes/unknown:latest\n",
    );
    commit(context.repo, "add unknown external mutation");

    assert.throws(
      () => discoverWorkflowOwnership({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "unclassified-external-mutation-workflow",
    );
  } finally {
    context.cleanup();
  }
});

test("distribution surfaces reject a false private-package policy claim", () => {
  const context = repositoryFixture();
  try {
    write(
      context.repo,
      "app/packages/clipper/package.json",
      manifest("@standardnotes/clipper", {}, false),
    );
    commit(context.repo, "make clipper package publishable");

    assert.throws(
      () => analyzeRepositoryReleaseImpact({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "distribution-workspace-policy-mismatch",
    );
  } finally {
    context.cleanup();
  }
});

test("standalone recovery publishers remain manual-only", () => {
  const context = repositoryFixture();
  try {
    write(
      context.repo,
      "app/.github/workflows/mobile.release.prod.yml",
      "name: mobile recovery\non:\n  push:\n    tags: ['*']\n  workflow_dispatch:\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create fixture\n",
    );
    commit(context.repo, "add automatic standalone mobile trigger");

    assert.throws(
      () => discoverWorkflowOwnership({ repo: context.repo }),
      (error) =>
        error instanceof ReleaseImpactError &&
        error.code === "workflow-activation-mismatch",
    );
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
    assert.equal(machine.workspaces.length, 10);
    assert.equal(machine.standaloneManagedPackages.length, 2);
    assert.equal(machine.workflowOwnership.workflows.length, 42);
    assert.equal(machine.distributionSurfaces.length, 2);
    assert.match(
      readFileSync(path.join(context.repo, "release-impact.md"), "utf8"),
      /## Workflow and distribution ownership/,
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
    "distribution-surface": 2,
    "publishable-unmanaged": 24,
    private: 12,
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

test("the mobile release trigger surface exposes its complete dependency closure", () => {
  const surface = discoverReleaseTargetSurface({
    repo: repositoryRoot,
    target: "srn-mobile",
  });

  assert.deepEqual(surface.dependencyClosure, [
    "@standardnotes/api",
    "@standardnotes/encryption",
    "@standardnotes/features",
    "@standardnotes/filepicker",
    "@standardnotes/files",
    "@standardnotes/icons",
    "@standardnotes/mobile",
    "@standardnotes/models",
    "@standardnotes/responses",
    "@standardnotes/services",
    "@standardnotes/sncrypto-common",
    "@standardnotes/sncrypto-web",
    "@standardnotes/snjs",
    "@standardnotes/styles",
    "@standardnotes/toast",
    "@standardnotes/ui-services",
    "@standardnotes/utils",
    "@standardnotes/web",
  ]);
  assert.ok(
    surface.configPaths.includes(
      "app/.github/workflows/mobile.release.prod.yml",
    ),
  );
  assert.deepEqual(surface.configPrefixes, [
    "app/.yarn/patches",
    "app/.yarn/releases",
  ]);
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
