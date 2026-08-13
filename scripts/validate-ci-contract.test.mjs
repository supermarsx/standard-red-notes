import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  approvedWorkflowAction,
  loadCiContractFiles,
  validateCiContract,
  validateSetupOverwriteContract,
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

function withCiJobChanged(jobName, update) {
  return withFileChanged(".github/workflows/ci.yml", (content) => {
    const marker = `\n  ${jobName}:`;
    const start = content.indexOf(marker);
    assert.notEqual(start, -1, `ci.yml must contain ${jobName}`);
    const remainder = content.slice(start + marker.length);
    const nextJob = remainder.search(/\r?\n  [A-Za-z0-9_-]+:\r?\n/);
    const end = nextJob < 0 ? content.length : start + marker.length + nextJob;
    return `${content.slice(0, start)}${update(content.slice(start, end))}${content.slice(end)}`;
  });
}

function replaceRequired(source, current, replacement = "") {
  const changed = source.replace(current, replacement);
  assert.notEqual(changed, source, `test mutation must replace: ${current}`);
  return changed;
}

function replaceAllRequired(source, current, replacement = "") {
  const changed = source.replaceAll(current, replacement);
  assert.notEqual(changed, source, `test mutation must replace: ${current}`);
  return changed;
}

function createSetupFixture({
  environment,
  probeExit = 0,
  initializeGit = true,
} = {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), "srn-setup-safety-"));
  const fixtureRoot = path.join(temporary, "repo");
  const fixtureScripts = path.join(fixtureRoot, "scripts");
  const fixtureBin = path.join(temporary, "bin");
  const environmentFile = path.join(fixtureRoot, ".env");
  const deploymentCapture = path.join(temporary, "deployment-capture.txt");
  mkdirSync(fixtureScripts, { recursive: true });
  mkdirSync(fixtureBin, { recursive: true });
  if (environment !== undefined) {
    writeFileSync(environmentFile, environment);
  }

  let command;
  let setup;
  if (process.platform === "win32") {
    setup = path.join(fixtureScripts, "setup.ps1");
    copyFileSync(path.join(repositoryRoot, "scripts", "setup.ps1"), setup);
    writeFileSync(
      path.join(fixtureBin, "docker.cmd"),
      [
        "@echo off",
        'if "%1"=="compose" if "%2"=="run" exit /b %FAKE_ASSISTANT_PROBE_EXIT%',
        'if "%1"=="compose" if "%2"=="up" echo %SRN_DEPLOY_REVISION%^|%SRN_DEPLOY_VERSION%>"%FAKE_DEPLOY_CAPTURE%"',
        "exit /b 0",
        "",
      ].join("\r\n"),
    );
    command = "powershell.exe";
  } else {
    setup = path.join(fixtureScripts, "setup.sh");
    const docker = path.join(fixtureBin, "docker");
    copyFileSync(path.join(repositoryRoot, "scripts", "setup.sh"), setup);
    writeFileSync(
      docker,
      '#!/bin/sh\nif [ "$1" = "compose" ] && [ "$2" = "run" ]; then exit "${FAKE_ASSISTANT_PROBE_EXIT}"; fi\nif [ "$1" = "compose" ] && [ "$2" = "up" ]; then printf "%s|%s\\n" "$SRN_DEPLOY_REVISION" "$SRN_DEPLOY_VERSION" > "$FAKE_DEPLOY_CAPTURE"; fi\nexit 0\n',
    );
    chmodSync(docker, 0o755);
    command = "bash";
  }

  if (initializeGit) {
    writeFileSync(path.join(fixtureRoot, ".gitignore"), ".env*\n");
    execFileSync("git", ["init", "--quiet"], { cwd: fixtureRoot });
    execFileSync("git", ["config", "user.name", "CI Test"], {
      cwd: fixtureRoot,
    });
    execFileSync("git", ["config", "user.email", "ci@example.invalid"], {
      cwd: fixtureRoot,
    });
    execFileSync("git", ["add", "."], { cwd: fixtureRoot });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], {
      cwd: fixtureRoot,
    });
  }

  const run = (scriptArguments) =>
    spawnSync(
      command,
      process.platform === "win32"
        ? ["-NoProfile", "-File", setup, ...scriptArguments]
        : [setup, ...scriptArguments],
      {
        cwd: fixtureRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_ASSISTANT_PROBE_EXIT: String(probeExit),
          FAKE_DEPLOY_CAPTURE: deploymentCapture,
          PATH: `${fixtureBin}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );

  return { deploymentCapture, environmentFile, fixtureRoot, run, temporary };
}

test("the repository satisfies the CI production-gate contract", () => {
  assert.deepEqual(validateCiContract(baseline), []);
});

test("normal setup reruns reuse rather than replace production credentials", () => {
  const shell = baseline.get("scripts/setup.sh");
  const powershell = baseline.get("scripts/setup.ps1");
  assert.deepEqual(validateSetupOverwriteContract(shell, powershell), []);

  assert.match(
    validateSetupOverwriteContract(
      shell.replace(
        'if [ "$FORCE_OVERWRITE" -ne 1 ]; then',
        'if [ "$FORCE_OVERWRITE" -eq 1 ]; then',
      ),
      powershell,
    ).join("\n"),
    /scripts\/setup\.sh: missing normal-rerun existing-config guard/,
  );

  assert.match(
    validateSetupOverwriteContract(
      shell,
      powershell.replace("if (-not $ForceOverwrite)", "if ($ForceOverwrite)"),
    ).join("\n"),
    /scripts\/setup\.ps1: missing normal-rerun existing-config guard/,
  );
});

test("normal setup rerun validates and leaves an existing environment byte-for-byte intact", () => {
  const sentinel = `EXISTING_PRODUCTION_CONFIGURATION=true\nASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${"a".repeat(64)}\n`;
  const fixture = createSetupFixture({ environment: sentinel });

  try {
    const result = fixture.run(
      process.platform === "win32" ? ["-Yes"] : ["--yes"],
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /normal setup reruns never rotate existing secrets/i,
    );
    assert.equal(readFileSync(fixture.environmentFile, "utf8"), sentinel);
    assert.deepEqual(
      readdirSync(fixture.fixtureRoot).filter((entry) =>
        entry.startsWith(".env.bak."),
      ),
      [],
    );
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("setup stamps a clean checkout with its exact commit before Compose build", () => {
  const sentinel = `EXISTING_PRODUCTION_CONFIGURATION=true\nASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${"a".repeat(64)}\n`;
  const fixture = createSetupFixture({
    environment: sentinel,
    initializeGit: true,
  });
  try {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.fixtureRoot,
      encoding: "utf8",
    }).trim();
    const result = fixture.run(
      process.platform === "win32" ? ["-Yes", "-Up"] : ["--yes", "--up"],
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(
      readFileSync(fixture.deploymentCapture, "utf8").trim(),
      `${revision}|setup-${revision.slice(0, 12)}`,
    );
    assert.equal(readFileSync(fixture.environmentFile, "utf8"), sentinel);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("setup refuses a dirty checkout before Compose build without changing the environment", () => {
  const sentinel = `EXISTING_PRODUCTION_CONFIGURATION=true\nASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${"b".repeat(64)}\n`;
  const fixture = createSetupFixture({
    environment: sentinel,
    initializeGit: true,
  });
  try {
    writeFileSync(
      path.join(fixture.fixtureRoot, "dirty-source.txt"),
      "uncommitted\n",
    );
    const result = fixture.run(
      process.platform === "win32" ? ["-Yes", "-Up"] : ["--yes", "--up"],
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /dirty checkout/i);
    assert.equal(existsSync(fixture.deploymentCapture), false);
    assert.equal(readFileSync(fixture.environmentFile, "utf8"), sentinel);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("fresh setup generates exactly one persistent 32-byte assistant pairing key", () => {
  const fixture = createSetupFixture();
  try {
    const result = fixture.run(
      process.platform === "win32" ? ["-Yes"] : ["--yes"],
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const environment = readFileSync(fixture.environmentFile, "utf8");
    const assignments =
      environment.match(
        /^ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=([0-9a-f]{64})$/gm,
      ) ?? [];
    assert.equal(assignments.length, 1);
    assert.match(environment, /^ENFORCE_HTTPS_FROM_PROXY=false$/m);
    assert.match(environment, /^APP_BIND_ADDRESS=0\.0\.0\.0$/m);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("setup rejects a malformed configured assistant pairing key without changing the environment", () => {
  const sentinel = "ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=too-short\n";
  const fixture = createSetupFixture({ environment: sentinel });
  try {
    const result = fixture.run(
      process.platform === "win32" ? ["-Yes"] : ["--yes"],
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /exactly 64 hexadecimal characters/i,
    );
    assert.equal(readFileSync(fixture.environmentFile, "utf8"), sentinel);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("setup rejects duplicate assistant pairing key assignments as ambiguous", () => {
  const sentinel = `ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${"a".repeat(64)}\nASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${"b".repeat(64)}\n`;
  const fixture = createSetupFixture({ environment: sentinel });
  try {
    const result = fixture.run(
      process.platform === "win32" ? ["-Yes"] : ["--yes"],
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /assigned more than once/i,
    );
    assert.equal(readFileSync(fixture.environmentFile, "utf8"), sentinel);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("intentional full overwrite preserves the existing assistant pairing key", () => {
  const key = "c".repeat(64);
  const fixture = createSetupFixture({
    environment: `EXISTING_PRODUCTION_CONFIGURATION=true\nASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${key}\n`,
  });
  try {
    const result = fixture.run(
      process.platform === "win32"
        ? ["-Yes", "-ForceOverwrite"]
        : ["--yes", "--force-overwrite"],
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      readFileSync(fixture.environmentFile, "utf8"),
      new RegExp(`^ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=${key}$`, "m"),
    );
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("ordinary setup rerun safely adds one missing key, backs up the keyless environment, and then preserves it", () => {
  const sentinel = "EXISTING_PRODUCTION_CONFIGURATION=true\n";
  const fixture = createSetupFixture({ environment: sentinel });
  try {
    const migration = fixture.run(
      process.platform === "win32" ? ["-Yes"] : ["--yes"],
    );
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);
    const migrated = readFileSync(fixture.environmentFile, "utf8");
    assert.match(
      migrated,
      /^ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY=[0-9a-f]{64}$/m,
    );
    const backups = readdirSync(fixture.fixtureRoot).filter((entry) =>
      entry.startsWith(".env.bak."),
    );
    assert.equal(backups.length, 1);
    assert.equal(
      readFileSync(path.join(fixture.fixtureRoot, backups[0]), "utf8"),
      sentinel,
    );

    const rerun = fixture.run(
      process.platform === "win32" ? ["-Yes"] : ["--yes"],
    );
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    assert.equal(readFileSync(fixture.environmentFile, "utf8"), migrated);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("ordinary setup rerun refuses to generate over possible encrypted pairing data", () => {
  const sentinel = "EXISTING_PRODUCTION_CONFIGURATION=true\n";
  const fixture = createSetupFixture({ environment: sentinel, probeExit: 43 });
  try {
    const result = fixture.run(
      process.platform === "win32" ? ["-Yes"] : ["--yes"],
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /pairing file already exists/i,
    );
    assert.equal(readFileSync(fixture.environmentFile, "utf8"), sentinel);
    assert.deepEqual(
      readdirSync(fixture.fixtureRoot).filter((entry) =>
        entry.startsWith(".env.bak."),
      ),
      [],
    );
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test("CI and Pages actions require approved full SHAs and exact version labels", () => {
  for (const [file, actionName] of [
    [".github/workflows/ci.yml", "checkout"],
    [".github/workflows/docs-pages.yml", "checkout"],
  ]) {
    const approved = approvedWorkflowAction(actionName);
    const [immutableUse, version] = approved.split(" # ");
    const action = immutableUse.slice(0, immutableUse.lastIndexOf("@"));

    const mutable = withFileChanged(file, (content) =>
      content.replace(approved, `${action}@${version} # ${version}`),
    );
    assert.match(
      validateCiContract(mutable).join("\n"),
      new RegExp(
        `mutable external action reference ${action.replace("/", "\\/")}@`,
      ),
    );

    const unapproved = withFileChanged(file, (content) =>
      content.replace(approved, `${action}@${"1".repeat(40)} # ${version}`),
    );
    assert.match(
      validateCiContract(unapproved).join("\n"),
      new RegExp(
        `unapproved external action reference ${action.replace("/", "\\/")}@`,
      ),
    );

    const mislabeled = withFileChanged(file, (content) =>
      content.replace(approved, `${immutableUse} # v0.0.0`),
    );
    assert.match(
      validateCiContract(mislabeled).join("\n"),
      /incorrect human version label/,
    );

    const rogue = withFileChanged(file, (content) =>
      content.replace(
        "jobs:\n",
        `jobs:\n  rogue-action:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: evil/example@${"2".repeat(40)} # v1.0.0\n`,
      ),
    );
    assert.match(
      validateCiContract(rogue).join("\n"),
      /unapproved external action reference evil\/example@/,
    );
  }
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

test("the contracts lane cannot drop the production dependency audit", () => {
  const files = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace(
      "run: yarn deps:security:production",
      "run: echo dependency-audit-disabled",
    ),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /contracts production dependency audit/,
  );
});

test("the MCP publisher rejects unlocked dependency resolution", () => {
  const files = withFileChanged(".github/workflows/srn-mcp.yml", (content) =>
    content.replace(
      "run: yarn install --immutable",
      "run: npm install --no-package-lock --no-audit --no-fund",
    ),
  );
  const errors = validateCiContract(files).join("\n");
  assert.match(errors, /srn-mcp\.yml: forbidden unlocked npm install/);
  assert.match(errors, /srn-mcp\.yml: forbidden non-Corepack npm install/);
  assert.match(errors, /missing audit immutable root install/);
});

test("the MCP publisher cannot omit immutable installation or production audit", () => {
  let files = withFileChanged(".github/workflows/srn-mcp.yml", (content) =>
    content.replace("run: yarn install --immutable", "run: yarn install"),
  );
  let errors = validateCiContract(files).join("\n");
  assert.match(errors, /srn-mcp\.yml: forbidden non-immutable Yarn install/);
  assert.match(errors, /missing audit immutable root install/);

  files = withFileChanged(".github/workflows/srn-mcp.yml", (content) =>
    content.replace(
      "run: yarn deps:security:production",
      "run: echo production-audit-disabled",
    ),
  );
  errors = validateCiContract(files).join("\n");
  assert.match(errors, /missing audit production dependency audit/);
  assert.match(errors, /production dependency audit must run exactly once/);
});

test("the MCP release fingerprint cannot omit the root lock graph", () => {
  const files = withFileChanged(".github/workflows/srn-mcp.yml", (content) =>
    content.replace("            --path yarn.lock \\\n", ""),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /missing build root lock fingerprint input/,
  );
});

test("MCP packaging and publication depend directly on the exact-SHA audit", () => {
  let files = withFileChanged(".github/workflows/srn-mcp.yml", (content) =>
    content.replace(
      "needs: [audit, build, decide, identity]",
      "needs: [build, decide, identity]",
    ),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /missing package direct audited package fan-in/,
  );

  files = withFileChanged(".github/workflows/srn-mcp.yml", (content) =>
    content
      .replace(
        "needs: [impact, audit, build, decide, identity, package, smoke]",
        "needs: [impact, build, decide, identity, package, smoke]",
      )
      .replace(" && needs.audit.result == 'success'", ""),
  );
  const errors = validateCiContract(files).join("\n");
  assert.match(errors, /missing release direct audited publication fan-in/);
  assert.match(errors, /missing release successful audit publication gate/);
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

test("container CI cannot drop exact immutable deployment acceptance", () => {
  for (const [current, replacement, expected] of [
    [
      "node scripts/resolve-deployment-identity.mjs",
      "node scripts/identity-disabled.mjs",
      /container-smoke clean checkout identity resolution/,
    ],
    [
      "SRN_DEPLOY_REVISION=${{ github.sha }}",
      "SRN_DEPLOY_REVISION=unknown",
      /container-smoke must pass the revision build argument to both images, found 1/,
    ],
    [
      "org.opencontainers.image.revision",
      "org.opencontainers.image.disabled",
      /container-smoke live OCI revision assertion/,
    ],
    [
      "cmp artifacts-app-deployment.json artifacts-server-deployment.json",
      "echo marker-compare-disabled",
      /container-smoke byte-equal app\/server marker assertion/,
    ],
    [
      "node scripts/verify-deployment-identity.mjs",
      "node scripts/identity-disabled.mjs",
      /container-smoke same-origin app\/server deployment acceptance/,
    ],
  ]) {
    const files = withFileChanged(".github/workflows/ci.yml", (content) =>
      content.replace(current, replacement),
    );
    assert.match(validateCiContract(files).join("\n"), expected);
  }
});

test("all setup start paths must resolve and verify immutable deployment identity", () => {
  const shell = baseline.get("scripts/setup.sh");
  const powershell = baseline
    .get("scripts/setup.ps1")
    .replace(/\r?\n/g, "\r\n");
  assert.match(
    validateSetupOverwriteContract(
      replaceRequired(shell, "      resolve_clean_deployment_revision"),
      powershell,
    ).join("\n"),
    /every one of the three build\/start paths must resolve and verify deployment identity/,
  );
  assert.match(
    validateSetupOverwriteContract(
      shell,
      replaceRequired(
        powershell,
        "      try { Assert-StartedDeploymentIdentity -Revision $deploymentRevision } catch { Write-Err $_.Exception.Message; exit 1 }",
      ),
    ).join("\n"),
    /every one of the three build\/start paths must resolve and verify deployment identity/,
  );
});

test("the required stack cannot skip encrypted two-editor convergence", () => {
  const files = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace("-e REQUIRE_GATEWAY=1", "-e REQUIRE_GATEWAY=0"),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /container-smoke required realtime gateway mode/,
  );
});

test("the required stack cannot skip durable email queue and delivery integration", () => {
  for (const [command, replacement, expected] of [
    [
      "yarn test:email-redis:compose",
      "echo disabled-email-redis-integration",
      /container-smoke required durable email queue integration/,
    ],
    [
      "yarn test:email-delivery:compose",
      "echo disabled-email-delivery-integration",
      /container-smoke required queued SMTP delivery integration/,
    ],
  ]) {
    const files = withFileChanged(".github/workflows/ci.yml", (content) =>
      content.replace(command, replacement),
    );
    assert.match(validateCiContract(files).join("\n"), expected);
  }
});

test("the disposable stack preserves server runtime logs on failure", () => {
  const files = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace(
      "docker compose cp server:/var/lib/server/logs/. artifacts/server-logs",
      "echo server-runtime-logs-disabled",
    ),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /container-smoke server runtime log diagnostics/,
  );
});

test("the desktop lane cannot silently drop its virtual display", () => {
  const files = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace(
      "xvfb-run --auto-servernum",
      "echo desktop-display-disabled",
    ),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /desktop-electron virtual display/,
  );
});

test("the desktop lane provisions the native keychain runtime", () => {
  const files = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace("xvfb libsecret-1-0", "xvfb"),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /desktop-electron native keychain runtime/,
  );
});

test("the check lane retains full history for provenance validation", () => {
  const files = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace(/(  check:[\s\S]*?)(          fetch-depth: 0\n)/, "$1"),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /check full history checkout/,
  );
});

test("the desktop lane configures the Electron sandbox safely", () => {
  for (const [current, replacement, expected] of [
    [
      "require.resolve('electron/package.json')",
      "require.resolve('electron')",
      /desktop-electron Electron package resolution/,
    ],
    [
      'electron_dir="$(dirname "$electron_package")"',
      'electron_dir="."',
      /desktop-electron Electron package directory/,
    ],
    [
      'node "$electron_dir/install.js"',
      "echo electron-install-disabled",
      /desktop-electron explicit Electron installation/,
    ],
    [
      'sandbox="$electron_dir/dist/chrome-sandbox"',
      'sandbox="$electron_dir/chrome-sandbox"',
      /desktop-electron Electron sandbox resolution/,
    ],
    [
      'sudo chown root:root "$sandbox"',
      "echo sandbox-owner-disabled",
      /desktop-electron Electron sandbox ownership/,
    ],
    [
      'sudo chmod 4755 "$sandbox"',
      "echo sandbox-mode-disabled",
      /desktop-electron Electron sandbox mode/,
    ],
  ]) {
    const files = withFileChanged(".github/workflows/ci.yml", (content) =>
      content.replace(current, replacement),
    );
    assert.match(validateCiContract(files).join("\n"), expected);
  }

  const files = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace(
      '          sudo chown root:root "$sandbox"\n          sudo chmod 4755 "$sandbox"',
      '          sudo chmod 4755 "$sandbox"\n          sudo chown root:root "$sandbox"',
    ),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /must set Electron sandbox ownership before mode/,
  );

  const installAfterValidation = withFileChanged(
    ".github/workflows/ci.yml",
    (content) =>
      content.replace(
        '          yarn workspace @standardnotes/desktop node "$electron_dir/install.js"\n          sandbox="$electron_dir/dist/chrome-sandbox"\n          test -f "$sandbox"',
        '          sandbox="$electron_dir/dist/chrome-sandbox"\n          test -f "$sandbox"\n          yarn workspace @standardnotes/desktop node "$electron_dir/install.js"',
      ),
  );
  assert.match(
    validateCiContract(installAfterValidation).join("\n"),
    /must install Electron before validating its sandbox/,
  );

  const buildStep = `      - name: Build the desktop test artifact
        working-directory: app
        run: yarn build:desktop
`;
  const sandboxStep = `      - name: Configure Electron sandbox
        working-directory: app
        run: |
          electron_package="$(yarn workspace @standardnotes/desktop node -p "require.resolve('electron/package.json')")"
          electron_dir="$(dirname "$electron_package")"
          yarn workspace @standardnotes/desktop node "$electron_dir/install.js"
          sandbox="$electron_dir/dist/chrome-sandbox"
          test -f "$sandbox"
          sudo chown root:root "$sandbox"
          sudo chmod 4755 "$sandbox"
          test "$(stat -c '%U:%G %a' "$sandbox")" = "root:root 4755"
`;
  const reorderedFiles = withFileChanged(
    ".github/workflows/ci.yml",
    (content) =>
      content
        .replace(buildStep, "__DESKTOP_BUILD_STEP__\n")
        .replace(sandboxStep, buildStep)
        .replace("__DESKTOP_BUILD_STEP__\n", sandboxStep),
  );
  assert.match(
    validateCiContract(reorderedFiles).join("\n"),
    /must build before configuring the Electron sandbox/,
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

test("container publication is bounded to the tested protected-main run", () => {
  for (const [fragment, expected] of [
    ["github.event_name == 'push'", /push-only publication guard/],
    ["github.ref == 'refs/heads/main'", /protected-main publication guard/],
    [
      "github.repository == 'supermarsx/standard-red-notes'",
      /first-party repository publication guard/,
    ],
    [
      "needs.container-smoke.result == 'success'",
      /successful container acceptance guard/,
    ],
    [
      "needs.production-gate.result == 'success'",
      /successful production gate guard/,
    ],
    ["environment: release-production", /protected publication environment/],
  ]) {
    const files = withCiJobChanged("publish-containers", (block) =>
      replaceAllRequired(block, fragment),
    );
    assert.match(validateCiContract(files).join("\n"), expected);
  }
});

test("registry authority cannot escape the isolated publisher", () => {
  const elevatedWorkflow = withFileChanged(
    ".github/workflows/ci.yml",
    (content) =>
      content.replace(
        "permissions:\n  contents: read",
        "permissions:\n  contents: read\n  packages: write",
      ),
  );
  assert.match(
    validateCiContract(elevatedWorkflow).join("\n"),
    /forbidden packages write permission outside publish-containers/,
  );

  const checkoutPublisher = withCiJobChanged("publish-containers", (block) =>
    block.replace(
      "    steps:\n",
      "    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n",
    ),
  );
  assert.match(
    validateCiContract(checkoutPublisher).join("\n"),
    /must not check out or execute repository code/,
  );
});

test("container publication cannot use mutable tags or skip paired verification", () => {
  const mutableTag = withCiJobChanged("publish-containers", (block) =>
    block.replace(
      "PUBLISH_TAG: ${{ needs.container-smoke.outputs.publication_tag }}",
      "PUBLISH_TAG: main",
    ),
  );
  assert.match(
    validateCiContract(mutableTag).join("\n"),
    /producer tag handoff/,
  );

  for (const [fragment, expected] of [
    [
      'docker push "$GHCR_SERVER_IMAGE:$PUBLISH_TAG"',
      /exactly 2 coordinated image push occurrence/,
    ],
    [
      approvedWorkflowAction("attestBuildProvenance"),
      /exactly 2 image attestation occurrence/,
    ],
    ["gh attestation verify", /published provenance verification/],
    ["RepoDigests", /remote registry digest verification/],
  ]) {
    const files = withCiJobChanged("publish-containers", (block) =>
      replaceAllRequired(block, fragment),
    );
    assert.match(validateCiContract(files).join("\n"), expected);
  }
});

test("container publication verifies the handoff before registry login", () => {
  const files = withCiJobChanged("publish-containers", (block) =>
    block
      .replace(
        "Verify and load the exact tested images",
        "__VERIFY_EXACT_IMAGES__",
      )
      .replace(
        "Log in to GitHub Container Registry",
        "Verify and load the exact tested images",
      )
      .replace(
        "__VERIFY_EXACT_IMAGES__",
        "Log in to GitHub Container Registry",
      ),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /must validate producer identity before download, verify before login, then push, re-pull, attest, verify, and record digests in order/,
  );
});

test("the tested image archive is exported only after hardening on first-party main", () => {
  const missingGuard = withCiJobChanged("container-smoke", (block) =>
    block.replace(
      "github.repository == 'supermarsx/standard-red-notes'",
      "github.repository != ''",
    ),
  );
  assert.match(
    validateCiContract(missingGuard).join("\n"),
    /first-party archive guard exactly 3 times, found 2/,
  );

  const reordered = withCiJobChanged("container-smoke", (block) =>
    block
      .replace("Verify image and live-container hardening", "__HARDEN_IMAGES__")
      .replace(
        "Export the exact tested app and server images",
        "Verify image and live-container hardening",
      )
      .replace(
        "__HARDEN_IMAGES__",
        "Export the exact tested app and server images",
      ),
  );
  assert.match(
    validateCiContract(reordered).join("\n"),
    /must harden, bind producer identity, export, and upload the tested images in that order/,
  );
});

test("protected-main container publication cannot be cancelled by another event class", () => {
  const sharedEventGroup = withFileChanged(
    ".github/workflows/ci.yml",
    (content) =>
      content.replace(
        "group: ci-${{ github.event_name }}-${{ (github.event_name == 'push' && github.ref == 'refs/heads/main' && github.repository == 'supermarsx/standard-red-notes') && github.run_id || github.event.pull_request.number || github.ref }}",
        "group: ci-${{ github.event.pull_request.number || github.ref }}",
      ),
  );
  assert.match(
    validateCiContract(sharedEventGroup).join("\n"),
    /run-isolated protected-main workflow concurrency/,
  );

  const cancellableMain = withFileChanged(
    ".github/workflows/ci.yml",
    (content) =>
      content.replace(
        "cancel-in-progress: ${{ github.event_name != 'push' || github.ref != 'refs/heads/main' || github.repository != 'supermarsx/standard-red-notes' }}",
        "cancel-in-progress: true",
      ),
  );
  assert.match(
    validateCiContract(cancellableMain).join("\n"),
    /non-cancelling protected-main publication/,
  );
});

test("failed publisher reruns reuse the successful producer identity", () => {
  const currentAttempt = withCiJobChanged("publish-containers", (block) =>
    block.replace(
      "PUBLISH_ATTEMPT: ${{ needs.container-smoke.outputs.publication_attempt }}",
      "PUBLISH_ATTEMPT: ${{ github.run_attempt }}",
    ),
  );
  assert.match(
    validateCiContract(currentAttempt).join("\n"),
    /must reuse producer identity instead of the current retry attempt/,
  );

  const emptyArtifactId = withCiJobChanged("publish-containers", (block) =>
    block.replace(
      "PUBLISH_ARTIFACT_ID: ${{ needs.container-smoke.outputs.publication_artifact_id }}",
      'PUBLISH_ARTIFACT_ID: ""',
    ),
  );
  assert.match(
    validateCiContract(emptyArtifactId).join("\n"),
    /producer artifact ID handoff/,
  );
});

test("container handoff download stays on the producer artifact ID in the current run", () => {
  const byName = withCiJobChanged("publish-containers", (block) =>
    block.replace(
      "          artifact-ids: ${{ env.PUBLISH_ARTIFACT_ID }}",
      "          name: ${{ env.PUBLISH_ARTIFACT }}",
    ),
  );
  const byNameErrors = validateCiContract(byName).join("\n");
  assert.match(byNameErrors, /immutable current-run artifact download/);
  assert.match(byNameErrors, /forbidden input name/);

  const crossRun = withCiJobChanged("publish-containers", (block) =>
    block.replace(
      "          artifact-ids: ${{ env.PUBLISH_ARTIFACT_ID }}",
      "          artifact-ids: ${{ env.PUBLISH_ARTIFACT_ID }}\n          github-token: ${{ github.token }}\n          repository: attacker/repository\n          run-id: 1",
    ),
  );
  const crossRunErrors = validateCiContract(crossRun).join("\n");
  assert.match(crossRunErrors, /forbidden input github-token/);
  assert.match(crossRunErrors, /forbidden input repository/);
  assert.match(crossRunErrors, /forbidden input run-id/);

  const ignoredDigest = withCiJobChanged("publish-containers", (block) =>
    block.replace(
      "          digest-mismatch: error",
      "          digest-mismatch: ignore",
    ),
  );
  assert.match(
    validateCiContract(ignoredDigest).join("\n"),
    /fail-closed artifact transport digest/,
  );
});

test("container publisher authority and attestation identity stay active and exact", () => {
  const commentedPermission = withCiJobChanged("publish-containers", (block) =>
    block.replace("      packages: write", "      # packages: write"),
  );
  assert.match(
    validateCiContract(commentedPermission).join("\n"),
    /exactly 1 active package write permission, found 0/,
  );

  const selfHosted = withCiJobChanged("publish-containers", (block) =>
    block.replace("    runs-on: ubuntu-latest", "    runs-on: self-hosted"),
  );
  assert.match(
    validateCiContract(selfHosted).join("\n"),
    /must not use a self-hosted runner/,
  );

  const wrongSubject = withCiJobChanged("publish-containers", (block) =>
    block.replace(
      "          subject-name: ${{ env.GHCR_APP_IMAGE }}",
      "          subject-name: ${{ env.GHCR_SERVER_IMAGE }}",
    ),
  );
  assert.match(
    validateCiContract(wrongSubject).join("\n"),
    /Attest app image provenance exact image subject/,
  );

  for (const [fragment, expected] of [
    ["              --bundle-from-oci \\", /OCI bundle source/],
    ["              --deny-self-hosted-runners \\", /hosted-runner identity/],
    [
      '              --source-digest "$PUBLISH_REVISION" \\',
      /source digest identity/,
    ],
    ["              --source-ref refs/heads/main \\", /protected source ref/],
  ]) {
    const files = withCiJobChanged("publish-containers", (block) =>
      replaceRequired(block, fragment),
    );
    assert.match(validateCiContract(files).join("\n"), expected);
  }
});

test("container publication proves the built and re-pulled linux architecture", () => {
  const missingBuildPlatforms = withCiJobChanged("container-smoke", (block) =>
    replaceAllRequired(block, "          platforms: linux/amd64\n"),
  );
  assert.match(
    validateCiContract(missingBuildPlatforms).join("\n"),
    /must build exactly two linux\/amd64 images/,
  );

  const missingRuntimePlatforms = withFileChanged(
    ".github/workflows/ci.yml",
    (content) =>
      replaceAllRequired(
        content,
        `            test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image")" = 'linux/amd64'\n`,
      ),
  );
  const platformErrors = validateCiContract(missingRuntimePlatforms).join("\n");
  assert.match(
    platformErrors,
    /must prove the platform of both exported images/,
  );
  assert.match(
    platformErrors,
    /must prove loaded and re-pulled image platforms/,
  );
});

test("container publication keeps Docker label templates shell-safe", () => {
  for (const [label, mutation] of [
    [
      "org.opencontainers.image.revision",
      '{{ index .Config.Labels \\"org.opencontainers.image.revision\\" }}',
    ],
    [
      "org.opencontainers.image.version",
      '{{ index .Config.Labels \\"org.opencontainers.image.version\\" }}',
    ],
    [
      "org.opencontainers.image.source",
      '{{ index .Config.Labels \\"org.opencontainers.image.source\\" }}',
    ],
  ]) {
    const escapedQuotes = withCiJobChanged("publish-containers", (block) =>
      replaceAllRequired(
        block,
        `{{ index .Config.Labels "${label}" }}`,
        mutation,
      ),
    );
    assert.match(
      validateCiContract(escapedQuotes).join("\n"),
      new RegExp(`shell-safe Docker label template for ${label.replaceAll(".", "\\.")}`),
    );
  }
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

test("CI contracts install release policy dependencies before direct checks", () => {
  for (const [current, replacement] of [
    ["yarn release:policy:install && ", ""],
    ["yarn test:release-impact:run", "yarn test:release-impact"],
    ["yarn test:release-contract:run", "yarn test:release-contract"],
    ["yarn release:contract:run", "yarn release:contract"],
  ]) {
    const files = withFileChanged("package.json", (content) => {
      const packageJson = JSON.parse(content);
      packageJson.scripts["ci:contracts"] = packageJson.scripts[
        "ci:contracts"
      ].replace(current, replacement);
      return JSON.stringify(packageJson);
    });

    assert.match(
      validateCiContract(files).join("\n"),
      /ci:contracts script is not wired/,
    );
  }
});

test("release policy dependency installation stays locked and non-executing", () => {
  const files = withFileChanged("package.json", (content) => {
    const packageJson = JSON.parse(content);
    packageJson.scripts["release:policy:install"] =
      "npm install --prefix scripts";
    return JSON.stringify(packageJson);
  });

  assert.match(
    validateCiContract(files).join("\n"),
    /release:policy:install script is not wired/,
  );
});

test("direct release checks cannot reinstall policy dependencies", () => {
  for (const scriptName of [
    "test:release-impact:run",
    "test:release-contract:run",
    "release:contract:run",
  ]) {
    const files = withFileChanged("package.json", (content) => {
      const packageJson = JSON.parse(content);
      packageJson.scripts[scriptName] =
        `yarn release:policy:install && ${packageJson.scripts[scriptName]}`;
      return JSON.stringify(packageJson);
    });

    assert.ok(
      validateCiContract(files).includes(
        `package.json: ${scriptName} script is not wired to the CI contract`,
      ),
    );
  }
});

test("server format commands cannot omit executable package sources", () => {
  for (const scriptName of ["format", "format:check"]) {
    const files = withFileChanged("server/package.json", (content) => {
      const packageJson = JSON.parse(content);
      packageJson.scripts[scriptName] = packageJson.scripts[scriptName].replace(
        ' "packages/*/bin/**/*.{ts,tsx}"',
        "",
      );
      return JSON.stringify(packageJson);
    });

    assert.ok(
      validateCiContract(files).includes(
        `server/package.json: ${scriptName} script must format package src and executable bin TypeScript sources`,
      ),
    );
  }
});

test("server developer runtime stays aligned with app, engine, Docker, and CI", () => {
  const staleNvmrc = withFileChanged("server/.nvmrc", () => "20.10.0\n");
  assert.match(
    validateCiContract(staleNvmrc).join("\n"),
    /server\/\.nvmrc: Node 20\.10\.0 must match app\/\.nvmrc Node 26\.5\.0/,
  );

  const staleEngine = withFileChanged("server/package.json", (content) => {
    const packageJson = JSON.parse(content);
    packageJson.engines.node = ">=20.0.0";
    return JSON.stringify(packageJson);
  });
  assert.match(
    validateCiContract(staleEngine).join("\n"),
    /server\/package\.json: engines\.node must accept and share the major/,
  );

  const staleDocker = withFileChanged("server/Dockerfile", (content) =>
    content.replace(
      "FROM node:26.5.0-alpine AS runtime",
      "FROM node:20.10.0-alpine AS runtime",
    ),
  );
  assert.match(
    validateCiContract(staleDocker).join("\n"),
    /server\/Dockerfile: runtime stage must use node:26\.5\.0-alpine/,
  );

  const staleCi = withFileChanged(".github/workflows/ci.yml", (content) =>
    content.replace('NODE_VERSION: "26"', 'NODE_VERSION: "20"'),
  );
  assert.match(
    validateCiContract(staleCi).join("\n"),
    /NODE_VERSION 20 must match server\/\.nvmrc major 26/,
  );
});
