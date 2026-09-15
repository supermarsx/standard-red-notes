#!/usr/bin/env node

// Run every contract gate and report every verdict.
//
// `yarn ci:contracts` used to be a plain `&&` chain. A chain reports the FIRST
// failure and then stops, so a single red leg leaves every later gate
// unverified while the run shows one error. That is not a theoretical concern:
// an environmental failure in `test:ci-tools` (a test that assumed WSL's
// /mnt/<drive> layout) stopped the chain before ANY release leg ran, and a
// verifier had to execute all six legs by hand to learn that the other five
// were green. A gate that did not run is not a gate that passed, and a chain
// cannot tell you which of the two you have.
//
// This runner executes each leg regardless of what came before, prints a
// summary naming every leg and its exit code, and exits non-zero if any leg
// failed. The legs stay spelled out in `package.json` so the script remains
// readable there and the release contract can still see them.
//
// A leg marked `--prerequisite` is different: later legs depend on it (the
// release-policy install provides the dependencies the release validators
// import), so if it fails the rest are reported as NOT RUN rather than run and
// reported as failures they did not cause.

import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

export class ContractGateArgumentError extends Error {}

/**
 * `--leg <command>` (repeatable) and `--prerequisite <command>`. Order is
 * preserved; prerequisites are not special-cased by position.
 */
export function parseLegs(argv) {
  const legs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--leg" && argument !== "--prerequisite") {
      throw new ContractGateArgumentError(
        `Unexpected argument ${JSON.stringify(argument)}; expected --leg or --prerequisite`,
      );
    }
    const command = argv[index + 1];
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new ContractGateArgumentError(`Missing command after ${argument}`);
    }
    legs.push({
      command: command.trim(),
      prerequisite: argument === "--prerequisite",
    });
    index += 1;
  }
  if (legs.length === 0) {
    throw new ContractGateArgumentError(
      "No gates given; pass at least one --leg",
    );
  }
  return legs;
}

export const NOT_RUN = "not run";

/**
 * One line per leg plus a verdict, so a reader can see at a glance which gates
 * ran, which passed, and which never got the chance.
 */
export function summarize(results) {
  const width = Math.max(...results.map(({ command }) => command.length));
  const lines = results.map(({ command, status }) => {
    const verdict =
      status === NOT_RUN
        ? "NOT RUN"
        : status === 0
          ? "pass"
          : `FAIL (exit ${status})`;
    return `  ${command.padEnd(width)}  ${verdict}`;
  });
  const failed = results.filter(({ status }) => status !== 0);
  lines.push(
    failed.length === 0
      ? `All ${results.length} contract gates passed.`
      : `${failed.length} of ${results.length} contract gates did not pass: ${failed
          .map(({ command }) => command)
          .join(", ")}`,
  );
  return lines.join("\n");
}

export function runContractGates(
  legs,
  run = defaultRun,
  announce = defaultAnnounce,
) {
  const results = [];
  let prerequisiteFailed = false;
  for (const { command, prerequisite } of legs) {
    if (prerequisiteFailed) {
      results.push({ command, status: NOT_RUN });
      continue;
    }
    announce(`\n=== contract gate: ${command}\n`);
    const status = run(command);
    results.push({ command, status });
    if (status !== 0 && prerequisite) {
      prerequisiteFailed = true;
    }
  }
  return results;
}

// Injectable so a unit test driving `runContractGates` with a stub runner does
// not print six fake gate banners into the real CI log it is running inside.
function defaultAnnounce(line) {
  process.stdout.write(line);
}

function defaultRun(command) {
  const result = spawnSync(command, {
    shell: true,
    stdio: "inherit",
    cwd: path.resolve(path.dirname(scriptPath), ".."),
  });
  if (result.error) {
    process.stderr.write(`${command}: ${result.error.message}\n`);
    return 1;
  }
  // A signalled child has a null status; treat that as a failure rather than
  // letting `null !== 0` decide it by accident.
  return typeof result.status === "number" ? result.status : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const results = runContractGates(parseLegs(process.argv.slice(2)));
    process.stdout.write(`\n${summarize(results)}\n`);
    process.exitCode = results.some(({ status }) => status !== 0) ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
