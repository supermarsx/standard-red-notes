import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  approvedWorkflowAction,
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
