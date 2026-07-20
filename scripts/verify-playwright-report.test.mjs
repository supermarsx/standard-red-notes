import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runPlaywrightReportValidation,
  validatePlaywrightReport,
} from "./verify-playwright-report.mjs";

function reportFixture({
  expected = 2,
  skipped = 0,
  unexpected = 0,
  flaky = 0,
  explicitSkip = true,
} = {}) {
  const tests = [];
  for (let index = 0; index < expected; index += 1) {
    tests.push({ status: "expected", annotations: [] });
  }
  for (let index = 0; index < skipped; index += 1) {
    tests.push({
      status: "skipped",
      annotations: explicitSkip
        ? [{ type: "skip", description: "Chromium-only storage probe" }]
        : [],
    });
  }
  for (let index = 0; index < unexpected; index += 1) {
    tests.push({ status: "unexpected", annotations: [] });
  }
  for (let index = 0; index < flaky; index += 1) {
    tests.push({ status: "flaky", annotations: [] });
  }
  return {
    errors: [],
    stats: { expected, skipped, unexpected, flaky },
    suites: [{ title: "suite", specs: [{ title: "spec", tests }] }],
  };
}

test("accepts a complete zero-skip required report", () => {
  const result = validatePlaywrightReport(reportFixture({ expected: 4 }), {
    minExpected: 4,
    maxSkipped: 0,
  });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.summary, {
    expected: 4,
    skipped: 0,
    unexpected: 0,
    flaky: 0,
    total: 4,
  });
});

test("rejects skipped tests in a required report", () => {
  const result = validatePlaywrightReport(
    reportFixture({ expected: 3, skipped: 1 }),
    {
      minExpected: 3,
      maxSkipped: 0,
    },
  );
  assert.deepEqual(result.errors, [
    "expected at most 0 skipped tests, found 1",
  ]);
});

test("rejects unexpected and flaky outcomes", () => {
  const result = validatePlaywrightReport(
    reportFixture({ expected: 1, unexpected: 1, flaky: 1 }),
  );
  assert.deepEqual(result.errors, [
    "expected zero unexpected tests, found 1",
    "expected zero flaky tests, found 1",
  ]);
});

test("requires explicit reasons for scheduled-suite skips", () => {
  const result = validatePlaywrightReport(
    reportFixture({ expected: 2, skipped: 1, explicitSkip: false }),
    {
      minExpected: 2,
      maxSkipped: 5,
      requireExplicitSkips: true,
    },
  );
  assert.deepEqual(result.errors, [
    "1 skipped test(s) lack an explicit skip reason",
  ]);
});

test("rejects truncated reports whose stats do not match serialized tests", () => {
  const report = reportFixture({ expected: 2 });
  report.suites[0].specs[0].tests.pop();
  const result = validatePlaywrightReport(report, { minExpected: 2 });
  assert.deepEqual(result.errors, [
    "serialized test count 1 does not match outcome count 2",
  ]);
});

test("counts tests nested in child suites", () => {
  const report = {
    errors: [],
    stats: { expected: 2, skipped: 0, unexpected: 0, flaky: 0 },
    suites: [
      {
        title: "outer",
        specs: [{ title: "a", tests: [{ status: "expected" }] }],
        suites: [
          { title: "inner", specs: [{ title: "b", tests: [{ status: "expected" }] }] },
        ],
      },
    ],
  };
  const result = validatePlaywrightReport(report, { minExpected: 2 });
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.total, 2);
});

test("tolerates suites, specs and tests being absent", () => {
  const result = validatePlaywrightReport({ stats: { expected: 0 } });
  assert.deepEqual(result.errors, [
    "expected at least 1 passing tests, found 0",
  ]);
  assert.deepEqual(result.summary, {
    expected: 0,
    skipped: 0,
    unexpected: 0,
    flaky: 0,
    total: 0,
  });
});

test("treats a missing report as an empty one", () => {
  const result = validatePlaywrightReport(undefined);
  assert.deepEqual(result.errors, [
    "expected at least 1 passing tests, found 0",
  ]);
});

test("reports top-level runner errors", () => {
  const report = reportFixture({ expected: 1 });
  report.errors = [{ message: "worker crashed" }, { message: "timeout" }];
  const result = validatePlaywrightReport(report, { minExpected: 1 });
  assert.deepEqual(result.errors, ["report contains 2 top-level error(s)"]);
});

test("accepts explicitly annotated skips when they are required", () => {
  const result = validatePlaywrightReport(
    reportFixture({ expected: 2, skipped: 1, explicitSkip: true }),
    { minExpected: 2, maxSkipped: 5, requireExplicitSkips: true },
  );
  assert.deepEqual(result.errors, []);
});

test("rejects a skip annotation whose description is only whitespace", () => {
  const report = reportFixture({ expected: 1 });
  report.stats.skipped = 1;
  report.suites[0].specs[0].tests.push({
    status: "skipped",
    annotations: [{ type: "skip", description: "   " }],
  });
  const result = validatePlaywrightReport(report, {
    minExpected: 1,
    requireExplicitSkips: true,
  });
  assert.deepEqual(result.errors, [
    "1 skipped test(s) lack an explicit skip reason",
  ]);
});

test("rejects a skip annotation of the wrong type", () => {
  const report = reportFixture({ expected: 1 });
  report.stats.skipped = 1;
  report.suites[0].specs[0].tests.push({
    status: "skipped",
    annotations: [{ type: "fixme", description: "later" }],
  });
  const result = validatePlaywrightReport(report, {
    minExpected: 1,
    requireExplicitSkips: true,
  });
  assert.deepEqual(result.errors, [
    "1 skipped test(s) lack an explicit skip reason",
  ]);
});

test("CLI prints usage for --help and -h without reading a report", () => {
  const logged = [];
  const originalLog = console.log;
  console.log = (message) => logged.push(message);
  try {
    assert.equal(runPlaywrightReportValidation(["--help"]), null);
    assert.equal(runPlaywrightReportValidation(["-h"]), null);
  } finally {
    console.log = originalLog;
  }
  assert.equal(logged.length, 2);
  assert.match(logged[0], /^Usage: node scripts\/verify-playwright-report\.mjs/);
});

test("CLI requires --report", () => {
  assert.throws(() => runPlaywrightReportValidation([]), /--report is required/);
});

test("CLI rejects unknown arguments", () => {
  assert.throws(
    () => runPlaywrightReportValidation(["--bogus"]),
    /Unknown argument: --bogus/,
  );
});

test("CLI rejects non-integer and negative numeric flags", () => {
  assert.throws(
    () => runPlaywrightReportValidation(["--min-expected", "abc"]),
    /--min-expected requires a non-negative integer/,
  );
  assert.throws(
    () => runPlaywrightReportValidation(["--max-skipped", "-1"]),
    /--max-skipped requires a non-negative integer/,
  );
});

function withReportFile(report, run) {
  const file = path.join(
    mkdtempSync(path.join(tmpdir(), "srn-playwright-")),
    "report.json",
  );
  writeFileSync(file, JSON.stringify(report));
  try {
    return run(file);
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

test("CLI reads a report file and prints a summary", () => {
  const logged = [];
  const originalLog = console.log;
  console.log = (message) => logged.push(message);
  let summary;
  try {
    summary = withReportFile(
      reportFixture({ expected: 3, skipped: 1 }),
      (file) =>
        runPlaywrightReportValidation([
          "--report",
          file,
          "--min-expected",
          "3",
          "--max-skipped",
          "1",
          "--require-explicit-skips",
        ]),
    );
  } finally {
    console.log = originalLog;
  }
  assert.deepEqual(summary, {
    expected: 3,
    skipped: 1,
    unexpected: 0,
    flaky: 0,
    total: 4,
  });
  assert.match(
    logged[0],
    /^Playwright report valid: 3 expected, 1 explicitly bounded skips, 0 unexpected, 0 flaky\.$/,
  );
});

test("CLI throws with every validation error listed", () => {
  assert.throws(
    () =>
      withReportFile(reportFixture({ expected: 1, unexpected: 1 }), (file) =>
        runPlaywrightReportValidation(["--report", file, "--min-expected", "5"]),
      ),
    (error) => {
      assert.match(error.message, /^Playwright report validation failed:\n/);
      assert.match(error.message, /- expected zero unexpected tests, found 1/);
      assert.match(error.message, /- expected at least 5 passing tests, found 1/);
      return true;
    },
  );
});
