#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(scriptPath), "..");

export const CI_CONTRACT_FILES = Object.freeze([
  ".github/workflows/ci.yml",
  ".github/workflows/docs-pages.yml",
  ".github/workflows/srn-mcp.yml",
  "app/.nvmrc",
  "package.json",
  "server/.nvmrc",
  "server/Dockerfile",
  "server/package.json",
  "scripts/setup.ps1",
  "scripts/setup.sh",
  "docs/ci-production-gates.md",
  "docs/_data/navigation.yml",
]);

export const CI_PAGES_ACTIONS = Object.freeze({
  attestBuildProvenance: Object.freeze({
    action: "actions/attest-build-provenance",
    sha: "0f67c3f4856b2e3261c31976d6725780e5e4c373",
    version: "v4.1.1",
  }),
  cache: Object.freeze({
    action: "actions/cache",
    sha: "55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
    version: "v6.1.0",
  }),
  checkout: Object.freeze({
    action: "actions/checkout",
    sha: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    version: "v7.0.1",
  }),
  configurePages: Object.freeze({
    action: "actions/configure-pages",
    sha: "45bfe0192ca1faeb007ade9deae92b16b8254a0d",
    version: "v6.0.0",
  }),
  deployPages: Object.freeze({
    action: "actions/deploy-pages",
    sha: "cd2ce8fcbc39b97be8ca5fce6e763baed58fa128",
    version: "v5.0.0",
  }),
  downloadArtifact: Object.freeze({
    action: "actions/download-artifact",
    sha: "3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    version: "v8.0.1",
  }),
  jekyllBuildPages: Object.freeze({
    action: "actions/jekyll-build-pages",
    sha: "44a6e6beabd48582f863aeeb6cb2151cc1716697",
    version: "v1.0.13",
  }),
  loginRegistry: Object.freeze({
    action: "docker/login-action",
    sha: "af1e73f918a031802d376d3c8bbc3fe56130a9b0",
    version: "v4.4.0",
  }),
  setupBuildx: Object.freeze({
    action: "docker/setup-buildx-action",
    sha: "bb05f3f5519dd87d3ba754cc423b652a5edd6d2c",
    version: "v4.2.0",
  }),
  setupNode: Object.freeze({
    action: "actions/setup-node",
    sha: "820762786026740c76f36085b0efc47a31fe5020",
    version: "v7.0.0",
  }),
  uploadArtifact: Object.freeze({
    action: "actions/upload-artifact",
    sha: "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    version: "v7.0.1",
  }),
  uploadPagesArtifact: Object.freeze({
    action: "actions/upload-pages-artifact",
    sha: "fc324d3547104276b827a68afc52ff2a11cc49c9",
    version: "v5.0.0",
  }),
  buildPush: Object.freeze({
    action: "docker/build-push-action",
    sha: "53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
    version: "v7.3.0",
  }),
});

const approvedActionsByReference = new Map(
  Object.values(CI_PAGES_ACTIONS).map((entry) => [
    `${entry.action}@${entry.sha}`,
    entry.version,
  ]),
);

export function approvedWorkflowAction(name) {
  const entry = CI_PAGES_ACTIONS[name];
  if (!entry) {
    throw new Error(`Unknown CI/Pages action policy key: ${name}`);
  }
  return `${entry.action}@${entry.sha} # ${entry.version}`;
}

export function validateImmutableWorkflowActions(file, workflow) {
  const errors = [];
  for (const [index, line] of workflow.split(/\r?\n/).entries()) {
    if (line.trimStart().startsWith("#")) {
      continue;
    }
    const uses = /^\s*(?:-\s*)?uses:\s+(\S+)/.exec(line)?.[1];
    if (!uses || uses.startsWith("./")) {
      continue;
    }

    const lineNumber = index + 1;
    const external = /^([^\s@]+)@([^\s@]+)$/.exec(uses);
    if (!external) {
      errors.push(
        `${file}:${lineNumber}: unsupported action reference ${uses}`,
      );
      continue;
    }

    const [, , reference] = external;
    if (!/^[0-9a-f]{40}$/.test(reference)) {
      errors.push(
        `${file}:${lineNumber}: mutable external action reference ${uses}`,
      );
      continue;
    }

    const approvedVersion = approvedActionsByReference.get(uses);
    if (!approvedVersion) {
      errors.push(
        `${file}:${lineNumber}: unapproved external action reference ${uses}`,
      );
      continue;
    }

    const versionLabel = /\s+#\s*(\S+)\s*$/.exec(line)?.[1];
    if (versionLabel !== approvedVersion) {
      errors.push(
        `${file}:${lineNumber}: incorrect human version label for ${uses}; expected ${approvedVersion}`,
      );
    }
  }
  return errors;
}

export function loadCiContractFiles(repositoryRoot = defaultRepositoryRoot) {
  return new Map(
    CI_CONTRACT_FILES.map((file) => [
      file,
      readFileSync(path.join(repositoryRoot, file), "utf8"),
    ]),
  );
}

function requireFragment(errors, file, text, fragment, description) {
  if (!text.includes(fragment)) {
    errors.push(`${file}: missing ${description}`);
  }
}

export function validateSetupOverwriteContract(shellSetup, powershellSetup) {
  const errors = [];
  for (const [file, source, fragments] of [
    [
      "scripts/setup.sh",
      shellSetup,
      [
        [
          "--force-overwrite) FORCE_OVERWRITE=1",
          "explicit force-overwrite flag",
        ],
        [
          'if [ "$FORCE_OVERWRITE" -ne 1 ]; then',
          "normal-rerun existing-config guard",
        ],
        [
          "normal setup reruns never rotate existing secrets",
          "existing-config reuse diagnostic",
        ],
        [
          "npm run recover:database",
          "one-command accidental-overwrite recovery",
        ],
        [
          "--generate-assistant-subscription-key) GENERATE_ASSISTANT_SUBSCRIPTION_KEY=1",
          "explicit assistant pairing key migration flag",
        ],
        [
          "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY}",
          "fresh-install assistant pairing key persistence",
        ],
        [
          "ENFORCE_HTTPS_FROM_PROXY=${USE_HTTPS}",
          "fresh-install trusted proxy transport selection",
        ],
        [
          "APP_BIND_ADDRESS=${APP_BIND_ADDRESS}",
          "fresh-install proxy-safe app bind selection",
        ],
        [
          "git -C \"$REPO_ROOT\" rev-parse --verify 'HEAD^{commit}'",
          "exact deployment commit resolution",
        ],
        [
          "status --porcelain=v1 --untracked-files=all",
          "dirty checkout rejection",
        ],
        [
          'export SRN_DEPLOY_REVISION="$revision"',
          "ephemeral deployment revision export",
        ],
        [
          'export SRN_DEPLOY_VERSION="setup-${revision:0:12}"',
          "ephemeral deployment version export",
        ],
        [
          "verify_started_deployment_identity",
          "live app/server identity acceptance",
        ],
        ["./scripts/setup.sh --up", "identity-safe setup rerun instruction"],
      ],
    ],
    [
      "scripts/setup.ps1",
      powershellSetup,
      [
        ["[switch]$ForceOverwrite", "explicit ForceOverwrite switch"],
        ["if (-not $ForceOverwrite)", "normal-rerun existing-config guard"],
        [
          "normal setup reruns never rotate existing secrets",
          "existing-config reuse diagnostic",
        ],
        [
          "npm run recover:database",
          "one-command accidental-overwrite recovery",
        ],
        [
          "[switch]$GenerateAssistantSubscriptionKey",
          "explicit assistant pairing key migration switch",
        ],
        [
          "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=$AssistantSubscriptionEncryptionKey",
          "fresh-install assistant pairing key persistence",
        ],
        [
          "ENFORCE_HTTPS_FROM_PROXY=$UseHttps",
          "fresh-install trusted proxy transport selection",
        ],
        [
          "APP_BIND_ADDRESS=$AppBindAddress",
          "fresh-install proxy-safe app bind selection",
        ],
        [
          "rev-parse --verify 'HEAD^{commit}'",
          "exact deployment commit resolution",
        ],
        [
          "status --porcelain=v1 --untracked-files=all",
          "dirty checkout rejection",
        ],
        [
          "$env:SRN_DEPLOY_REVISION = $revision",
          "ephemeral deployment revision export",
        ],
        [
          '$env:SRN_DEPLOY_VERSION = "setup-$($revision.Substring(0, 12))"',
          "ephemeral deployment version export",
        ],
        [
          "Assert-StartedDeploymentIdentity",
          "live app/server identity acceptance",
        ],
        [".\\scripts\\setup.ps1 -Up", "identity-safe setup rerun instruction"],
      ],
    ],
  ]) {
    for (const [fragment, description] of fragments) {
      requireFragment(errors, file, source, fragment, description);
    }
  }

  for (const [file, source, resolvePattern, buildPattern, verifyPattern] of [
    [
      "scripts/setup.sh",
      shellSetup,
      /^\s+resolve_clean_deployment_revision\s*$/gm,
      /\(\s*cd "\$REPO_ROOT" && \$COMPOSE up -d --build\s*\)/g,
      /^\s+verify_started_deployment_identity\s*$/gm,
    ],
    [
      "scripts/setup.ps1",
      powershellSetup,
      /^\s*try \{ \$deploymentRevision = Set-CleanDeploymentRevision \} catch/gm,
      /^\s*(?:Invoke-ComposeCommand -Arguments @\('up', '-d', '--build'\)|if \(\$Compose -eq 'docker compose'\) \{ docker compose up -d --build \})/gm,
      /^\s*try \{ Assert-StartedDeploymentIdentity -Revision \$deploymentRevision \} catch/gm,
    ],
  ]) {
    const positions = (pattern) =>
      [...source.matchAll(pattern)].map((match) => match.index);
    const resolves = positions(resolvePattern);
    const builds = positions(buildPattern);
    const verifies = positions(verifyPattern);
    if (resolves.length !== 3 || builds.length !== 3 || verifies.length !== 3) {
      errors.push(
        `${file}: every one of the three build/start paths must resolve and verify deployment identity`,
      );
      continue;
    }
    for (let index = 0; index < 3; index += 1) {
      if (
        !(resolves[index] < builds[index] && builds[index] < verifies[index])
      ) {
        errors.push(
          `${file}: deployment identity must resolve before build and verify after start`,
        );
        break;
      }
    }
  }
  return errors;
}

function exactNodeVersion(value) {
  const raw = String(value ?? "").trim();
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  return match
    ? {
        raw,
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
      }
    : null;
}

function minimumNodeEngine(value) {
  const match = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim());
  return match
    ? {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
      }
    : null;
}

function versionAtLeast(version, minimum) {
  return (
    ["major", "minor", "patch"].reduce((result, field) => {
      if (result !== 0) {
        return result;
      }
      return Math.sign(version[field] - minimum[field]);
    }, 0) >= 0
  );
}

function jobBlock(workflow, jobName) {
  const marker = `\n  ${jobName}:`;
  const start = workflow.indexOf(marker);
  if (start < 0) {
    return "";
  }

  const contentStart = start + marker.length;
  const remainder = workflow.slice(contentStart);
  const nextJob = remainder.search(/\r?\n  [A-Za-z0-9_-]+:\r?\n/);
  return nextJob < 0 ? remainder : remainder.slice(0, nextJob);
}

function workflowWithoutJob(workflow, jobName) {
  const marker = `\n  ${jobName}:`;
  const start = workflow.indexOf(marker);
  if (start < 0) {
    return workflow;
  }

  const remainder = workflow.slice(start + marker.length);
  const nextJob = remainder.search(/\r?\n  [A-Za-z0-9_-]+:\r?\n/);
  const end = nextJob < 0 ? workflow.length : start + marker.length + nextJob;
  return `${workflow.slice(0, start)}${workflow.slice(end)}`;
}

function namedStepBlock(job, stepName) {
  const marker = `\n      - name: ${stepName}`;
  const start = job.indexOf(marker);
  if (start < 0) {
    return "";
  }

  const remainder = job.slice(start + marker.length);
  const nextStep = remainder.search(/\r?\n      - (?:name|uses|run):/);
  return nextStep < 0 ? remainder : remainder.slice(0, nextStep);
}

function requireJob(errors, workflow, jobName, fragments) {
  const file = ".github/workflows/ci.yml";
  const block = jobBlock(workflow, jobName);
  if (!block) {
    errors.push(`${file}: missing ${jobName} job`);
    return;
  }

  requireFragment(
    errors,
    file,
    block,
    "timeout-minutes:",
    `${jobName} timeout`,
  );
  for (const [fragment, description] of fragments) {
    requireFragment(errors, file, block, fragment, `${jobName} ${description}`);
  }
}

export function validateMcpReleaseDependencyContract(workflow) {
  const errors = [];
  const file = ".github/workflows/srn-mcp.yml";

  for (const [fragment, description] of [
    ['COREPACK_VERSION: "0.35.0"', "pinned Corepack version"],
    ['YARN_VERSION: "4.17.1"', "root Yarn version"],
  ]) {
    requireFragment(errors, file, workflow, fragment, description);
  }

  const nonPublishingWorkflow = workflowWithoutJob(
    workflow,
    "publish-containers",
  );
  for (const [pattern, description] of [
    [/\bnpm\s+install\b[^\r\n]*--no-package-lock\b/, "unlocked npm install"],
    [/\byarn\s+install\b(?!\s+--immutable\b)/, "non-immutable Yarn install"],
  ]) {
    if (pattern.test(nonPublishingWorkflow)) {
      errors.push(
        `${file}: forbidden ${description} outside publish-containers`,
      );
    }
  }
  for (const line of workflow.split(/\r?\n/)) {
    if (
      /\bnpm\s+(?:install|i)\b/.test(line) &&
      !line.includes('npm install --global "corepack@${COREPACK_VERSION}"')
    ) {
      errors.push(`${file}: forbidden non-Corepack npm install`);
      break;
    }
  }

  const audit = jobBlock(workflow, "audit");
  for (const [fragment, description] of [
    ["needs: impact", "release-impact dependency"],
    [
      "audited_sha: ${{ steps.source.outputs.audited_sha }}",
      "audited SHA output",
    ],
    [
      "lock_sha256: ${{ steps.source.outputs.lock_sha256 }}",
      "audited lock digest output",
    ],
    [
      'npm install --global "corepack@${COREPACK_VERSION}"',
      "pinned Corepack install",
    ],
    [
      'test "$(yarn --version)" = "$YARN_VERSION"',
      "exact Yarn version assertion",
    ],
    ["yarn install --immutable", "immutable root install"],
    [
      'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"',
      "exact audit SHA assertion",
    ],
    ["sha256sum yarn.lock", "audited lock digest"],
    ["yarn deps:security:production", "production dependency audit"],
  ]) {
    requireFragment(errors, file, audit, fragment, `audit ${description}`);
  }

  const dependencyJobs = new Map([
    ["lint", "yarn workspace @standard-red-notes/mcp typecheck"],
    ["format", "yarn workspace @standard-red-notes/mcp format:check"],
    ["test", "yarn workspace @standard-red-notes/mcp build"],
    ["build", "yarn workspace @standard-red-notes/mcp build"],
  ]);
  for (const [jobName, workspaceCommand] of dependencyJobs) {
    const block = jobBlock(workflow, jobName);
    for (const [fragment, description] of [
      ["audit", "audit dependency"],
      [
        'npm install --global "corepack@${COREPACK_VERSION}"',
        "pinned Corepack install",
      ],
      [
        'test "$(yarn --version)" = "$YARN_VERSION"',
        "exact Yarn version assertion",
      ],
      [
        "AUDITED_SHA: ${{ needs.audit.outputs.audited_sha }}",
        "audited SHA input",
      ],
      [
        "AUDITED_LOCK_SHA256: ${{ needs.audit.outputs.lock_sha256 }}",
        "audited lock digest input",
      ],
      ["yarn install --immutable", "immutable root install"],
      [workspaceCommand, "workspace-scoped command"],
    ]) {
      requireFragment(
        errors,
        file,
        block,
        fragment,
        `${jobName} ${description}`,
      );
    }
    const installs = block.split("yarn install --immutable").length - 1;
    if (block && installs !== 1) {
      errors.push(
        `${file}: ${jobName} must perform exactly one immutable root install, found ${installs}`,
      );
    }
  }

  const build = jobBlock(workflow, "build");
  for (const [fragment, description] of [
    [
      "needs: [impact, audit, lint, test, format]",
      "audit-bearing check fan-in",
    ],
    ["--root ..", "repository-root fingerprint boundary"],
    ["--path mcp/dist/index.cjs", "MCP bundle fingerprint input"],
    ["--path yarn.lock", "root lock fingerprint input"],
  ]) {
    requireFragment(errors, file, build, fragment, `build ${description}`);
  }

  const packageJob = jobBlock(workflow, "package");
  for (const [fragment, description] of [
    [
      "needs: [audit, build, decide, identity]",
      "direct audited package fan-in",
    ],
    [
      "AUDITED_SHA: ${{ needs.audit.outputs.audited_sha }}",
      "audited SHA input",
    ],
    [
      "AUDITED_LOCK_SHA256: ${{ needs.audit.outputs.lock_sha256 }}",
      "audited lock digest input",
    ],
    [
      'test "$AUDITED_SHA" = "$GITHUB_SHA"',
      "exact audited package SHA assertion",
    ],
    ["sha256sum yarn.lock", "audited package lock assertion"],
  ]) {
    requireFragment(
      errors,
      file,
      packageJob,
      fragment,
      `package ${description}`,
    );
  }

  const release = jobBlock(workflow, "release");
  for (const [fragment, description] of [
    [
      "needs: [impact, audit, build, decide, identity, package, smoke]",
      "direct audited publication fan-in",
    ],
    ["needs.audit.result == 'success'", "successful audit publication gate"],
    [
      "AUDITED_SHA: ${{ needs.audit.outputs.audited_sha }}",
      "audited SHA input",
    ],
    [
      "AUDITED_LOCK_SHA256: ${{ needs.audit.outputs.lock_sha256 }}",
      "audited lock digest input",
    ],
    [
      'test "$AUDITED_SHA" = "$GITHUB_SHA"',
      "exact audited publication SHA assertion",
    ],
    ["sha256sum yarn.lock", "audited publication lock assertion"],
  ]) {
    requireFragment(errors, file, release, fragment, `release ${description}`);
  }

  const immutableInstalls =
    workflow.split("yarn install --immutable").length - 1;
  if (immutableInstalls !== dependencyJobs.size + 1) {
    errors.push(
      `${file}: audit and dependency jobs must perform exactly ${dependencyJobs.size + 1} immutable root installs, found ${immutableInstalls}`,
    );
  }
  if (
    (workflow.match(/\byarn deps:security:production\b/g) ?? []).length !== 1
  ) {
    errors.push(`${file}: production dependency audit must run exactly once`);
  }
  const corepackInstalls =
    workflow.split('npm install --global "corepack@${COREPACK_VERSION}"')
      .length - 1;
  if (corepackInstalls !== dependencyJobs.size + 1) {
    errors.push(
      `${file}: audit and dependency jobs must perform exactly ${dependencyJobs.size + 1} pinned Corepack installs, found ${corepackInstalls}`,
    );
  }

  return errors;
}

export function validateCiContract(files) {
  const errors = [];
  const file = ".github/workflows/ci.yml";
  const workflow = files.get(file) ?? "";

  for (const actionWorkflow of [
    file,
    ".github/workflows/docs-pages.yml",
    ".github/workflows/srn-mcp.yml",
  ]) {
    errors.push(
      ...validateImmutableWorkflowActions(
        actionWorkflow,
        files.get(actionWorkflow) ?? "",
      ),
    );
  }

  errors.push(
    ...validateMcpReleaseDependencyContract(
      files.get(".github/workflows/srn-mcp.yml") ?? "",
    ),
    ...validateSetupOverwriteContract(
      files.get("scripts/setup.sh") ?? "",
      files.get("scripts/setup.ps1") ?? "",
    ),
  );

  for (const [fragment, description] of [
    ["name: CI", "stable workflow name"],
    ["\n  push:\n    branches: [main]", "push trigger"],
    ["\n  pull_request:\n    branches: [main]", "pull-request trigger"],
    ["schedule:", "scheduled trigger"],
    ["workflow_dispatch:", "manual trigger"],
    ["profile:", "manual validation profile"],
    ["\npermissions:\n  contents: read", "read-only contents permission"],
    [
      "group: ci-${{ github.event_name }}-${{ (github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'supermarsx/standard-red-notes') && github.run_id || github.event.pull_request.number || github.ref }}",
      "run-isolated protected-main workflow concurrency",
    ],
    [
      "cancel-in-progress: ${{ github.event_name != 'push' || github.ref != 'refs/heads/main' || github.repository != 'supermarsx/standard-red-notes' }}",
      "non-cancelling protected-main publication",
    ],
  ]) {
    requireFragment(errors, file, workflow, fragment, description);
  }

  for (const [pattern, description] of [
    [/continue-on-error\s*:/, "continue-on-error"],
    [/\|\|\s*true/, "silent shell success fallback"],
  ]) {
    if (pattern.test(workflow)) {
      errors.push(`${file}: forbidden ${description}`);
    }
  }

  const workflowWithoutContainerPublisher = workflowWithoutJob(
    workflow,
    "publish-containers",
  );
  for (const [pattern, description] of [
    [/contents:\s*write/, "contents write permission"],
    [/packages:\s*write/, "packages write permission"],
    [/id-token:\s*write/, "id-token write permission"],
    [/\b(?:npm|pnpm)\s+publish\b/, "package publishing command"],
    [/\byarn\s+npm\s+publish\b/, "Yarn publishing command"],
    [/\bgh\s+release\s+create\b/, "GitHub release command"],
    [/\bdocker\s+push\b/, "Docker push command"],
    [/push:\s*true/, "image push setting"],
  ]) {
    if (pattern.test(workflowWithoutContainerPublisher)) {
      errors.push(
        `${file}: forbidden ${description} outside publish-containers`,
      );
    }
  }

  requireJob(errors, workflow, "contracts", [
    ["yarn install --immutable", "immutable root install"],
    ["yarn deps:security:production", "production dependency audit"],
    ["yarn ci:contracts", "CI contract command"],
    ["rhysd/actionlint@sha256:", "pinned actionlint image"],
  ]);

  for (const [job, command] of [
    ["check", "yarn check"],
    ["build", "yarn build"],
  ]) {
    const requirements = [
      ["run: yarn install --immutable", "immutable root install"],
      ["working-directory: app", "app workspace install"],
      ["working-directory: server", "server workspace install"],
      [approvedWorkflowAction("cache"), "dependency cache"],
      [command, `${command} command`],
    ];
    if (job === "check") {
      requirements.push(["fetch-depth: 0", "full history checkout"]);
    }
    requireJob(errors, workflow, job, requirements);
    const block = jobBlock(workflow, job);
    const immutableInstalls =
      block.split("run: yarn install --immutable").length - 1;
    if (block && immutableInstalls !== 3) {
      errors.push(
        `${file}: ${job} must perform exactly three immutable workspace installs, found ${immutableInstalls}`,
      );
    }
  }

  requireJob(errors, workflow, "desktop-electron", [
    [approvedWorkflowAction("cache"), "dependency cache"],
    ["sudo apt-get install --yes xvfb", "Xvfb installation"],
    ["libsecret-1-0", "native keychain runtime"],
    ["working-directory: app", "app workspace"],
    ["run: yarn install --immutable", "immutable app install"],
    ["require.resolve('electron/package.json')", "Electron package resolution"],
    [
      'electron_dir="$(dirname "$electron_package")"',
      "Electron package directory",
    ],
    ['node "$electron_dir/install.js"', "explicit Electron installation"],
    [
      'sandbox="$electron_dir/dist/chrome-sandbox"',
      "Electron sandbox resolution",
    ],
    ['sudo chown root:root "$sandbox"', "Electron sandbox ownership"],
    ['sudo chmod 4755 "$sandbox"', "Electron sandbox mode"],
    ["root:root 4755", "verified Electron sandbox metadata"],
    ["run: yarn build:desktop", "desktop artifact build"],
    ["xvfb-run --auto-servernum", "virtual display"],
    [
      "yarn workspace @standardnotes/desktop ava:electron",
      "guarded real Electron suite",
    ],
  ]);
  const desktopElectronBlock = jobBlock(workflow, "desktop-electron");
  const sandboxOwnership = desktopElectronBlock.indexOf(
    'sudo chown root:root "$sandbox"',
  );
  const electronInstall = desktopElectronBlock.indexOf(
    'node "$electron_dir/install.js"',
  );
  const sandboxExistence = desktopElectronBlock.indexOf('test -f "$sandbox"');
  const sandboxMode = desktopElectronBlock.indexOf(
    'sudo chmod 4755 "$sandbox"',
  );
  const desktopBuild = desktopElectronBlock.indexOf("run: yarn build:desktop");
  const electronSuite = desktopElectronBlock.indexOf(
    "yarn workspace @standardnotes/desktop ava:electron",
  );
  if (
    electronInstall >= 0 &&
    sandboxExistence >= 0 &&
    electronInstall > sandboxExistence
  ) {
    errors.push(
      `${file}: desktop-electron must install Electron before validating its sandbox`,
    );
  }
  if (
    sandboxOwnership >= 0 &&
    sandboxMode >= 0 &&
    sandboxOwnership > sandboxMode
  ) {
    errors.push(
      `${file}: desktop-electron must set Electron sandbox ownership before mode`,
    );
  }
  if (
    desktopBuild >= 0 &&
    sandboxOwnership >= 0 &&
    desktopBuild > sandboxOwnership
  ) {
    errors.push(
      `${file}: desktop-electron must build before configuring the Electron sandbox`,
    );
  }
  if (sandboxMode >= 0 && electronSuite >= 0 && sandboxMode > electronSuite) {
    errors.push(
      `${file}: desktop-electron must configure the Electron sandbox before running tests`,
    );
  }

  requireJob(errors, workflow, "container-smoke", [
    ["hadolint/hadolint@sha256:", "pinned hadolint image"],
    [approvedWorkflowAction("buildPush"), "BuildKit image builds"],
    ["push: false", "non-publishing image builds"],
    [
      "SRN_DEPLOY_REVISION: ${{ github.sha }}",
      "exact runtime deployment revision",
    ],
    [
      "SRN_DEPLOY_VERSION: ci-${{ github.run_id }}.${{ github.run_attempt }}",
      "bounded runtime deployment version",
    ],
    [
      "node scripts/resolve-deployment-identity.mjs",
      "clean checkout identity resolution",
    ],
    [
      "SRN_DEPLOY_REVISION=${{ github.sha }}",
      "exact image revision build argument",
    ],
    [
      "SRN_DEPLOY_VERSION=ci-${{ github.run_id }}.${{ github.run_attempt }}",
      "image version build argument",
    ],
    [
      "COMPOSE_PROJECT_NAME: srn-ci-${{ github.run_id }}-${{ github.run_attempt }}-smoke",
      "isolated project name",
    ],
    [
      "--save=false @playwright/test@1.61.1",
      "non-mutating pinned Playwright install",
    ],
    [
      "docker compose up -d --no-build --wait --wait-timeout 900",
      "bounded disposable stack startup",
    ],
    [
      "yarn test:email-redis:compose",
      "required durable email queue integration",
    ],
    [
      "yarn test:email-delivery:compose",
      "required queued SMTP delivery integration",
    ],
    ["ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY", "assistant pairing key"],
    ["-e REQUIRE_GATEWAY=1", "required realtime gateway mode"],
    [
      "-e GATEWAY_HTTP=http://127.0.0.1:3000",
      "realtime gateway health endpoint",
    ],
    [
      "-e GATEWAY_WS=ws://127.0.0.1:3000/sockets",
      "realtime gateway WebSocket endpoint",
    ],
    [
      "packages/websocket-gateway/e2e/collab-yjs.e2e.mjs",
      "encrypted two-editor convergence drill",
    ],
    ['OPS_LOAD_NOTES: "25"', "bounded note count"],
    ['OPS_LOAD_CLIENTS: "2"', "bounded client count"],
    ['OPS_REDIS_WORKERS: "2"', "bounded Redis workers"],
    [
      "tests/app-opens.spec.ts tests/ops-load.spec.ts --project=chromium",
      "required Playwright and Redis smoke",
    ],
    ["--min-expected 4 --max-skipped 0", "zero-skip report assertion"],
    ["yarn ops:backup-restore", "backup and restore drill"],
    ["yarn ci:docker-hardening", "live hardening validation"],
    ["platforms: linux/amd64", "explicit image build platform"],
    [
      "publication_artifact_id: ${{ steps.publication_upload.outputs.artifact-id }}",
      "immutable container artifact ID output",
    ],
    [
      "publication_artifact_name: ${{ steps.publication_identity.outputs.artifact_name }}",
      "retry-stable container artifact name output",
    ],
    [
      "publication_attempt: ${{ steps.publication_identity.outputs.attempt }}",
      "producer attempt output",
    ],
    [
      "publication_tag: ${{ steps.publication_identity.outputs.tag }}",
      "retry-stable container tag output",
    ],
    [
      "publication_version: ${{ steps.publication_identity.outputs.version }}",
      "retry-stable container version output",
    ],
    [
      "Resolve retry-stable publication handoff identity",
      "producer-owned publication identity",
    ],
    ["id: publication_upload", "container artifact upload identity"],
    [
      "Export the exact tested app and server images",
      "post-hardening exact image export",
    ],
    ["docker save --output", "exact Docker archive export"],
    ["sha256sum images.tar", "container archive checksum"],
    [
      "artifact_name=container-publication-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
      "run-bound container handoff artifact",
    ],
    [
      "tag=sha-${GITHUB_SHA}-run-${GITHUB_RUN_ID}.${GITHUB_RUN_ATTEMPT}",
      "producer-owned coordinated image tag",
    ],
    ["{{.Os}}/{{.Architecture}}", "tested image platform assertion"],
    ["compression-level: 0", "non-recompressed Docker archive handoff"],
    ["retention-days: 1", "bounded container handoff retention"],
    ["org.opencontainers.image.revision", "live OCI revision assertion"],
    ["org.opencontainers.image.version", "live OCI version assertion"],
    [
      "/usr/share/srn-deployment/deployment.json",
      "root-owned image marker assertion",
    ],
    [
      "cmp artifacts-app-deployment.json artifacts-server-deployment.json",
      "byte-equal app/server marker assertion",
    ],
    [
      "node scripts/verify-deployment-identity.mjs",
      "same-origin app/server deployment acceptance",
    ],
    [
      "docker compose cp server:/var/lib/server/logs/. artifacts/server-logs",
      "server runtime log diagnostics",
    ],
    [
      "docker compose down --volumes --remove-orphans",
      "isolated volume cleanup",
    ],
    ["if-no-files-found: error", "required diagnostics artifact"],
  ]);

  const containerSmokeBlock = jobBlock(workflow, "container-smoke");
  const activeContainerSmokeBlock = containerSmokeBlock.replace(
    /^\s*#.*$/gm,
    "",
  );
  if (
    activeContainerSmokeBlock.split("platforms: linux/amd64").length - 1 !==
    2
  ) {
    errors.push(
      `${file}: container-smoke must build exactly two linux/amd64 images`,
    );
  }
  if (
    activeContainerSmokeBlock.split("{{.Os}}/{{.Architecture}}").length - 1 !==
    1
  ) {
    errors.push(
      `${file}: container-smoke must prove the platform of both exported images exactly once`,
    );
  }
  for (const [line, description] of [
    [
      "publication_artifact_id: ${{ steps.publication_upload.outputs.artifact-id }}",
      "artifact ID output",
    ],
    [
      "publication_artifact_name: ${{ steps.publication_identity.outputs.artifact_name }}",
      "artifact name output",
    ],
    [
      "publication_attempt: ${{ steps.publication_identity.outputs.attempt }}",
      "producer attempt output",
    ],
    [
      "publication_tag: ${{ steps.publication_identity.outputs.tag }}",
      "producer tag output",
    ],
    [
      "publication_version: ${{ steps.publication_identity.outputs.version }}",
      "producer version output",
    ],
  ]) {
    const count = activeContainerSmokeBlock
      .split(/\r?\n/)
      .filter((candidate) => candidate.trim() === line).length;
    if (count !== 1) {
      errors.push(
        `${file}: container-smoke must contain exactly 1 active ${description}, found ${count}`,
      );
    }
  }
  for (const [fragment, expectedCount, description] of [
    ["github.event_name == 'push'", 3, "main-push archive event guard"],
    ["github.ref == 'refs/heads/main'", 3, "main branch archive guard"],
    [
      "github.repository == 'supermarsx/standard-red-notes'",
      3,
      "first-party archive guard",
    ],
  ]) {
    const count = activeContainerSmokeBlock.split(fragment).length - 1;
    if (count !== expectedCount) {
      errors.push(
        `${file}: container-smoke must apply the ${description} exactly ${expectedCount} times, found ${count}`,
      );
    }
  }
  const hardeningIndex = containerSmokeBlock.indexOf(
    "Verify image and live-container hardening",
  );
  const identityIndex = containerSmokeBlock.indexOf(
    "Resolve retry-stable publication handoff identity",
  );
  const exportIndex = containerSmokeBlock.indexOf(
    "Export the exact tested app and server images",
  );
  const handoffIndex = containerSmokeBlock.indexOf(
    "Upload the exact tested container bundle",
  );
  if (
    hardeningIndex < 0 ||
    identityIndex <= hardeningIndex ||
    exportIndex <= identityIndex ||
    handoffIndex <= exportIndex
  ) {
    errors.push(
      `${file}: container-smoke must harden, bind producer identity, export, and upload the tested images in that order`,
    );
  }

  requireJob(errors, workflow, "load-drill", [
    ["github.event_name == 'schedule'", "scheduled condition"],
    ["inputs.profile == 'load'", "manual load condition"],
    [
      "SRN_DEPLOY_REVISION: ${{ github.sha }}",
      "exact runtime deployment revision",
    ],
    [
      "node scripts/resolve-deployment-identity.mjs",
      "clean checkout identity resolution",
    ],
    [
      "SRN_DEPLOY_REVISION=${{ github.sha }}",
      "exact image revision build argument",
    ],
    [
      "SRN_DEPLOY_VERSION=ci-${{ github.run_id }}.${{ github.run_attempt }}",
      "image version build argument",
    ],
    ['OPS_LOAD_NOTES: "250"', "heavy note count"],
    ['OPS_LOAD_CLIENTS: "4"', "parallel client count"],
    ['OPS_REDIS_OPS_PER_WORKER: "500"', "Redis operation count"],
    ["--min-expected 1 --max-skipped 0", "zero-skip load assertion"],
    ["if-no-files-found: error", "required load artifact"],
  ]);

  requireJob(errors, workflow, "exhaustive-e2e", [
    ["github.event_name == 'schedule'", "scheduled condition"],
    ["inputs.profile == 'exhaustive'", "manual exhaustive condition"],
    [
      "SRN_DEPLOY_REVISION: ${{ github.sha }}",
      "exact runtime deployment revision",
    ],
    [
      "node scripts/resolve-deployment-identity.mjs",
      "clean checkout identity resolution",
    ],
    [
      "SRN_DEPLOY_REVISION=${{ github.sha }}",
      "exact image revision build argument",
    ],
    [
      "SRN_DEPLOY_VERSION=ci-${{ github.run_id }}.${{ github.run_attempt }}",
      "image version build argument",
    ],
    [
      "playwright install --with-deps chromium firefox webkit",
      "three-browser install",
    ],
    [
      '--grep-invert "ops load and Redis throughput"',
      "non-duplicated full suite",
    ],
    ["--require-explicit-skips", "explicit skip audit"],
    ["if-no-files-found: error", "required exhaustive artifact"],
  ]);

  for (const jobName of ["container-smoke", "load-drill", "exhaustive-e2e"]) {
    const block = jobBlock(workflow, jobName);
    for (const [fragment, description] of [
      ["SRN_DEPLOY_REVISION=${{ github.sha }}", "revision build argument"],
      [
        "SRN_DEPLOY_VERSION=ci-${{ github.run_id }}.${{ github.run_attempt }}",
        "version build argument",
      ],
    ]) {
      const count = block.split(fragment).length - 1;
      if (count !== 2) {
        errors.push(
          `${file}: ${jobName} must pass the ${description} to both images, found ${count}`,
        );
      }
    }
  }

  requireJob(errors, workflow, "production-gate", [
    [
      "needs: [contracts, check, build, desktop-electron, container-smoke]",
      "required lane fan-in",
    ],
    ["if: always()", "fail-closed fan-in"],
    [
      "A required production lane finished with:",
      "failed dependency assertion",
    ],
  ]);

  requireJob(errors, workflow, "publish-containers", [
    [
      "needs: [container-smoke, production-gate]",
      "tested-image and production-gate fan-in",
    ],
    ["github.event_name == 'push'", "push-only publication guard"],
    ["github.ref == 'refs/heads/main'", "protected-main publication guard"],
    [
      "github.repository == 'supermarsx/standard-red-notes'",
      "first-party repository publication guard",
    ],
    [
      "needs.container-smoke.result == 'success'",
      "successful container acceptance guard",
    ],
    [
      "needs.production-gate.result == 'success'",
      "successful production gate guard",
    ],
    ["environment: release-production", "protected publication environment"],
    ["runs-on: ubuntu-latest", "GitHub-hosted publication runner"],
    ["actions: read", "artifact read permission"],
    ["artifact-metadata: write", "attestation metadata permission"],
    ["attestations: write", "attestation write permission"],
    ["contents: read", "read-only repository permission"],
    ["id-token: write", "keyless provenance permission"],
    ["packages: write", "GHCR publication permission"],
    [
      approvedWorkflowAction("downloadArtifact"),
      "pinned image handoff download",
    ],
    [approvedWorkflowAction("loginRegistry"), "pinned GHCR login"],
    [
      approvedWorkflowAction("attestBuildProvenance"),
      "pinned container provenance attestation",
    ],
    [
      "PUBLISH_ARTIFACT_ID: ${{ needs.container-smoke.outputs.publication_artifact_id }}",
      "producer artifact ID handoff",
    ],
    [
      "PUBLISH_ARTIFACT: ${{ needs.container-smoke.outputs.publication_artifact_name }}",
      "producer artifact name handoff",
    ],
    [
      "PUBLISH_ATTEMPT: ${{ needs.container-smoke.outputs.publication_attempt }}",
      "producer attempt handoff",
    ],
    [
      "PUBLISH_TAG: ${{ needs.container-smoke.outputs.publication_tag }}",
      "producer tag handoff",
    ],
    [
      "PUBLISH_VERSION: ${{ needs.container-smoke.outputs.publication_version }}",
      "producer version handoff",
    ],
    [
      "Validate retry-stable publication handoff identity",
      "pre-download retry identity validation",
    ],
    [
      "case \"$PUBLISH_ARTIFACT_ID\" in ''|*[!0-9]*) exit 1 ;; esac",
      "numeric nonempty artifact ID validation",
    ],
    [
      'test "$PUBLISH_ARTIFACT" = "container-publication-${GITHUB_RUN_ID}-${PUBLISH_ATTEMPT}"',
      "run-bound artifact name validation",
    ],
    [
      'test "$PUBLISH_TAG" = "sha-${GITHUB_SHA}-run-${GITHUB_RUN_ID}.${PUBLISH_ATTEMPT}"',
      "retry-stable tag validation",
    ],
    [
      'test "$PUBLISH_VERSION" = "ci-${GITHUB_RUN_ID}.${PUBLISH_ATTEMPT}"',
      "retry-stable version validation",
    ],
    [
      "artifact-ids: ${{ env.PUBLISH_ARTIFACT_ID }}",
      "immutable current-run artifact download",
    ],
    ["digest-mismatch: error", "fail-closed artifact transport digest"],
    ["sha256sum --check images.tar.sha256", "archive checksum verification"],
    ["docker load --input images.tar", "exact tested image load"],
    ["app-image-id.txt", "app image identity verification"],
    ["server-image-id.txt", "server image identity verification"],
    ["org.opencontainers.image.revision", "OCI revision verification"],
    ["org.opencontainers.image.version", "OCI version verification"],
    ["org.opencontainers.image.source", "OCI source verification"],
    [
      "GHCR_APP_IMAGE: ghcr.io/supermarsx/standard-red-notes-app",
      "fork-owned app image",
    ],
    [
      "GHCR_SERVER_IMAGE: ghcr.io/supermarsx/standard-red-notes-server",
      "fork-owned server image",
    ],
    ["{{.Os}}/{{.Architecture}}", "published image platform verification"],
    ["password: ${{ secrets.GITHUB_TOKEN }}", "built-in registry credential"],
    ['docker push "$GHCR_APP_IMAGE:$PUBLISH_TAG"', "app image push"],
    ['docker push "$GHCR_SERVER_IMAGE:$PUBLISH_TAG"', "server image push"],
    ["RepoDigests", "remote registry digest verification"],
    ["push-to-registry: true", "registry provenance publication"],
    ["gh attestation verify", "published provenance verification"],
    ["--bundle-from-oci", "OCI registry attestation retrieval"],
    ["--deny-self-hosted-runners", "GitHub-hosted attestation enforcement"],
    ['--repo "$GITHUB_REPOSITORY"', "attestation repository identity"],
    [
      '--source-digest "$PUBLISH_REVISION"',
      "attestation source digest identity",
    ],
    ["--source-ref refs/heads/main", "attestation source ref identity"],
    [
      '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/ci.yml"',
      "attestation signer workflow identity",
    ],
    ["docker logout ghcr.io", "registry logout"],
  ]);

  const publisherBlock = jobBlock(workflow, "publish-containers");
  const activePublisherBlock = publisherBlock.replace(/^\s*#.*$/gm, "");
  if (activePublisherBlock.includes("actions/checkout")) {
    errors.push(
      `${file}: publish-containers must not check out or execute repository code with registry permissions`,
    );
  }
  if (/^\s*runs-on:.*self-hosted.*$/m.test(activePublisherBlock)) {
    errors.push(
      `${file}: publish-containers must not use a self-hosted runner`,
    );
  }
  const githubHostedRunnerCount = [
    ...activePublisherBlock.matchAll(/^    runs-on:\s*ubuntu-latest\s*$/gm),
  ].length;
  if (githubHostedRunnerCount !== 1) {
    errors.push(
      `${file}: publish-containers must contain exactly 1 active GitHub-hosted runner declaration, found ${githubHostedRunnerCount}`,
    );
  }
  if (activePublisherBlock.includes("${{ github.run_attempt }}")) {
    errors.push(
      `${file}: publish-containers must reuse producer identity instead of the current retry attempt`,
    );
  }
  for (const forbiddenInput of [
    "name",
    "github-token",
    "repository",
    "run-id",
    "pattern",
  ]) {
    if (
      new RegExp(`^ {10}${forbiddenInput}:`, "m").test(activePublisherBlock)
    ) {
      errors.push(
        `${file}: publish-containers download must remain bound to the producer artifact ID in the current run; forbidden input ${forbiddenInput}`,
      );
    }
  }
  for (const [fragment, expectedCount, description] of [
    ["docker push ", 2, "coordinated image push"],
    [approvedWorkflowAction("attestBuildProvenance"), 2, "image attestation"],
    ["push-to-registry: true", 2, "registry attestation push"],
  ]) {
    const count = activePublisherBlock.split(fragment).length - 1;
    if (count !== expectedCount) {
      errors.push(
        `${file}: publish-containers must contain exactly ${expectedCount} ${description} occurrence(s), found ${count}`,
      );
    }
  }
  const packageWriteCount = [
    ...activePublisherBlock.matchAll(/^      packages:\s*write\s*$/gm),
  ].length;
  if (packageWriteCount !== 1) {
    errors.push(
      `${file}: publish-containers must contain exactly 1 active package write permission, found ${packageWriteCount}`,
    );
  }
  const publishedPlatformChecks =
    activePublisherBlock.split("{{.Os}}/{{.Architecture}}").length - 1;
  if (publishedPlatformChecks !== 2) {
    errors.push(
      `${file}: publish-containers must prove loaded and re-pulled image platforms, found ${publishedPlatformChecks} checks`,
    );
  }
  for (const label of [
    "org.opencontainers.image.revision",
    "org.opencontainers.image.version",
    "org.opencontainers.image.source",
  ]) {
    const template = `--format '{{ index .Config.Labels "${label}" }}'`;
    const count = activePublisherBlock.split(template).length - 1;
    if (count !== 2) {
      errors.push(
        `${file}: publish-containers must use a shell-safe Docker label template for ${label} before and after publication, found ${count}`,
      );
    }
  }
  for (const forbidden of [
    "pull_request_target",
    "secrets.PAT",
    "secrets.GHCR_TOKEN",
    ":latest",
    ":main",
    "push: true",
  ]) {
    if (activePublisherBlock.includes(forbidden)) {
      errors.push(
        `${file}: publish-containers contains forbidden mutable or privileged fragment ${forbidden}`,
      );
    }
  }
  const publisherOrder = [
    "Validate retry-stable publication handoff identity",
    "Download the exact tested container bundle",
    "Verify and load the exact tested images",
    "Log in to GitHub Container Registry",
    "Push the coordinated retry-stable image pair",
    "Verify registry digests and image identity",
    "Attest app image provenance",
    "Attest server image provenance",
    "Verify published image attestations",
    "Record digest-pinned deployment references",
  ].map((fragment) => publisherBlock.indexOf(fragment));
  if (
    publisherOrder.some((index) => index < 0) ||
    publisherOrder.some(
      (index, position) =>
        position > 0 && index <= publisherOrder[position - 1],
    )
  ) {
    errors.push(
      `${file}: publish-containers must validate producer identity before download, verify before login, then push, re-pull, attest, verify, and record digests in order`,
    );
  }

  for (const [stepName, expectedSubject, expectedDigest] of [
    [
      "Attest app image provenance",
      "${{ env.GHCR_APP_IMAGE }}",
      "${{ steps.verify_registry.outputs.app-digest }}",
    ],
    [
      "Attest server image provenance",
      "${{ env.GHCR_SERVER_IMAGE }}",
      "${{ steps.verify_registry.outputs.server-digest }}",
    ],
  ]) {
    const step = namedStepBlock(activePublisherBlock, stepName);
    for (const [fragment, description] of [
      [approvedWorkflowAction("attestBuildProvenance"), "pinned action"],
      [`subject-name: ${expectedSubject}`, "exact image subject"],
      [`subject-digest: ${expectedDigest}`, "exact registry digest"],
      ["push-to-registry: true", "OCI registry publication"],
    ]) {
      requireFragment(
        errors,
        file,
        step,
        fragment,
        `publish-containers ${stepName} ${description}`,
      );
    }
  }

  const downloadStep = namedStepBlock(
    activePublisherBlock,
    "Download the exact tested container bundle",
  );
  for (const [fragment, description] of [
    [approvedWorkflowAction("downloadArtifact"), "pinned download action"],
    [
      "artifact-ids: ${{ env.PUBLISH_ARTIFACT_ID }}",
      "producer artifact ID input",
    ],
    ["digest-mismatch: error", "fail-closed transport digest"],
    ["path: container-publication", "isolated extraction path"],
  ]) {
    requireFragment(
      errors,
      file,
      downloadStep,
      fragment,
      `publish-containers download ${description}`,
    );
  }

  const verificationStep = namedStepBlock(
    activePublisherBlock,
    "Verify published image attestations",
  );
  for (const [fragment, description] of [
    ["oci://${GHCR_APP_IMAGE}@${APP_DIGEST}", "app digest subject"],
    ["oci://${GHCR_SERVER_IMAGE}@${SERVER_DIGEST}", "server digest subject"],
    ["--bundle-from-oci", "OCI bundle source"],
    ["--deny-self-hosted-runners", "hosted-runner identity"],
    ['--repo "$GITHUB_REPOSITORY"', "repository identity"],
    ['--source-digest "$PUBLISH_REVISION"', "source digest identity"],
    ["--source-ref refs/heads/main", "protected source ref"],
    [
      '--signer-workflow "$GITHUB_REPOSITORY/.github/workflows/ci.yml"',
      "signer workflow identity",
    ],
  ]) {
    requireFragment(
      errors,
      file,
      verificationStep,
      fragment,
      `publish-containers attestation verification ${description}`,
    );
  }

  const rootPackage = JSON.parse(files.get("package.json") ?? "{}");
  const expectedScripts = {
    "ci:contracts":
      "yarn release:policy:install && yarn test:ci-tools && node scripts/validate-ci-contract.mjs && yarn test:release-impact:run && yarn test:release-contract:run && yarn release:contract:run && yarn docs:check",
    "ci:docker-hardening": "node scripts/validate-docker-hardening.mjs",
    "ci:verify-playwright": "node scripts/verify-playwright-report.mjs",
    "deps:security:production":
      "node scripts/audit-production-dependencies.mjs",
    "release:contract:run": "node scripts/validate-release-contract.mjs",
    "release:policy:install":
      "npm ci --prefix scripts --ignore-scripts --no-audit --no-fund",
    "test:ci-tools":
      "node --test scripts/audit-production-dependencies.test.mjs scripts/validate-ci-contract.test.mjs scripts/validate-docker-hardening.test.mjs scripts/verify-playwright-report.test.mjs",
    "test:release-contract:run":
      "node --test scripts/validate-release-contract.test.mjs",
    "test:release-impact:run":
      "node --test scripts/analyze-release-impact.test.mjs scripts/fingerprint-release-tree.test.mjs scripts/release-packaging-contract.test.mjs scripts/compare-release-fingerprints.test.mjs",
  };
  for (const [name, command] of Object.entries(expectedScripts)) {
    if (rootPackage.scripts?.[name] !== command) {
      errors.push(
        `package.json: ${name} script is not wired to the CI contract`,
      );
    }
  }

  const serverPackage = JSON.parse(files.get("server/package.json") ?? "{}");
  const appNodeVersion = exactNodeVersion(files.get("app/.nvmrc"));
  const serverNodeVersion = exactNodeVersion(files.get("server/.nvmrc"));
  const serverNodeEngine = minimumNodeEngine(serverPackage.engines?.node);
  const ciNodeMajor = /^\s*NODE_VERSION:\s*["']?(\d+)["']?\s*$/m.exec(
    workflow,
  )?.[1];

  if (!appNodeVersion) {
    errors.push("app/.nvmrc: must contain an exact Node version");
  }
  if (!serverNodeVersion) {
    errors.push("server/.nvmrc: must contain an exact Node version");
  }
  if (
    appNodeVersion &&
    serverNodeVersion &&
    appNodeVersion.raw !== serverNodeVersion.raw
  ) {
    errors.push(
      `server/.nvmrc: Node ${serverNodeVersion.raw} must match app/.nvmrc Node ${appNodeVersion.raw}`,
    );
  }
  if (!ciNodeMajor) {
    errors.push(".github/workflows/ci.yml: missing active NODE_VERSION policy");
  } else if (
    serverNodeVersion &&
    Number(ciNodeMajor) !== serverNodeVersion.major
  ) {
    errors.push(
      `.github/workflows/ci.yml: NODE_VERSION ${ciNodeMajor} must match server/.nvmrc major ${serverNodeVersion.major}`,
    );
  }
  if (
    !serverNodeVersion ||
    !serverNodeEngine ||
    serverNodeEngine.major !== serverNodeVersion.major ||
    !versionAtLeast(serverNodeVersion, serverNodeEngine)
  ) {
    errors.push(
      "server/package.json: engines.node must accept and share the major of server/.nvmrc",
    );
  }

  if (serverNodeVersion) {
    const dockerfile = files.get("server/Dockerfile") ?? "";
    const expectedImage = `node:${serverNodeVersion.raw}-alpine`;
    for (const stage of ["build", "runtime"]) {
      if (!dockerfile.includes(`FROM ${expectedImage} AS ${stage}`)) {
        errors.push(
          `server/Dockerfile: ${stage} stage must use ${expectedImage}`,
        );
      }
    }
  }

  const expectedServerFormatScripts = {
    format:
      'prettier --write "packages/*/src/**/*.{ts,tsx,js,json,md}" "packages/*/bin/**/*.{ts,tsx}"',
    "format:check":
      'prettier --check "packages/*/src/**/*.{ts,tsx,js,json,md}" "packages/*/bin/**/*.{ts,tsx}"',
  };
  for (const [name, command] of Object.entries(expectedServerFormatScripts)) {
    if (serverPackage.scripts?.[name] !== command) {
      errors.push(
        `server/package.json: ${name} script must format package src and executable bin TypeScript sources`,
      );
    }
  }

  const documentation = files.get("docs/ci-production-gates.md") ?? "";
  for (const [fragment, description] of [
    ["# CI Production Gates", "CI documentation title"],
    ["`production-gate`", "required status-check documentation"],
    ["`required`", "required profile documentation"],
    ["`load`", "load profile documentation"],
    ["`exhaustive`", "exhaustive profile documentation"],
    ["never publish containers", "non-main publication boundary"],
    ["`publish-containers`", "protected container publisher"],
    [
      "ghcr.io/supermarsx/standard-red-notes-app",
      "published app image coordinate",
    ],
    [
      "ghcr.io/supermarsx/standard-red-notes-server",
      "published server image coordinate",
    ],
    ["linux/amd64", "tested container architecture scope"],
    ["no `latest` or `main` tag", "immutable container tag policy"],
    ["yarn ci:contracts", "local contract command"],
    ["yarn deps:security:production", "dependency audit command"],
    [
      "production-audit-allowlist.json",
      "expiring dependency advisory exception policy",
    ],
  ]) {
    requireFragment(
      errors,
      "docs/ci-production-gates.md",
      documentation,
      fragment,
      description,
    );
  }

  const navigation = files.get("docs/_data/navigation.yml") ?? "";
  requireFragment(
    errors,
    "docs/_data/navigation.yml",
    navigation,
    "/ci-production-gates.html",
    "CI documentation link",
  );

  return errors;
}

export function runCiContractValidation(
  repositoryRoot = defaultRepositoryRoot,
) {
  const errors = validateCiContract(loadCiContractFiles(repositoryRoot));
  if (errors.length > 0) {
    throw new Error(`CI contract validation failed:\n- ${errors.join("\n- ")}`);
  }

  return { requiredJobs: 6, extendedJobs: 2, protectedPublishers: 1 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const result = runCiContractValidation();
    console.log(
      `CI contract valid: ${result.requiredJobs} required jobs, ${result.extendedJobs} scheduled/manual jobs, and ${result.protectedPublishers} protected main-only publisher.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
