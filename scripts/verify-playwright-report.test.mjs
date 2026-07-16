import assert from "node:assert/strict";
import test from "node:test";

import { validatePlaywrightReport } from "./verify-playwright-report.mjs";

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
