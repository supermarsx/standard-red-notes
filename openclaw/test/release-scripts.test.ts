import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// These two scripts are executable entrypoints: they call main() at import
// time and never export anything, so they are exercised as subprocesses.
// Every guard covered here fires during argument/manifest validation, i.e.
// before the scripts touch yarn, npm or the network.

const toolRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRelease = join(toolRoot, "scripts", "package-release.mjs");
const verifyRelease = join(toolRoot, "scripts", "verify-release.mjs");

const packageJson = JSON.parse(
  readFileSync(join(toolRoot, "package.json"), "utf8"),
);
const currentTag = `srn-openclaw-v${packageJson.version}`;
const validSha = "a".repeat(40);
const nodeMajor = Number(process.versions.node.split(".")[0]);

function runScript(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd: toolRoot,
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

describe("package-release.mjs argument validation", () => {
  it("exits non-zero with a prefixed diagnostic on any failure", () => {
    const out = runScript(packageRelease, []);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("OpenClaw release packaging failed:");
  });

  it("requires --tag, --source-sha and --source-date-epoch", () => {
    expect(runScript(packageRelease, []).stderr).toContain(
      "missing required --tag argument",
    );
    expect(runScript(packageRelease, ["--tag", currentTag]).stderr).toContain(
      "missing required --source-sha argument",
    );
    expect(
      runScript(packageRelease, ["--tag", currentTag, "--source-sha", validSha])
        .stderr,
    ).toContain("missing required --source-date-epoch argument");
  });

  it("rejects a flag with no value rather than reading the next flag", () => {
    const out = runScript(packageRelease, [
      "--tag",
      currentTag,
      "--source-sha",
    ]);
    expect(out.stderr).toContain("expected --name value arguments");
  });

  it("rejects a positional argument that is not a --flag", () => {
    expect(runScript(packageRelease, ["tag", currentTag]).stderr).toContain(
      "expected --name value arguments",
    );
  });

  it("rejects a malformed release tag", () => {
    const out = runScript(packageRelease, [
      "--tag",
      "openclaw-1.0.0",
      "--source-sha",
      validSha,
      "--source-date-epoch",
      "1700000000",
    ]);
    expect(out.stderr).toContain("release tag must be srn-openclaw-v<semver>");
  });

  it("refuses to package a tag whose version differs from package.json", () => {
    const out = runScript(packageRelease, [
      "--tag",
      "srn-openclaw-v99.99.99",
      "--source-sha",
      validSha,
      "--source-date-epoch",
      "1700000000",
    ]);
    expect(out.stderr).toContain(
      `release tag version 99.99.99 does not match openclaw/package.json version ${packageJson.version}`,
    );
  });

  it("requires a full 40-char lowercase commit SHA", () => {
    for (const sha of [
      "abc123",
      "A".repeat(40),
      "z".repeat(40),
      `${validSha}0`,
    ]) {
      const out = runScript(packageRelease, [
        "--tag",
        currentTag,
        "--source-sha",
        sha,
        "--source-date-epoch",
        "1700000000",
      ]);
      expect(out.stderr).toContain(
        "--source-sha must be a full 40-character lowercase commit SHA",
      );
    }
  });

  it("requires a positive integer source date epoch", () => {
    for (const epoch of ["0", "-1", "not-a-number", "1700000000.5"]) {
      const out = runScript(packageRelease, [
        "--tag",
        currentTag,
        "--source-sha",
        validSha,
        "--source-date-epoch",
        epoch,
      ]);
      expect(out.stderr).toContain(
        "--source-date-epoch must be a positive Unix timestamp",
      );
    }
  });

  it("requires an HTTPS source repository", () => {
    const out = runScript(packageRelease, [
      "--tag",
      currentTag,
      "--source-sha",
      validSha,
      "--source-date-epoch",
      "1700000000",
      "--source-repository",
      "http://github.com/supermarsx/standard-red-notes",
    ]);
    expect(out.stderr).toContain("--source-repository must be an HTTPS URL");
  });

  it("accepts a fully valid input set and moves past input validation", () => {
    const out = runScript(packageRelease, [
      "--tag",
      currentTag,
      "--source-sha",
      validSha,
      "--source-date-epoch",
      "1700000000",
    ]);
    // It will still fail later (no Node 26 / no build / non-empty out dir),
    // but never on the inputs themselves.
    expect(out.stderr).not.toMatch(/--source-sha must be/);
    expect(out.stderr).not.toMatch(/--source-date-epoch must be/);
    expect(out.stderr).not.toMatch(/--source-repository must be/);
    expect(out.stderr).not.toMatch(/does not match openclaw\/package\.json/);
    expect(out.stderr).not.toMatch(/release tag must be/);
  });

  it.skipIf(nodeMajor === 26)(
    "refuses to build a release package on a non-Node-26 runtime",
    () => {
      const out = runScript(packageRelease, [
        "--tag",
        currentTag,
        "--source-sha",
        validSha,
        "--source-date-epoch",
        "1700000000",
      ]);
      expect(out.stderr).toContain(
        `release packages must be built with Node 26, found ${process.version}`,
      );
      expect(out.status).toBe(1);
    },
  );
});

describe("verify-release.mjs argument validation", () => {
  const required: Record<string, string> = {
    archive: "a.tgz",
    checksums: "SHA256SUMS.txt",
    manifest: "m.json",
    target: "linux-x64",
  };
  const argsFor = (overrides: Record<string, string | null> = {}) =>
    Object.entries({ ...required, ...overrides })
      .filter(([, value]) => value !== null)
      .flatMap(([key, value]) => [`--${key}`, value as string]);
  const baseArgs = argsFor();

  it("exits non-zero with a prefixed diagnostic on any failure", () => {
    const out = runScript(verifyRelease, []);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("OpenClaw release verification failed:");
  });

  it("requires archive, checksums, manifest and target", () => {
    for (const key of Object.keys(required)) {
      expect(
        runScript(verifyRelease, argsFor({ [key]: null })).stderr,
      ).toContain(`missing required --${key} argument`);
    }
  });

  it("rejects a flag with no value", () => {
    expect(runScript(verifyRelease, ["--archive"]).stderr).toContain(
      "expected --name value arguments",
    );
  });

  it("rejects an unknown smoke target before doing any work", () => {
    expect(
      runScript(verifyRelease, argsFor({ target: "solaris-sparc" })).stderr,
    ).toContain("unknown OpenClaw smoke target: solaris-sparc");
  });

  it.skipIf(nodeMajor === 26)(
    "refuses to smoke-test a release on a non-Node-26 runtime",
    () => {
      const out = runScript(verifyRelease, baseArgs);
      expect(out.stderr).toContain(
        `release smoke tests require Node 26, found ${process.version}`,
      );
      expect(out.status).toBe(1);
    },
  );
});
