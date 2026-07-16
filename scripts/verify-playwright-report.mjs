#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

function collectTests(suites, output = []) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) {
      output.push(...(spec.tests ?? []));
    }
    collectTests(suite.suites, output);
  }
  return output;
}

export function validatePlaywrightReport(report, options = {}) {
  const errors = [];
  const stats = report?.stats ?? {};
  const expected = Number(stats.expected ?? 0);
  const skipped = Number(stats.skipped ?? 0);
  const unexpected = Number(stats.unexpected ?? 0);
  const flaky = Number(stats.flaky ?? 0);
  const tests = collectTests(report?.suites);

  if ((report?.errors ?? []).length > 0) {
    errors.push(`report contains ${report.errors.length} top-level error(s)`);
  }
  if (unexpected !== 0) {
    errors.push(`expected zero unexpected tests, found ${unexpected}`);
  }
  if (flaky !== 0) {
    errors.push(`expected zero flaky tests, found ${flaky}`);
  }
  if (expected < (options.minExpected ?? 1)) {
    errors.push(
      `expected at least ${options.minExpected ?? 1} passing tests, found ${expected}`,
    );
  }
  if (options.maxSkipped !== undefined && skipped > options.maxSkipped) {
    errors.push(
      `expected at most ${options.maxSkipped} skipped tests, found ${skipped}`,
    );
  }

  if (options.requireExplicitSkips) {
    const implicitSkips = tests.filter(
      (entry) =>
        entry.status === "skipped" &&
        !(entry.annotations ?? []).some(
          (annotation) =>
            annotation.type === "skip" &&
            typeof annotation.description === "string" &&
            annotation.description.trim(),
        ),
    );
    if (implicitSkips.length > 0) {
      errors.push(
        `${implicitSkips.length} skipped test(s) lack an explicit skip reason`,
      );
    }
  }

  const serializedTestCount = tests.length;
  const outcomeCount = expected + skipped + unexpected + flaky;
  if (serializedTestCount !== outcomeCount) {
    errors.push(
      `serialized test count ${serializedTestCount} does not match outcome count ${outcomeCount}`,
    );
  }

  return {
    errors,
    summary: { expected, skipped, unexpected, flaky, total: outcomeCount },
  };
}

function parseNonNegativeInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const result = { minExpected: 1, requireExplicitSkips: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--report") {
      result.report = argv[++index];
    } else if (flag === "--min-expected") {
      result.minExpected = parseNonNegativeInteger(argv[++index], flag);
    } else if (flag === "--max-skipped") {
      result.maxSkipped = parseNonNegativeInteger(argv[++index], flag);
    } else if (flag === "--require-explicit-skips") {
      result.requireExplicitSkips = true;
    } else if (flag === "--help" || flag === "-h") {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return result;
}

export function runPlaywrightReportValidation(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(
      "Usage: node scripts/verify-playwright-report.mjs --report <json> [--min-expected N] [--max-skipped N] [--require-explicit-skips]",
    );
    return null;
  }
  if (!args.report) {
    throw new Error("--report is required");
  }

  const reportPath = path.resolve(args.report);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const result = validatePlaywrightReport(report, args);
  if (result.errors.length > 0) {
    throw new Error(
      `Playwright report validation failed:\n- ${result.errors.join("\n- ")}`,
    );
  }

  const summary = result.summary;
  console.log(
    `Playwright report valid: ${summary.expected} expected, ${summary.skipped} explicitly bounded skips, ` +
      `${summary.unexpected} unexpected, ${summary.flaky} flaky.`,
  );
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    runPlaywrightReportValidation();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
