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
      "sudo chown root:root packages/desktop/node_modules/electron/dist/chrome-sandbox",
      "echo sandbox-owner-disabled",
      /desktop-electron Electron sandbox ownership/,
    ],
    [
      "sudo chmod 4755 packages/desktop/node_modules/electron/dist/chrome-sandbox",
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
      "          sudo chown root:root packages/desktop/node_modules/electron/dist/chrome-sandbox\n          sudo chmod 4755 packages/desktop/node_modules/electron/dist/chrome-sandbox",
      "          sudo chmod 4755 packages/desktop/node_modules/electron/dist/chrome-sandbox\n          sudo chown root:root packages/desktop/node_modules/electron/dist/chrome-sandbox",
    ),
  );
  assert.match(
    validateCiContract(files).join("\n"),
    /must set Electron sandbox ownership before mode/,
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
