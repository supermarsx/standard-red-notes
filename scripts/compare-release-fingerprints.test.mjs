import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareFingerprintSets,
  compareWithPriorRelease,
  loadPriorReleaseFingerprints,
  normalizeFingerprint,
  ReleaseFingerprintComparisonError,
} from "./compare-release-fingerprints.mjs";

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "compare-release-fingerprints.mjs",
);
const first = "a".repeat(64);
const second = "b".repeat(64);

function fingerprints(...entries) {
  return new Map(entries);
}

function expectCode(code, callback) {
  assert.throws(
    callback,
    (error) =>
      error instanceof ReleaseFingerprintComparisonError && error.code === code,
  );
}

test("matching product fingerprints produce a no-op decision", () => {
  const result = compareFingerprintSets({
    baseRef: "srn-client-v26.4",
    baselineStatus: "ancestor",
    currentFingerprints: fingerprints(["srn-client.fingerprint", first]),
    priorFingerprints: fingerprints(["srn-client.fingerprint", first]),
  });

  assert.equal(result.changed, false);
  assert.equal(result.blocked, false);
  assert.equal(result.decision, "skip-unchanged");
  assert.deepEqual(result.changedAssets, []);
});

test("a build fingerprint mismatch requests a release", () => {
  const result = compareFingerprintSets({
    baseRef: "srn-client-v26.4",
    baselineStatus: "ancestor",
    currentFingerprints: fingerprints(["srn-client.fingerprint", second]),
    priorFingerprints: fingerprints(["srn-client.fingerprint", first]),
  });

  assert.equal(result.changed, true);
  assert.equal(result.decision, "release-changed");
  assert.deepEqual(result.changedAssets, ["srn-client.fingerprint"]);
});

test("a first release needs no remote fingerprint baseline", () => {
  const result = compareWithPriorRelease({
    repository: "owner/repository",
    baseRef: "",
    baselineStatus: "first-release",
    currentFingerprints: fingerprints(["srn-mcp.fingerprint", first]),
    ghRunner: () => assert.fail("first release must not call GitHub"),
  });

  assert.equal(result.changed, true);
  assert.equal(result.decision, "release-first");
});

test("an audited force request bypasses an unavailable baseline", () => {
  const result = compareWithPriorRelease({
    repository: "owner/repository",
    baseRef: "",
    baselineStatus: "no-ancestor",
    forced: true,
    currentFingerprints: fingerprints(["srn-mobile.fingerprint", first]),
    ghRunner: () => assert.fail("forced comparison must not call GitHub"),
  });

  assert.equal(result.changed, true);
  assert.equal(result.decision, "release-forced");
});

test("no-ancestor history blocks automatic publication", () => {
  expectCode("no-ancestor-baseline", () =>
    compareWithPriorRelease({
      repository: "owner/repository",
      baseRef: "",
      baselineStatus: "no-ancestor",
      currentFingerprints: fingerprints(["srn-mobile.fingerprint", first]),
      ghRunner: () => assert.fail("blocked comparison must not call GitHub"),
    }),
  );
});

test("older and newer divergent release lines block automatic publication", () => {
  for (const baselineStatus of [
    "ancestor-with-divergent-tags",
    "ancestor-with-newer-divergent-tags",
  ]) {
    expectCode("divergent-release-history", () =>
      compareWithPriorRelease({
        repository: "owner/repository",
        baseRef: "srn-client-v26.4",
        baselineStatus,
        currentFingerprints: fingerprints(["srn-client.fingerprint", first]),
        ghRunner: () =>
          assert.fail("divergent history must block before querying GitHub"),
      }),
    );
  }
});

test("an audited force can bypass divergent release history", () => {
  const result = compareWithPriorRelease({
    repository: "owner/repository",
    baseRef: "srn-client-v26.4",
    baselineStatus: "ancestor-with-newer-divergent-tags",
    forced: true,
    currentFingerprints: fingerprints(["srn-client.fingerprint", first]),
    ghRunner: () => assert.fail("forced comparison must not call GitHub"),
  });

  assert.equal(result.changed, true);
  assert.equal(result.decision, "release-forced");
});

test("a comparable baseline must include its selected tag", () => {
  expectCode("missing-baseline-ref", () =>
    compareWithPriorRelease({
      repository: "owner/repository",
      baseRef: "",
      baselineStatus: "ancestor",
      currentFingerprints: fingerprints(["srn-admin.fingerprint", first]),
      ghRunner: () => assert.fail("invalid baseline must not call GitHub"),
    }),
  );
});

test("missing prior fingerprint assets block instead of publishing", () => {
  expectCode("missing-prior-fingerprint", () =>
    loadPriorReleaseFingerprints({
      repository: "owner/repository",
      baseRef: "srn-server-v26.2",
      expectedAssets: ["srn-server.fingerprint"],
      ghRunner: (args) => {
        assert.equal(args[0], "release");
        assert.equal(args[1], "view");
        return JSON.stringify({
          tagName: "srn-server-v26.2",
          isDraft: false,
          assets: [{ name: "SHA256SUMS.txt" }],
        });
      },
    }),
  );
});

test("unexpected prior fingerprint assets block an ambiguous product surface", () => {
  expectCode("unexpected-prior-fingerprint", () =>
    loadPriorReleaseFingerprints({
      repository: "owner/repository",
      baseRef: "srn-server-v26.2",
      expectedAssets: ["srn-server.fingerprint"],
      ghRunner: () =>
        JSON.stringify({
          tagName: "srn-server-v26.2",
          isDraft: false,
          assets: [
            { name: "srn-server.fingerprint" },
            { name: "srn-client.fingerprint" },
          ],
        }),
    }),
  );
});

test("fingerprint asset names cannot become download glob patterns", () => {
  expectCode("invalid-fingerprint-asset", () =>
    compareWithPriorRelease({
      repository: "owner/repository",
      baseRef: "srn-server-v26.2",
      baselineStatus: "ancestor",
      currentFingerprints: fingerprints(["*.fingerprint", first]),
      ghRunner: () =>
        assert.fail("invalid asset names must fail before GitHub"),
    }),
  );
  expectCode("invalid-fingerprint-asset", () =>
    loadPriorReleaseFingerprints({
      repository: "owner/repository",
      baseRef: "srn-server-v26.2",
      expectedAssets: ["*.fingerprint"],
      ghRunner: () =>
        assert.fail("invalid asset names must fail before GitHub"),
    }),
  );
});

test("malformed downloaded fingerprints block instead of publishing", () => {
  const temporary = mkdtempSync(
    path.join(os.tmpdir(), "srn-compare-fingerprint-test-"),
  );
  try {
    expectCode("malformed-fingerprint", () =>
      loadPriorReleaseFingerprints({
        repository: "owner/repository",
        baseRef: "srn-home-server-v26.2",
        expectedAssets: ["srn-home-server.fingerprint"],
        ghRunner: (args) => {
          if (args[1] === "view") {
            return JSON.stringify({
              tagName: "srn-home-server-v26.2",
              isDraft: false,
              assets: [{ name: "srn-home-server.fingerprint" }],
            });
          }
          const output = args[args.indexOf("--output") + 1];
          writeFileSync(output, "not-a-sha256\n");
          return "";
        },
      }),
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("release metadata must resolve the analyzer-selected exact tag", () => {
  expectCode("mismatched-release-metadata", () =>
    loadPriorReleaseFingerprints({
      repository: "owner/repository",
      baseRef: "srn-openclaw-v26.7",
      expectedAssets: ["srn-openclaw.fingerprint"],
      ghRunner: () =>
        JSON.stringify({
          tagName: "srn-openclaw-v26.6",
          assets: [{ name: "srn-openclaw.fingerprint" }],
        }),
    }),
  );
});

test("draft GitHub releases cannot become published baselines", () => {
  expectCode("draft-release-baseline", () =>
    loadPriorReleaseFingerprints({
      repository: "owner/repository",
      baseRef: "srn-openclaw-v26.7",
      expectedAssets: ["srn-openclaw.fingerprint"],
      ghRunner: () =>
        JSON.stringify({
          tagName: "srn-openclaw-v26.7",
          isDraft: true,
          assets: [{ name: "srn-openclaw.fingerprint" }],
        }),
    }),
  );
});

test("GitHub API failures block comparison instead of becoming changes", () => {
  expectCode("release-api-unavailable", () =>
    compareWithPriorRelease({
      repository: "owner/repository",
      baseRef: "srn-desktop-v26.3",
      baselineStatus: "ancestor",
      currentFingerprints: fingerprints([
        "srn-desktop-linux-x64.fingerprint",
        first,
      ]),
      ghRunner: () => {
        throw new ReleaseFingerprintComparisonError(
          "release-api-unavailable",
          "simulated outage",
        );
      },
    }),
  );
});

test("fingerprints reject uppercase, extra text, and whitespace-only values", () => {
  for (const value of [first.toUpperCase(), `${first} extra`, "   "]) {
    expectCode("malformed-fingerprint", () =>
      normalizeFingerprint(value, "fixture"),
    );
  }
});

test("the CLI persists explicit blocked evidence before returning failure", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "srn-compare-cli-"));
  try {
    const output = path.join(directory, "comparison.json");
    const githubOutput = path.join(directory, "github-output.txt");
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--repository",
        "owner/repository",
        "--base-ref",
        "",
        "--baseline-status",
        "no-ancestor",
        "--forced",
        "false",
        "--fingerprint",
        `srn-mobile.fingerprint=${first}`,
        "--output",
        output,
        "--github-output",
        githubOutput,
      ],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 1);
    const evidence = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(evidence.changed, false);
    assert.equal(evidence.blocked, true);
    assert.equal(evidence.reasonCode, "no-ancestor-baseline");
    assert.match(readFileSync(githubOutput, "utf8"), /decision=blocked/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
