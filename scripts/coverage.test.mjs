import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activateWorkspacePnp,
  buildWorkspaceCoverageArgs,
  computeCoverageMetrics,
  coverageColor,
  createZeroCoverageForSource,
  discoverEligibleSourceFiles,
  discoverJestWorkspaces,
  EXPECTED_COVERAGE_WORKSPACES,
  generateCoverageReport,
  mergeCoverageReports,
  normalizeWorkspaceReport,
  renderFlatSquareBadge,
  resolveCoverageWorkspaces,
  runProcessWithTimeout,
  runWorkspaceCoverage,
  validateExactCoverageSources,
  validateWorkspaceInventory,
  workspaceSlug,
} from "./coverage.mjs";

test("normalizes package Jest arguments to one bounded worker count", () => {
  const args = buildWorkspaceCoverageArgs(
    "coverage-output",
    "effective-config.cjs",
    1,
    "jest spec --coverage --no-cache --config ./jest.config.js --maxWorkers=2",
  );

  assert.deepEqual(args.slice(0, 4), ["exec", "jest", "spec", "--no-cache"]);
  assert.deepEqual(
    args.filter((argument) => /^(?:--maxWorkers|-w)(?:=|$)/.test(argument)),
    ["--maxWorkers=1"],
  );
  assert.deepEqual(
    args.filter((argument) => argument.startsWith("--config")),
    ["--config=effective-config.cjs"],
  );
});

async function temporaryRepository(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "srn-coverage-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(file, value = "export const value = 1;\n") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value, "utf8");
}

function finalEffectiveConfigArgument(args) {
  const argument = args.at(-1);
  assert.match(argument, /^--config=.+/);
  return argument.slice("--config=".length);
}

function loadCjsConfig(configFile) {
  return createRequire(configFile)(configFile);
}

async function effectiveConfigFiles(directory) {
  return (await fs.readdir(directory)).filter((file) =>
    file.startsWith(".coverage-effective-jest-"),
  );
}

async function writeRawCoverageForProcess(options, report = {}) {
  const directoryArgument = options.args.find((argument) =>
    argument.startsWith("--coverageDirectory="),
  );
  assert.ok(directoryArgument, "missing --coverageDirectory argument");
  const directory = directoryArgument.slice("--coverageDirectory=".length);
  await writeJson(path.join(directory, "coverage-final.json"), report);
}

function location(line) {
  return {
    start: { line, column: 0 },
    end: { line, column: 1 },
  };
}

function fileCoverage(
  source,
  { statements = [0, 0], fn = 0, branches = [0, 0] } = {},
) {
  return {
    path: source,
    statementMap: {
      0: location(1),
      1: location(2),
    },
    fnMap: {
      0: { name: "example", decl: location(1), loc: location(1), line: 1 },
    },
    branchMap: {
      0: { line: 1, type: "if", locations: [location(1), location(1)] },
    },
    s: { 0: statements[0], 1: statements[1] },
    f: { 0: fn },
    b: { 0: branches },
  };
}

async function writeCoverageGroup(
  root,
  scope,
  definitions,
  {
    complete = true,
    groupName = `coverage-${scope}`,
    selectedLocations = definitions.map(
      (definition, index) => definition.location ?? `packages/${index}`,
    ),
  } = {},
) {
  const repository = path.resolve(root, "../..");
  const group = path.join(root, groupName);
  const inventory = definitions.map((definition, index) => ({
    name: definition.workspace ?? `${scope}-${index}`,
    location: definition.location ?? `packages/${index}`,
    ...(definition.emptySourceReason
      ? { emptySourceReason: definition.emptySourceReason }
      : {}),
    ...(definition.sourceOnlyReason
      ? { sourceOnlyReason: definition.sourceOnlyReason }
      : {}),
  }));
  const selectedLocationSet = new Set(selectedLocations);
  const reports = [];

  for (const [index, definition] of definitions.entries()) {
    const workspace = inventory[index];
    const defaultSource = `${scope}/${workspace.location}/src/index.ts`;
    const report =
      definition.report ??
      (workspace.emptySourceReason
        ? {}
        : {
            [defaultSource]: fileCoverage(defaultSource, definition.coverage),
          });
    const sources =
      definition.sources ??
      Object.values(report).map((coverage) => coverage.path);
    const eligibleSources = definition.eligibleSources ?? sources;
    for (const source of eligibleSources) {
      await writeText(
        path.isAbsolute(source) ? source : path.resolve(repository, source),
      );
    }
    if (!selectedLocationSet.has(workspace.location)) {
      continue;
    }
    const slug = workspaceSlug(workspace.location);
    const relative = definition.reportPath ?? `${slug}/coverage-final.json`;
    if (definition.writeReport !== false) {
      await writeJson(path.join(group, relative), report);
    }
    reports.push({
      workspace: workspace.name,
      location: workspace.location,
      slug,
      path: relative,
      sources,
      emptySourceReason: definition.emptySourceReason ?? null,
      sourceOnlyReason: definition.sourceOnlyReason ?? null,
    });
  }

  const manifest = {
    schemaVersion: 4,
    scope,
    complete,
    inventory: inventory.map((workspace) => ({
      ...workspace,
      slug: workspaceSlug(workspace.location),
      emptySourceReason: workspace.emptySourceReason ?? null,
      sourceOnlyReason: workspace.sourceOnlyReason ?? null,
    })),
    selected: inventory
      .filter((workspace) => selectedLocationSet.has(workspace.location))
      .map((workspace) => ({
        ...workspace,
        slug: workspaceSlug(workspace.location),
        emptySourceReason: workspace.emptySourceReason ?? null,
        sourceOnlyReason: workspace.sourceOnlyReason ?? null,
      })),
    reports,
  };
  await writeJson(path.join(group, "manifest.json"), manifest);
  return { group, inventory, manifest };
}

test("discovers nested Jest workspaces and excludes non-Jest test scripts", async (t) => {
  const repository = await temporaryRepository(t);
  const app = path.join(repository, "app");
  await writeJson(path.join(app, "package.json"), {
    private: true,
    workspaces: { packages: ["packages/*"] },
  });
  await writeJson(path.join(app, "packages/jest/package.json"), {
    name: "@test/jest",
    scripts: { test: "jest --runInBand" },
  });
  await writeJson(path.join(app, "packages/vitest/package.json"), {
    name: "@test/vitest",
    scripts: { test: "vitest run" },
  });
  await writeJson(path.join(app, "packages/nested/package.json"), {
    name: "@test/nested-root",
    workspaces: ["child"],
  });
  await writeJson(path.join(app, "packages/nested/child/package.json"), {
    name: "@test/nested-jest",
    scripts: { test: "yarn jest" },
  });

  const workspaces = await discoverJestWorkspaces(app);
  assert.deepEqual(
    workspaces.map(({ name, location: workspaceLocation }) => ({
      name,
      location: workspaceLocation,
    })),
    [
      { name: "@test/jest", location: "packages/jest" },
      { name: "@test/nested-jest", location: "packages/nested/child" },
    ],
  );
});

test("enumerates src/lib source and excludes tests, declarations, generated, build, vendor, and fixtures", async (t) => {
  const repository = await temporaryRepository(t);
  const workspace = path.join(repository, "app/packages/source");
  const included = ["lib/runtime.js", "src/index.ts", "src/view.tsx"];
  const excluded = [
    "src/index.spec.ts",
    "src/view.test.tsx",
    "src/types.d.ts",
    "src/__tests__/helper.ts",
    "src/generated/client.ts",
    "src/build/bundle.js",
    "src/vendor/library.js",
    "src/fixtures/sample.ts",
    "test/helper.ts",
  ];
  for (const file of [...included, ...excluded]) {
    await writeText(path.join(workspace, file));
  }

  const sources = await discoverEligibleSourceFiles(workspace, repository);
  assert.deepEqual(
    sources.map(({ workspacePath }) => workspacePath),
    included,
  );
});

test("keeps a source-only Jest workspace in the denominator inventory", async (t) => {
  const repository = await temporaryRepository(t);
  const app = path.join(repository, "app");
  await writeJson(path.join(app, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
  });
  await writeJson(path.join(app, "packages/source-only/package.json"), {
    name: "@test/source-only",
    scripts: { test: "jest --passWithNoTests" },
  });
  await writeText(path.join(app, "packages/source-only/src/index.ts"));

  const resolved = await resolveCoverageWorkspaces({
    repoRoot: repository,
    workspaceRoot: "app",
    expectedWorkspaces: [
      { name: "@test/source-only", location: "packages/source-only" },
    ],
  });

  assert.equal(resolved.workspaces.length, 1);
  assert.deepEqual(
    resolved.workspaces[0].sourceFiles.map(
      ({ workspacePath }) => workspacePath,
    ),
    ["src/index.ts"],
  );
});

test("materializes a non-empty zero map for source omitted by a no-test Jest run", async (t) => {
  const repository = await temporaryRepository(t);
  const absolute = path.join(repository, "app/packages/only/src/index.ts");
  await writeText(
    absolute,
    "export function choose(value: boolean): number { return value ? 1 : 2; }\n",
  );

  const coverage = await createZeroCoverageForSource({
    absolute,
    repositoryPath: "app/packages/only/src/index.ts",
  });

  assert.equal(coverage.path, "app/packages/only/src/index.ts");
  assert.ok(Object.keys(coverage.s).length > 0);
  assert.ok(Object.keys(coverage.f).length > 0);
  assert.ok(Object.keys(coverage.b).length > 0);
  assert.ok(Object.values(coverage.s).every((counter) => counter === 0));
  assert.ok(Object.values(coverage.f).every((counter) => counter === 0));
  assert.ok(
    Object.values(coverage.b).every((counters) =>
      counters.every((counter) => counter === 0),
    ),
  );
});

test("instruments representative JS, JSX, TypeScript, and TSX syntax as zero-hit maps", async (t) => {
  const repository = await temporaryRepository(t);
  const samples = [
    {
      file: "src/runtime.js",
      contents: [
        "export class Counter {",
        "  #value = 0;",
        "  increment(step = 1) {",
        "    this.#value += step;",
        "    return this.#value > 1 ? this.#value : 0;",
        "  }",
        "}",
      ].join("\n"),
    },
    {
      file: "src/runtime-view.jsx",
      contents: [
        "export const RuntimeView = ({ enabled = true }) => (",
        '  <main>{enabled ? <span data-state="on">Ready</span> : null}</main>',
        ");",
      ].join("\n"),
    },
    {
      file: "src/model.ts",
      contents: [
        "function sealed<T extends Function>(value: T): T { return value; }",
        "@sealed",
        "export class Store<T extends { id: string }> {",
        "  #items = new Map<string, T>();",
        "  get(id: string) {",
        "    return this.#items.get(id) satisfies T | undefined;",
        "  }",
        "}",
      ].join("\n"),
    },
    {
      file: "src/view.tsx",
      contents: [
        "type Props<T> = { item?: T; render?: (value: T) => JSX.Element };",
        "export const View = <T extends { id: string },>({ item, render }: Props<T>) => (",
        '  <section data-id={item?.id ?? "missing"}>{item && render?.(item)}</section>',
        ");",
      ].join("\n"),
    },
  ];

  for (const sample of samples) {
    const absolute = path.join(repository, sample.file);
    await writeText(absolute, sample.contents);
    const coverage = await createZeroCoverageForSource({
      absolute,
      repositoryPath: sample.file,
    });
    assert.equal(coverage.path, sample.file);
    assert.ok(Object.keys(coverage.s).length > 0, sample.file);
    assert.ok(Object.keys(coverage.f).length > 0, sample.file);
    assert.ok(Object.values(coverage.s).every((counter) => counter === 0));
    assert.ok(Object.values(coverage.f).every((counter) => counter === 0));
    assert.ok(
      Object.values(coverage.b).every((counters) =>
        counters.every((counter) => counter === 0),
      ),
    );
  }
});

test("reports the eligible source path when instrumentation parsing fails", async (t) => {
  const repository = await temporaryRepository(t);
  const repositoryPath = "app/packages/broken/src/index.ts";
  const absolute = path.join(repository, repositoryPath);
  await writeText(absolute, "export const broken: = 1;\n");

  await assert.rejects(
    createZeroCoverageForSource({ absolute, repositoryPath }),
    /Unable to instrument eligible source app\/packages\/broken\/src\/index\.ts/,
  );
});

test("preserves actual coverage and synthesizes only missing eligible sources", async (t) => {
  const repository = await temporaryRepository(t);
  const directory = path.join(repository, "app/packages/mixed");
  const actualPath = "app/packages/mixed/src/actual.ts";
  const missingPath = "app/packages/mixed/src/missing.ts";
  const actualAbsolute = path.join(repository, actualPath);
  const missingAbsolute = path.join(repository, missingPath);
  const reportFile = path.join(repository, "coverage/coverage-final.json");
  await writeText(actualAbsolute, "export const actual = true;\n");
  await writeText(
    missingAbsolute,
    "export function missing(value: boolean) { return value ? 1 : 2; }\n",
  );
  const actualCoverage = fileCoverage(actualAbsolute, {
    statements: [3, 2],
    fn: 4,
    branches: [2, 1],
  });
  await writeJson(reportFile, { [actualAbsolute]: actualCoverage });

  await normalizeWorkspaceReport(
    {
      name: "@test/mixed",
      directory,
      sourceFiles: [
        { absolute: actualAbsolute, repositoryPath: actualPath },
        { absolute: missingAbsolute, repositoryPath: missingPath },
      ],
    },
    reportFile,
    repository,
  );
  const normalized = JSON.parse(await fs.readFile(reportFile, "utf8"));

  assert.deepEqual(normalized[actualPath], {
    ...actualCoverage,
    path: actualPath,
  });
  assert.ok(
    Object.values(normalized[missingPath].s).every((counter) => counter === 0),
  );
  assert.doesNotThrow(() =>
    validateExactCoverageSources(
      normalized,
      [actualPath, missingPath],
      reportFile,
    ),
  );
});

test("requires exact source inventory equality and rejects duplicate paths", () => {
  const first = "src/first.ts";
  const second = "src/second.ts";
  const firstCoverage = fileCoverage(first);

  assert.throws(
    () =>
      validateExactCoverageSources(
        { [first]: firstCoverage },
        [first, second],
        "missing.json",
      ),
    /missing: src\/second\.ts/,
  );
  assert.throws(
    () =>
      validateExactCoverageSources(
        {
          [first]: firstCoverage,
          "src/unexpected.ts": fileCoverage("src/unexpected.ts"),
        },
        [first],
        "unexpected.json",
      ),
    /unexpected: src\/unexpected\.ts/,
  );
  assert.throws(
    () =>
      validateExactCoverageSources(
        {
          [first]: firstCoverage,
          alias: structuredClone(firstCoverage),
        },
        [first],
        "duplicate.json",
      ),
    /duplicates: src\/first\.ts/,
  );
});

test("requires an explicit reason for an inventory workspace with no eligible source", async (t) => {
  const repository = await temporaryRepository(t);
  const app = path.join(repository, "app");
  await writeJson(path.join(app, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
  });
  await writeJson(path.join(app, "packages/empty/package.json"), {
    name: "@test/empty",
    scripts: { test: "jest --passWithNoTests" },
  });

  await assert.rejects(
    resolveCoverageWorkspaces({
      repoRoot: repository,
      workspaceRoot: "app",
      expectedWorkspaces: [{ name: "@test/empty", location: "packages/empty" }],
    }),
    /document emptySourceReason/,
  );

  const resolved = await resolveCoverageWorkspaces({
    repoRoot: repository,
    workspaceRoot: "app",
    expectedWorkspaces: [
      {
        name: "@test/empty",
        location: "packages/empty",
        emptySourceReason: "This package contains configuration only.",
      },
    ],
  });
  assert.equal(resolved.workspaces[0].sourceFiles.length, 0);
  assert.equal(
    resolved.workspaces[0].emptySourceReason,
    "This package contains configuration only.",
  );
});

test("rejects unexpected or stale source-only inventory entries", async (t) => {
  const reviewed = EXPECTED_COVERAGE_WORKSPACES.app.find(
    ({ location: workspaceLocation }) =>
      workspaceLocation === "packages/responses",
  );
  assert.ok(reviewed?.sourceOnlyReason);

  await t.test("unexpected flag", async (t) => {
    const repository = await temporaryRepository(t);
    await assert.rejects(
      resolveCoverageWorkspaces({
        repoRoot: repository,
        workspaceRoot: "app",
        expectedWorkspaces: [
          {
            name: "@test/unreviewed",
            location: "packages/unreviewed",
            sourceOnlyReason: reviewed.sourceOnlyReason,
          },
        ],
      }),
      /Unexpected source-only coverage workspace app\/packages\/unreviewed/,
    );
  });

  await t.test("missing reviewed flag", async (t) => {
    const repository = await temporaryRepository(t);
    await assert.rejects(
      resolveCoverageWorkspaces({
        repoRoot: repository,
        workspaceRoot: "app",
        expectedWorkspaces: [
          { name: reviewed.name, location: reviewed.location },
        ],
      }),
      /Source-only coverage inventory drift.*missing sourceOnlyReason/,
    );
  });

  await t.test("package gains a test", async (t) => {
    const repository = await temporaryRepository(t);
    const app = path.join(repository, "app");
    const directory = path.join(app, reviewed.location);
    await writeJson(path.join(app, "package.json"), {
      private: true,
      workspaces: ["packages/*"],
    });
    await writeJson(path.join(directory, "package.json"), {
      name: reviewed.name,
      scripts: { test: "jest --passWithNoTests" },
    });
    await writeText(path.join(directory, "src/index.ts"));
    await writeText(path.join(directory, "src/index.spec.ts"));

    await assert.rejects(
      resolveCoverageWorkspaces({
        repoRoot: repository,
        workspaceRoot: "app",
        expectedWorkspaces: [reviewed],
      }),
      /Source-only coverage inventory drift.*found package-local test\/spec file.*src\/index\.spec\.ts/,
    );
  });
});

test("fails when discovered Jest workspaces drift from the expected inventory", async (t) => {
  const repository = await temporaryRepository(t);
  const app = path.join(repository, "app");
  await writeJson(path.join(app, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
  });
  await writeJson(path.join(app, "packages/actual/package.json"), {
    name: "@test/actual",
    scripts: { test: "jest" },
  });

  await assert.rejects(
    resolveCoverageWorkspaces({
      repoRoot: repository,
      workspaceRoot: "app",
      expectedWorkspaces: [
        { name: "@test/expected", location: "packages/expected" },
      ],
    }),
    /inventory drift.*missing: packages\/expected.*unexpected: packages\/actual/,
  );
});

test("rejects duplicate workspace slugs instead of collapsing them", () => {
  assert.throws(
    () =>
      validateWorkspaceInventory(
        [
          { name: "@test/plus", location: "packages/a+b" },
          { name: "@test/dash", location: "packages/a-b" },
        ],
        "app",
      ),
    /Duplicate app workspace slug.*packages-a-b/,
  );
});

test("suppresses inherited collectCoverageFrom through a unique effective config", async (t) => {
  const repository = await temporaryRepository(t);
  const directory = path.join(repository, "app/packages/only");
  const absolute = path.join(directory, "src/index.ts");
  const repositoryPath = "app/packages/only/src/index.ts";
  const outputRoot = path.join(repository, "coverage/raw/app");
  await writeText(absolute);
  await writeJson(path.join(directory, "base.jest.json"), {
    collectCoverageFrom: ["src/**/*.{ts,tsx}"],
    moduleNameMapper: { "^@src/(.*)$": "<rootDir>/src/$1" },
    testEnvironment: "node",
  });
  await writeText(
    path.join(directory, "jest.config.cjs"),
    [
      'const base = require("./base.jest.json");',
      'module.exports = { ...base, displayName: "preserved-config" };',
      "",
    ].join("\n"),
  );
  const effectiveConfigPaths = [];
  let spawned;

  for (let run = 0; run < 2; run += 1) {
    await runWorkspaceCoverage(
      {
        name: "@test/only",
        location: "packages/only",
        slug: "packages-only",
        directory,
        testScript: "jest --coverage --no-cache --maxWorkers=2",
        sourceFiles: [{ absolute, repositoryPath }],
      },
      outputRoot,
      repository,
      {
        timeoutMs: 1234,
        runProcess: async (options) => {
          spawned = options;
          const effectiveConfigFile = finalEffectiveConfigArgument(
            options.args,
          );
          effectiveConfigPaths.push(effectiveConfigFile);
          assert.equal(path.dirname(effectiveConfigFile), directory);
          const effective = loadCjsConfig(effectiveConfigFile);
          assert.deepEqual(effective.collectCoverageFrom, []);
          assert.equal(effective.displayName, "preserved-config");
          assert.equal(effective.testEnvironment, "node");
          assert.deepEqual(effective.moduleNameMapper, {
            "^@src/(.*)$": "<rootDir>/src/$1",
          });
          await writeRawCoverageForProcess(options, {
            [absolute]: fileCoverage(absolute),
          });
          return { code: 0, signal: null, stdout: "", stderr: "" };
        },
      },
    );
  }

  assert.equal(spawned.timeoutMs, 1234);
  assert.equal(spawned.captureOutput, true);
  assert.ok(spawned.args.includes("exec"));
  assert.ok(spawned.args.includes("jest"));
  assert.ok(spawned.args.includes("--no-cache"));
  assert.ok(spawned.args.includes("--coverage"));
  assert.deepEqual(
    spawned.args.filter((argument) =>
      /^(?:--maxWorkers|-w)(?:=|$)/.test(argument),
    ),
    ["--maxWorkers=1"],
  );
  assert.equal(
    spawned.args.some((argument) => argument.includes("collectCoverageFrom")),
    false,
  );
  assert.notEqual(effectiveConfigPaths[0], effectiveConfigPaths[1]);
  for (const configFile of effectiveConfigPaths) {
    await assert.rejects(fs.access(configFile), { code: "ENOENT" });
  }
  assert.deepEqual(await effectiveConfigFiles(directory), []);
  const report = JSON.parse(
    await fs.readFile(
      path.join(outputRoot, "packages-only/coverage-final.json"),
      "utf8",
    ),
  );
  assert.deepEqual(Object.keys(report), [repositoryPath]);
});

test("fails a successful normal workspace process that omits coverage-final.json", async (t) => {
  const repository = await temporaryRepository(t);
  const app = path.join(repository, "app");
  const directory = path.join(app, "packages/normal");
  await writeJson(path.join(app, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
  });
  await writeJson(path.join(directory, "package.json"), {
    name: "@test/normal",
    scripts: { test: "jest" },
  });
  await writeText(
    path.join(directory, "jest.config.cjs"),
    "module.exports = {};\n",
  );
  await writeText(path.join(directory, "src/index.ts"));
  const resolved = await resolveCoverageWorkspaces({
    repoRoot: repository,
    workspaceRoot: "app",
    expectedWorkspaces: [{ name: "@test/normal", location: "packages/normal" }],
  });

  await assert.rejects(
    runWorkspaceCoverage(
      resolved.workspaces[0],
      path.join(repository, "coverage/raw/app"),
      repository,
      {
        runProcess: async () => ({
          code: 0,
          signal: null,
          stdout: "",
          stderr: "",
        }),
      },
    ),
    /Missing raw Jest coverage report/,
  );
  assert.deepEqual(await effectiveConfigFiles(directory), []);
});

test("allows a reviewed source-only workspace to synthesize a missing report as zero-only", async (t) => {
  const repository = await temporaryRepository(t);
  const app = path.join(repository, "app");
  const reviewed = EXPECTED_COVERAGE_WORKSPACES.app.find(
    ({ location: workspaceLocation }) =>
      workspaceLocation === "packages/responses",
  );
  assert.ok(reviewed?.sourceOnlyReason);
  const directory = path.join(app, reviewed.location);
  await writeJson(path.join(app, "package.json"), {
    private: true,
    workspaces: ["packages/*"],
  });
  await writeJson(path.join(directory, "package.json"), {
    name: reviewed.name,
    scripts: { test: "jest --passWithNoTests" },
  });
  await writeText(
    path.join(directory, "jest.config.cjs"),
    "module.exports = {};\n",
  );
  await writeText(
    path.join(directory, "src/index.ts"),
    "export function classify(value: boolean) { return value ? 1 : 0; }\n",
  );
  await writeText(
    path.join(directory, "src/value.ts"),
    "export const value = 1;\n",
  );
  const resolved = await resolveCoverageWorkspaces({
    repoRoot: repository,
    workspaceRoot: "app",
    expectedWorkspaces: [reviewed],
  });
  const outputRoot = path.join(repository, "coverage/raw/app");

  const result = await runWorkspaceCoverage(
    resolved.workspaces[0],
    outputRoot,
    repository,
    {
      runProcess: async () => ({
        code: 0,
        signal: null,
        stdout: "",
        stderr: "",
      }),
    },
  );
  const report = JSON.parse(await fs.readFile(result.reportFile, "utf8"));
  const expectedSources = resolved.workspaces[0].sourceFiles.map(
    ({ repositoryPath }) => repositoryPath,
  );

  assert.deepEqual(result.sources, expectedSources);
  assert.deepEqual(Object.keys(report).sort(), [...expectedSources].sort());
  for (const coverage of Object.values(report)) {
    assert.ok(Object.values(coverage.s).every((counter) => counter === 0));
    assert.ok(Object.values(coverage.f).every((counter) => counter === 0));
    assert.ok(
      Object.values(coverage.b).every((counters) =>
        counters.every((counter) => counter === 0),
      ),
    );
  }
  assert.deepEqual(await effectiveConfigFiles(directory), []);
});

test("keeps app node_modules config dependencies on the non-PnP path", async (t) => {
  const repository = await temporaryRepository(t);
  const appRoot = path.join(repository, "app");
  const directory = path.join(appRoot, "packages/only");
  const dependency = path.join(
    appRoot,
    "node_modules/app-jest-config-dependency",
  );
  await writeJson(path.join(dependency, "package.json"), {
    name: "app-jest-config-dependency",
    main: "index.cjs",
  });
  await writeText(
    path.join(dependency, "index.cjs"),
    'module.exports = { displayName: "node-modules-config" };\n',
  );
  await writeText(
    path.join(directory, "jest.config.cjs"),
    'module.exports = require("app-jest-config-dependency");\n',
  );

  assert.equal(await activateWorkspacePnp(appRoot), null);
  let effectiveConfigFile;
  await runWorkspaceCoverage(
    {
      name: "@test/app-node-modules",
      location: "packages/only",
      slug: "packages-only",
      directory,
      testScript: "jest",
      sourceFiles: [],
    },
    path.join(repository, "coverage/raw/app"),
    repository,
    {
      runProcess: async (options) => {
        effectiveConfigFile = finalEffectiveConfigArgument(options.args);
        const effective = loadCjsConfig(effectiveConfigFile);
        assert.equal(effective.displayName, "node-modules-config");
        assert.deepEqual(effective.collectCoverageFrom, []);
        await writeRawCoverageForProcess(options);
        return { code: 0, signal: null, stdout: "", stderr: "" };
      },
    },
  );

  await assert.rejects(fs.access(effectiveConfigFile), { code: "ENOENT" });
  assert.deepEqual(await effectiveConfigFiles(directory), []);
});

test("activates one exact PnP API for config dependencies and rejects a conflicting root", async (t) => {
  const repository = await temporaryRepository(t);
  const serverRoot = path.join(repository, "server");
  const conflictingRoot = path.join(repository, "other-server");
  const directory = path.join(serverRoot, "packages/only");
  const coverageModuleUrl = new URL("./coverage.mjs", import.meta.url).href;
  await writeText(
    path.join(serverRoot, ".pnp.cjs"),
    [
      'const Module = require("node:module");',
      'const path = require("node:path");',
      "const originalResolveFilename = Module._resolveFilename;",
      'const dependency = path.join(__dirname, ".pnp-store/config-dependency.cjs");',
      "module.exports = {",
      "  setup() {",
      "    globalThis.__coveragePnpSetupCount =",
      "      (globalThis.__coveragePnpSetupCount ?? 0) + 1;",
      "    Module._resolveFilename = function (request, parent, isMain, options) {",
      '      if (request === "pnp-config-dependency") return dependency;',
      "      return originalResolveFilename.call(",
      "        this,",
      "        request,",
      "        parent,",
      "        isMain,",
      "        options,",
      "      );",
      "    };",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  await writeText(
    path.join(serverRoot, ".pnp-store/config-dependency.cjs"),
    'module.exports = { displayName: "pnp-backed-config" };\n',
  );
  await writeText(
    path.join(directory, "jest.config.cjs"),
    'module.exports = require("pnp-config-dependency");\n',
  );
  await writeText(
    path.join(conflictingRoot, ".pnp.cjs"),
    "module.exports = { setup() {} };\n",
  );

  const probeFile = path.join(repository, "pnp-probe.mjs");
  await writeText(
    probeFile,
    [
      'import assert from "node:assert/strict";',
      'import { promises as fs } from "node:fs";',
      'import { createRequire } from "node:module";',
      'import path from "node:path";',
      `import { activateWorkspacePnp, runWorkspaceCoverage } from ${JSON.stringify(coverageModuleUrl)};`,
      "",
      "const [repository, serverRoot, conflictingRoot, directory] =",
      "  process.argv.slice(2);",
      'const expectedPnpFile = await fs.realpath(path.join(serverRoot, ".pnp.cjs"));',
      "const firstActivation = await activateWorkspacePnp(serverRoot);",
      "const repeatedActivation = await activateWorkspacePnp(serverRoot);",
      "assert.equal(firstActivation, expectedPnpFile);",
      "assert.equal(repeatedActivation, expectedPnpFile);",
      "assert.equal(globalThis.__coveragePnpSetupCount, 1);",
      "",
      "let loadedEffectiveConfig = false;",
      "await runWorkspaceCoverage(",
      "  {",
      '    name: "@test/pnp",',
      '    location: "packages/only",',
      '    slug: "packages-only",',
      "    directory,",
      '    testScript: "jest",',
      "    sourceFiles: [],",
      "  },",
      '  path.join(repository, "coverage/raw/server"),',
      "  repository,",
      "  {",
      "    runProcess: async (options) => {",
      '      const configFile = options.args.at(-1).slice("--config=".length);',
      "      const effective = createRequire(configFile)(configFile);",
      '      assert.equal(effective.displayName, "pnp-backed-config");',
      "      assert.deepEqual(effective.collectCoverageFrom, []);",
      "      const coverageDirectory = options.args",
      '        .find((argument) => argument.startsWith("--coverageDirectory="))',
      '        .slice("--coverageDirectory=".length);',
      "      await fs.mkdir(coverageDirectory, { recursive: true });",
      "      await fs.writeFile(",
      '        path.join(coverageDirectory, "coverage-final.json"),',
      '        "{}\\n",',
      '        "utf8",',
      "      );",
      "      loadedEffectiveConfig = true;",
      '      return { code: 0, signal: null, stdout: "", stderr: "" };',
      "    },",
      "  },",
      ");",
      "assert.equal(loadedEffectiveConfig, true);",
      "assert.deepEqual(",
      "  (await fs.readdir(directory)).filter((file) =>",
      '    file.startsWith(".coverage-effective-jest-"),',
      "  ),",
      "  [],",
      ");",
      "",
      "await assert.rejects(",
      "  activateWorkspacePnp(conflictingRoot),",
      "  (error) => {",
      "    assert.match(error.message, /Conflicting Yarn PnP roots/);",
      "    assert.ok(error.message.includes(expectedPnpFile));",
      "    assert.ok(",
      '      error.message.includes(path.join(conflictingRoot, ".pnp.cjs")),',
      "    );",
      "    return true;",
      "  },",
      ");",
      "",
    ].join("\n"),
  );

  const outcome = await runProcessWithTimeout({
    command: process.execPath,
    args: [probeFile, repository, serverRoot, conflictingRoot, directory],
    cwd: repository,
    env: { ...process.env },
    captureOutput: true,
    timeoutMs: 10_000,
  });
  assert.equal(outcome.code, 0, outcome.stderr);
  assert.equal(outcome.signal, null);
});

test("uses a package script config and appends the effective --config last", async (t) => {
  const repository = await temporaryRepository(t);
  const directory = path.join(repository, "app/packages/precedence");
  const absolute = path.join(directory, "src/index.ts");
  const repositoryPath = "app/packages/precedence/src/index.ts";
  const outputRoot = path.join(repository, "coverage/raw/app");
  await writeText(absolute);
  await writeJson(path.join(directory, "script.jest.json"), {
    collectCoverageFrom: ["src/**/*.ts"],
    displayName: "script-config",
    testEnvironment: "node",
  });
  await writeText(
    path.join(directory, "jest.config.cjs"),
    'module.exports = { displayName: "wrong-default" };\n',
  );
  let effectiveConfigFile;

  await runWorkspaceCoverage(
    {
      name: "@test/precedence",
      location: "packages/precedence",
      slug: "packages-precedence",
      directory,
      testScript: "jest --config ./script.jest.json --runInBand",
      sourceFiles: [{ absolute, repositoryPath }],
    },
    outputRoot,
    repository,
    {
      runProcess: async (options) => {
        effectiveConfigFile = finalEffectiveConfigArgument(options.args);
        const expandedConfigArguments = [
          "./script.jest.json",
          ...options.args
            .filter((argument) => argument.startsWith("--config="))
            .map((argument) => argument.slice("--config=".length)),
        ];
        assert.equal(expandedConfigArguments.at(-1), effectiveConfigFile);
        const effective = loadCjsConfig(effectiveConfigFile);
        assert.equal(effective.displayName, "script-config");
        assert.equal(effective.testEnvironment, "node");
        assert.deepEqual(effective.collectCoverageFrom, []);
        await writeRawCoverageForProcess(options, {
          [absolute]: fileCoverage(absolute),
        });
        return { code: 0, signal: null, stdout: "", stderr: "" };
      },
    },
  );

  await assert.rejects(fs.access(effectiveConfigFile), { code: "ENOENT" });
  assert.deepEqual(await effectiveConfigFiles(directory), []);
});

test("removes the effective config after process failure and timeout", async (t) => {
  const repository = await temporaryRepository(t);
  const scenarios = [
    {
      name: "failure",
      expected: /coverage failed with exit code 7/,
      outcome: async () => ({
        code: 7,
        signal: null,
        stdout: "",
        stderr: "",
      }),
    },
    {
      name: "timeout",
      expected: /coverage timed out after 25 ms/,
      outcome: async () => {
        const error = new Error("Process timed out after 25 ms");
        error.code = "ERR_COVERAGE_TIMEOUT";
        throw error;
      },
    },
  ];

  for (const scenario of scenarios) {
    const directory = path.join(repository, `app/packages/${scenario.name}`);
    const absolute = path.join(directory, "src/index.ts");
    await writeText(absolute);
    await writeText(
      path.join(directory, "jest.config.cjs"),
      'module.exports = { testEnvironment: "node" };\n',
    );
    let effectiveConfigFile;

    await assert.rejects(
      runWorkspaceCoverage(
        {
          name: `@test/${scenario.name}`,
          location: `packages/${scenario.name}`,
          slug: `packages-${scenario.name}`,
          directory,
          testScript: "jest",
          sourceFiles: [
            {
              absolute,
              repositoryPath: `app/packages/${scenario.name}/src/index.ts`,
            },
          ],
        },
        path.join(repository, "coverage/raw/app"),
        repository,
        {
          timeoutMs: 25,
          runProcess: async (options) => {
            effectiveConfigFile = finalEffectiveConfigArgument(options.args);
            return scenario.outcome();
          },
        },
      ),
      scenario.expected,
    );
    await assert.rejects(fs.access(effectiveConfigFile), { code: "ENOENT" });
    assert.deepEqual(await effectiveConfigFiles(directory), []);
  }
});

test("rejects function and Promise Jest config exports clearly", async (t) => {
  const repository = await temporaryRepository(t);
  const scenarios = [
    {
      name: "function",
      config: "module.exports = async () => ({});\n",
      expected: /function and async function exports are not supported/,
    },
    {
      name: "promise",
      config: "module.exports = Promise.resolve({});\n",
      expected: /Promise and async exports are not supported/,
    },
  ];

  for (const scenario of scenarios) {
    const directory = path.join(repository, `app/packages/${scenario.name}`);
    const absolute = path.join(directory, "src/index.ts");
    await writeText(absolute);
    await writeText(path.join(directory, "jest.config.cjs"), scenario.config);
    let spawned = false;

    await assert.rejects(
      runWorkspaceCoverage(
        {
          name: `@test/${scenario.name}`,
          location: `packages/${scenario.name}`,
          slug: `packages-${scenario.name}`,
          directory,
          testScript: "jest",
          sourceFiles: [
            {
              absolute,
              repositoryPath: `app/packages/${scenario.name}/src/index.ts`,
            },
          ],
        },
        path.join(repository, "coverage/raw/app"),
        repository,
        {
          runProcess: async () => {
            spawned = true;
            return { code: 0, signal: null };
          },
        },
      ),
      scenario.expected,
    );
    assert.equal(spawned, false);
    assert.deepEqual(await effectiveConfigFiles(directory), []);
  }
});

test("treats a captured Failed to collect coverage diagnostic as fatal", async (t) => {
  const repository = await temporaryRepository(t);
  const directory = path.join(repository, "app/packages/diagnostic");
  const absolute = path.join(directory, "src/index.ts");
  await writeText(absolute);
  await writeText(
    path.join(directory, "jest.config.cjs"),
    "module.exports = {};\n",
  );
  let effectiveConfigFile;

  await assert.rejects(
    runWorkspaceCoverage(
      {
        name: "@test/diagnostic",
        location: "packages/diagnostic",
        slug: "packages-diagnostic",
        directory,
        testScript: "jest",
        sourceFiles: [
          {
            absolute,
            repositoryPath: "app/packages/diagnostic/src/index.ts",
          },
        ],
      },
      path.join(repository, "coverage/raw/app"),
      repository,
      {
        runProcess: async (options) => {
          effectiveConfigFile = finalEffectiveConfigArgument(options.args);
          return {
            code: 0,
            signal: null,
            stdout: "",
            stderr: "Failed to collect coverage from inherited-source.ts\n",
          };
        },
      },
    ),
    /coverage emitted fatal Jest diagnostic: Failed to collect coverage/,
  );
  await assert.rejects(fs.access(effectiveConfigFile), { code: "ENOENT" });
  assert.deepEqual(await effectiveConfigFiles(directory), []);
});

test("times out and terminates the spawned process tree", async (t) => {
  const repository = await temporaryRepository(t);
  const pidFile = path.join(repository, "grandchild.pid");
  const grandchildScript = "setInterval(() => {}, 1000);";
  const parentScript = [
    'const { spawn } = require("node:child_process");',
    'const grandchild = spawn(process.execPath, ["-e", ' +
      JSON.stringify(grandchildScript) +
      '], { stdio: "ignore", env: process.env });',
    'require("node:fs").writeFileSync(process.env.COVERAGE_TIMEOUT_PID_FILE, String(grandchild.pid));',
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const started = Date.now();

  await assert.rejects(
    runProcessWithTimeout({
      command: process.execPath,
      args: ["-e", parentScript],
      cwd: repository,
      env: { ...process.env, COVERAGE_TIMEOUT_PID_FILE: pidFile },
      stdio: "ignore",
      timeoutMs: 1000,
    }),
    /Process timed out after 1000 ms/,
  );
  assert.ok(Date.now() - started < 5000);

  const grandchildPid = Number.parseInt(await fs.readFile(pidFile, "utf8"), 10);
  assert.ok(Number.isInteger(grandchildPid));
  let terminated = false;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(grandchildPid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
      terminated = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(terminated, true, `Process ${grandchildPid} survived timeout`);
});

test("counts a source-only package's non-empty zero-covered map", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const source = path.join(repository, "app/packages/source-only/src/index.ts");
  const app = await writeCoverageGroup(input, "app", [
    {
      workspace: "@test/source-only",
      location: "packages/source-only",
      report: { [source]: fileCoverage(source) },
    },
  ]);

  const { coverageMap, reportCount } = await mergeCoverageReports({
    input,
    repoRoot: repository,
    expectedScopes: ["app"],
    inventories: { app: app.inventory },
  });
  const metrics = computeCoverageMetrics(coverageMap);

  assert.equal(reportCount, 1);
  assert.deepEqual(coverageMap.files(), [
    "app/packages/source-only/src/index.ts",
  ]);
  assert.deepEqual(metrics.statements, { covered: 0, total: 2, pct: 0 });
  assert.deepEqual(metrics.lines, { covered: 0, total: 2, pct: 0 });
});

test("merges the complete app-core, app-web, and server manifest union without averaging percentages", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const appDefinitions = EXPECTED_COVERAGE_WORKSPACES.app.map(
    (workspace, index) => ({
      workspace: workspace.name,
      location: workspace.location,
      ...(workspace.emptySourceReason
        ? { emptySourceReason: workspace.emptySourceReason }
        : {}),
      ...(workspace.sourceOnlyReason
        ? { sourceOnlyReason: workspace.sourceOnlyReason }
        : {}),
      coverage:
        workspace.location === "packages/web"
          ? { statements: [1, 1], fn: 1, branches: [1, 1] }
          : index === 0
            ? { statements: [1, 0], fn: 1, branches: [1, 0] }
            : undefined,
    }),
  );
  const serverDefinitions = EXPECTED_COVERAGE_WORKSPACES.server.map(
    (workspace, index) => ({
      workspace: workspace.name,
      location: workspace.location,
      ...(workspace.emptySourceReason
        ? { emptySourceReason: workspace.emptySourceReason }
        : {}),
      ...(workspace.sourceOnlyReason
        ? { sourceOnlyReason: workspace.sourceOnlyReason }
        : {}),
      coverage:
        index === 0
          ? { statements: [1, 0], fn: 0, branches: [0, 0] }
          : undefined,
    }),
  );
  const appCoreLocations = EXPECTED_COVERAGE_WORKSPACES.app
    .filter(
      ({ location: workspaceLocation }) => workspaceLocation !== "packages/web",
    )
    .map(({ location: workspaceLocation }) => workspaceLocation);
  const appCore = await writeCoverageGroup(input, "app", appDefinitions, {
    groupName: "coverage-app-core",
    selectedLocations: appCoreLocations,
  });
  const appWeb = await writeCoverageGroup(input, "app", appDefinitions, {
    groupName: "coverage-app-web",
    selectedLocations: ["packages/web"],
  });
  const server = await writeCoverageGroup(input, "server", serverDefinitions, {
    groupName: "coverage-server",
  });

  const { coverageMap, reportCount, scopes } = await mergeCoverageReports({
    input,
    repoRoot: repository,
    expectedScopes: ["app", "server"],
    inventories: EXPECTED_COVERAGE_WORKSPACES,
  });
  const metrics = computeCoverageMetrics(coverageMap);

  assert.equal(appCore.manifest.selected.length, 11);
  assert.equal(appWeb.manifest.selected.length, 1);
  assert.equal(server.manifest.selected.length, 16);
  assert.equal(reportCount, 28);
  assert.equal(coverageMap.files().length, 28);
  assert.deepEqual(scopes, ["app", "server"]);
  assert.deepEqual(metrics.statements, { covered: 4, total: 56, pct: 7.1 });
  assert.deepEqual(metrics.lines, { covered: 4, total: 56, pct: 7.1 });
  assert.deepEqual(metrics.functions, { covered: 2, total: 28, pct: 7.1 });
  assert.deepEqual(metrics.branches, { covered: 3, total: 56, pct: 5.4 });
});

test("rejects a workspace missing from the selected manifest union", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const definitions = [
    { workspace: "@test/core", location: "packages/core" },
    { workspace: "@test/web", location: "packages/web" },
  ];
  const app = await writeCoverageGroup(input, "app", definitions, {
    groupName: "coverage-app-core",
    selectedLocations: ["packages/core"],
  });

  await assert.rejects(
    mergeCoverageReports({
      input,
      repoRoot: repository,
      expectedScopes: ["app"],
      inventories: { app: app.inventory },
    }),
    /Coverage workspace union is incomplete for app; missing: packages\/web/,
  );
});

test("rejects a workspace selected by more than one manifest", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const definitions = [
    { workspace: "@test/core", location: "packages/core" },
    { workspace: "@test/web", location: "packages/web" },
  ];
  const first = await writeCoverageGroup(input, "app", definitions, {
    groupName: "coverage-app-core-a",
    selectedLocations: ["packages/core"],
  });
  await writeCoverageGroup(input, "app", definitions, {
    groupName: "coverage-app-core-b",
    selectedLocations: ["packages/core"],
  });

  await assert.rejects(
    mergeCoverageReports({
      input,
      repoRoot: repository,
      expectedScopes: ["app"],
      inventories: { app: first.inventory },
    }),
    /Duplicate coverage workspace across manifests: app\/packages\/core/,
  );
});

test("rejects a manifest whose scope does not match the expected scope", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const server = await writeCoverageGroup(input, "server", [
    { workspace: "@test/server", location: "packages/server" },
  ]);

  await assert.rejects(
    mergeCoverageReports({
      input,
      repoRoot: repository,
      expectedScopes: ["app"],
      inventories: { app: server.inventory, server: server.inventory },
    }),
    /Coverage manifest scope mismatch.*expected app; received server/,
  );
});

test("rejects an incomplete selected manifest", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const app = await writeCoverageGroup(
    input,
    "app",
    [{ workspace: "@test/app", location: "packages/app" }],
    { complete: false },
  );

  await assert.rejects(
    mergeCoverageReports({
      input,
      repoRoot: repository,
      expectedScopes: ["app"],
      inventories: { app: app.inventory },
    }),
    /Incomplete selected coverage manifest/,
  );
});

test("rejects an unexpected workspace in a selected manifest", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const app = await writeCoverageGroup(input, "app", [
    { workspace: "@test/app", location: "packages/app" },
  ]);
  app.manifest.selected[0].location = "packages/unexpected";
  app.manifest.selected[0].slug = workspaceSlug("packages/unexpected");
  await writeJson(path.join(app.group, "manifest.json"), app.manifest);

  await assert.rejects(
    mergeCoverageReports({
      input,
      repoRoot: repository,
      expectedScopes: ["app"],
      inventories: { app: app.inventory },
    }),
    /Unexpected coverage workspace app\/packages\/unexpected/,
  );
});

test("rejects a selected manifest missing an eligible source", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const first = "app/packages/app/src/first.ts";
  const second = "app/packages/app/src/second.ts";
  const app = await writeCoverageGroup(input, "app", [
    {
      workspace: "@test/app",
      location: "packages/app",
      eligibleSources: [first, second],
      report: { [first]: fileCoverage(first) },
      sources: [first],
    },
  ]);

  await assert.rejects(
    mergeCoverageReports({
      input,
      repoRoot: repository,
      expectedScopes: ["app"],
      inventories: { app: app.inventory },
    }),
    /Coverage manifest source inventory mismatch.*missing: app\/packages\/app\/src\/second\.ts/,
  );
});

test("rejects duplicate canonical sources in a selected manifest", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const source = "app/packages/app/src/index.ts";
  const duplicate = "app/packages/app/src/nested/../index.ts";
  const app = await writeCoverageGroup(input, "app", [
    {
      workspace: "@test/app",
      location: "packages/app",
      eligibleSources: [source],
      report: { [source]: fileCoverage(source) },
      sources: [source, duplicate],
    },
  ]);

  await assert.rejects(
    mergeCoverageReports({
      input,
      repoRoot: repository,
      expectedScopes: ["app"],
      inventories: { app: app.inventory },
    }),
    /Duplicate @test\/app manifest source path/,
  );
});

test("reports documented 0/0 coverage as unavailable instead of 100 percent", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const emptySourceReason = "This fixture intentionally has no source.";
  const app = await writeCoverageGroup(input, "app", [
    { emptySourceReason, report: {}, sources: [] },
  ]);
  const server = await writeCoverageGroup(input, "server", [
    { emptySourceReason, report: {}, sources: [] },
  ]);
  const inventories = { app: app.inventory, server: server.inventory };

  const { coverageMap } = await mergeCoverageReports({
    input,
    repoRoot: repository,
    expectedScopes: ["app", "server"],
    inventories,
  });
  const metrics = computeCoverageMetrics(coverageMap);
  for (const metric of Object.values(metrics)) {
    assert.deepEqual(metric, { covered: 0, total: 0, pct: null });
  }

  const summary = await generateCoverageReport({
    input,
    output: "generated/coverage.svg",
    summaryOutput: "generated/summary.json",
    repoRoot: repository,
    expectedScopes: ["app", "server"],
    inventories,
  });
  const svg = await fs.readFile(
    path.join(repository, "generated/coverage.svg"),
    "utf8",
  );
  const writtenSummary = JSON.parse(
    await fs.readFile(path.join(repository, "generated/summary.json"), "utf8"),
  );

  assert.equal(summary.displayedMetric, "lines");
  assert.equal(summary.displayedValue, "n/a");
  assert.match(summary.scope, /Normalized Jest-instrumented JS\/TS source/);
  assert.deepEqual(writtenSummary, summary);
  assert.match(svg, />Jest source</);
  assert.match(svg, />n\/a</);
  assert.match(svg, /fill="#9f9f9f"/);
});

test("rejects a missing report listed by a complete manifest", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const source = path.join(repository, "app/packages/only/src/index.ts");
  const app = await writeCoverageGroup(input, "app", [
    {
      location: "packages/only",
      report: { [source]: fileCoverage(source) },
    },
  ]);
  await fs.rm(path.join(app.group, app.manifest.reports[0].path));

  await assert.rejects(
    mergeCoverageReports({
      input,
      repoRoot: repository,
      expectedScopes: ["app"],
      inventories: { app: app.inventory },
    }),
    /Missing input coverage report/,
  );
});

test("rejects an empty report for a workspace with eligible source", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const source = path.join(repository, "app/packages/only/src/index.ts");
  const app = await writeCoverageGroup(input, "app", [
    { location: "packages/only", report: {}, sources: [source] },
  ]);

  await assert.rejects(
    mergeCoverageReports({
      input,
      repoRoot: repository,
      expectedScopes: ["app"],
      inventories: { app: app.inventory },
    }),
    /Empty coverage report|Coverage report source mismatch/,
  );
});

test("rejects duplicate manifest report paths instead of Set-collapsing them", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const first = path.join(repository, "app/packages/first/src/index.ts");
  const second = path.join(repository, "app/packages/second/src/index.ts");
  const app = await writeCoverageGroup(input, "app", [
    {
      workspace: "@test/first",
      location: "packages/first",
      reportPath: "shared/coverage-final.json",
      report: { [first]: fileCoverage(first) },
    },
    {
      workspace: "@test/second",
      location: "packages/second",
      reportPath: "shared/coverage-final.json",
      report: { [second]: fileCoverage(second) },
    },
  ]);

  await assert.rejects(
    mergeCoverageReports({
      input,
      repoRoot: repository,
      expectedScopes: ["app"],
      inventories: { app: app.inventory },
    }),
    /Duplicate app report path.*shared\/coverage-final.json/,
  );
});

test("rejects malformed coverage input before aggregation", async (t) => {
  const repository = await temporaryRepository(t);
  const input = path.join(repository, "coverage/raw");
  const source = path.join(repository, "app/packages/only/src/broken.ts");
  const app = await writeCoverageGroup(input, "app", [
    {
      location: "packages/only",
      report: { broken: { path: source } },
      sources: [source],
    },
  ]);

  await assert.rejects(
    mergeCoverageReports({
      input,
      repoRoot: repository,
      expectedScopes: ["app"],
      inventories: { app: app.inventory },
    }),
    /Malformed coverage report/,
  );
});

test("renders escaped flat-square SVG and maps every coverage color band", () => {
  const svg = renderFlatSquareBadge({
    label: `source <&> "coverage"`,
    value: `7'5%`,
    title: `source <coverage> & "tests"`,
    color: coverageColor(75),
  });

  assert.match(svg, /source &lt;&amp;&gt; &quot;coverage&quot;/);
  assert.match(svg, /7&apos;5%/);
  assert.match(
    svg,
    /aria-label="source &lt;coverage&gt; &amp; &quot;tests&quot;"/,
  );
  assert.match(svg, /fill="#a4a61d"/);
  assert.match(svg, /height="20"/);
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.doesNotMatch(svg, /\brx=/);
  assert.doesNotMatch(svg, /linearGradient/);

  const colors = [
    [null, "#9f9f9f"],
    [0, "#e05d44"],
    [49.9, "#e05d44"],
    [50, "#fe7d37"],
    [60, "#dfb317"],
    [70, "#a4a61d"],
    [80, "#97ca00"],
    [90, "#4c1"],
    [100, "#4c1"],
  ];
  for (const [percent, color] of colors) {
    assert.equal(coverageColor(percent), color);
  }
  assert.throws(
    () =>
      renderFlatSquareBadge({
        label: "source",
        value: "0%",
        title: "source coverage",
        color: "red",
      }),
    /Invalid badge color/,
  );
});
