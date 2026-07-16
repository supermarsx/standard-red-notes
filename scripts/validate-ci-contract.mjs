#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepositoryRoot = path.resolve(path.dirname(scriptPath), "..");

export const CI_CONTRACT_FILES = Object.freeze([
  ".github/workflows/ci.yml",
  "package.json",
  "docs/ci-production-gates.md",
  "docs/_data/navigation.yml",
]);

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

export function validateCiContract(files) {
  const errors = [];
  const file = ".github/workflows/ci.yml";
  const workflow = files.get(file) ?? "";

  for (const [fragment, description] of [
    ["name: CI", "stable workflow name"],
    ["\n  push:\n    branches: [main]", "push trigger"],
    ["\n  pull_request:\n    branches: [main]", "pull-request trigger"],
    ["schedule:", "scheduled trigger"],
    ["workflow_dispatch:", "manual trigger"],
    ["profile:", "manual validation profile"],
    ["\npermissions:\n  contents: read", "read-only contents permission"],
    ["cancel-in-progress: true", "superseded-run cancellation"],
  ]) {
    requireFragment(errors, file, workflow, fragment, description);
  }

  for (const [pattern, description] of [
    [/continue-on-error\s*:/, "continue-on-error"],
    [/\|\|\s*true/, "silent shell success fallback"],
    [/contents:\s*write/, "contents write permission"],
    [/packages:\s*write/, "packages write permission"],
    [/id-token:\s*write/, "id-token write permission"],
    [/\b(?:npm|pnpm)\s+publish\b/, "package publishing command"],
    [/\byarn\s+npm\s+publish\b/, "Yarn publishing command"],
    [/\bgh\s+release\s+create\b/, "GitHub release command"],
    [/\bdocker\s+push\b/, "Docker push command"],
    [/push:\s*true/, "image push setting"],
  ]) {
    if (pattern.test(workflow)) {
      errors.push(`${file}: forbidden ${description}`);
    }
  }

  requireJob(errors, workflow, "contracts", [
    ["yarn install --immutable", "immutable root install"],
    ["yarn ci:contracts", "CI contract command"],
    ["rhysd/actionlint@sha256:", "pinned actionlint image"],
  ]);

  for (const [job, command] of [
    ["check", "yarn check"],
    ["build", "yarn build"],
  ]) {
    requireJob(errors, workflow, job, [
      ["run: yarn install --immutable", "immutable root install"],
      ["working-directory: app", "app workspace install"],
      ["working-directory: server", "server workspace install"],
      ["actions/cache@v6.1.0", "dependency cache"],
      [command, `${command} command`],
    ]);
    const block = jobBlock(workflow, job);
    const immutableInstalls =
      block.split("run: yarn install --immutable").length - 1;
    if (block && immutableInstalls !== 3) {
      errors.push(
        `${file}: ${job} must perform exactly three immutable workspace installs, found ${immutableInstalls}`,
      );
    }
  }

  requireJob(errors, workflow, "container-smoke", [
    ["hadolint/hadolint@sha256:", "pinned hadolint image"],
    ["docker/build-push-action@v7.3.0", "BuildKit image builds"],
    ["push: false", "non-publishing image builds"],
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
    [
      "docker compose down --volumes --remove-orphans",
      "isolated volume cleanup",
    ],
    ["if-no-files-found: error", "required diagnostics artifact"],
  ]);

  requireJob(errors, workflow, "load-drill", [
    ["github.event_name == 'schedule'", "scheduled condition"],
    ["inputs.profile == 'load'", "manual load condition"],
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

  requireJob(errors, workflow, "production-gate", [
    [
      "needs: [contracts, check, build, container-smoke]",
      "required lane fan-in",
    ],
    ["if: always()", "fail-closed fan-in"],
    [
      "A required production lane finished with:",
      "failed dependency assertion",
    ],
  ]);

  const rootPackage = JSON.parse(files.get("package.json") ?? "{}");
  const expectedScripts = {
    "ci:contracts":
      "yarn test:ci-tools && node scripts/validate-ci-contract.mjs && yarn test:release-contract && yarn release:contract && node scripts/export-app-docs-to-pages.mjs --check",
    "ci:docker-hardening": "node scripts/validate-docker-hardening.mjs",
    "ci:verify-playwright": "node scripts/verify-playwright-report.mjs",
    "test:ci-tools":
      "node --test scripts/validate-ci-contract.test.mjs scripts/validate-docker-hardening.test.mjs scripts/verify-playwright-report.test.mjs",
  };
  for (const [name, command] of Object.entries(expectedScripts)) {
    if (rootPackage.scripts?.[name] !== command) {
      errors.push(
        `package.json: ${name} script is not wired to the CI contract`,
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
    ["does not publish", "non-publishing guarantee"],
    ["yarn ci:contracts", "local contract command"],
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

  return { requiredJobs: 5, extendedJobs: 2 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const result = runCiContractValidation();
    console.log(
      `CI contract valid: ${result.requiredJobs} required jobs and ${result.extendedJobs} scheduled/manual jobs; publishing disabled.`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
