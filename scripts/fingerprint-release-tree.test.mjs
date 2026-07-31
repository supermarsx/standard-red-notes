import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ReleaseTreeFingerprintError,
  fingerprintReleaseTree,
} from "./fingerprint-release-tree.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "srn-release-tree-"));
  mkdirSync(path.join(root, "payload", "nested"), { recursive: true });
  writeFileSync(path.join(root, "payload", "a.txt"), "alpha\n");
  writeFileSync(path.join(root, "payload", "nested", "b.txt"), "beta\n");
  writeFileSync(
    path.join(root, "payload", "package.json"),
    `${JSON.stringify({ name: "fixture", version: "1.2.3" }, null, 2)}\n`,
  );
  return root;
}

async function fingerprint(root, options = {}) {
  return fingerprintReleaseTree({
    root,
    paths: ["payload"],
    ...options,
  });
}

test("fingerprints are deterministic and sensitive to file content", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const first = await fingerprint(root);
  const second = await fingerprint(root);
  assert.equal(first, second);

  writeFileSync(path.join(root, "payload", "a.txt"), "changed\n");
  assert.notEqual(await fingerprint(root), first);
});

test("paths and exclusions are part of the release surface", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const excluded = await fingerprint(root, {
    exclude: ["payload/nested"],
  });
  writeFileSync(path.join(root, "payload", "nested", "b.txt"), "ignored\n");
  assert.equal(
    await fingerprint(root, { exclude: ["payload/nested"] }),
    excluded,
  );

  writeFileSync(path.join(root, "payload", "a.txt"), "included\n");
  assert.notEqual(
    await fingerprint(root, { exclude: ["payload/nested"] }),
    excluded,
  );
});

test("package versions can be normalized without hiding other manifest changes", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, "payload", "package.json");
  const options = {
    normalizePackageVersion: ["payload/package.json"],
  };

  const first = await fingerprint(root, options);
  writeFileSync(
    manifest,
    `${JSON.stringify({ name: "fixture", version: "9.8.7" }, null, 2)}\n`,
  );
  assert.equal(await fingerprint(root, options), first);

  writeFileSync(
    manifest,
    `${JSON.stringify(
      { name: "fixture-renamed", version: "9.8.7" },
      null,
      2,
    )}\n`,
  );
  assert.notEqual(await fingerprint(root, options), first);
});

test("selected volatile JSON fields normalize without hiding shipped semantics", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, "payload", "release-package.json");
  const writeManifest = ({
    commit,
    date = "2026-01-01T00:00:00.000Z",
    format = "npm-package-tarball",
    tag,
    version = "26.1.0",
  }) =>
    writeFileSync(
      manifest,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          release: { sourceCommit: commit, sourceDate: date, tag, version },
          distribution: { format, platform: "any" },
        },
        null,
        2,
      )}\n`,
    );
  const options = {
    normalizeJsonField: [
      "payload/release-package.json=/release/sourceCommit",
      "payload/release-package.json=/release/sourceDate",
      "payload/release-package.json=/release/tag",
      "payload/release-package.json=/release/version",
    ],
  };

  writeManifest({ commit: "a".repeat(40), tag: "srn-openclaw-v26.1.0" });
  const first = await fingerprint(root, options);
  writeManifest({
    commit: "b".repeat(40),
    date: "2026-02-02T00:00:00.000Z",
    tag: "srn-openclaw-v26.2.0",
    version: "26.2.0",
  });
  assert.equal(await fingerprint(root, options), first);

  writeManifest({
    commit: "b".repeat(40),
    format: "changed-package-format",
    tag: "srn-openclaw-v26.2.0",
  });
  assert.notEqual(await fingerprint(root, options), first);
});

test("JSON normalization fails closed for missing, renamed, or non-string fields", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = path.join(root, "payload", "release-package.json");
  writeFileSync(manifest, '{"release":{"tag":42}}\n');

  await assert.rejects(
    fingerprint(root, {
      normalizeJsonField: ["payload/release-package.json=/release/tag"],
    }),
    /expected a string field/,
  );
  await assert.rejects(
    fingerprint(root, {
      normalizeJsonField: ["payload/release-package.json=/release/missing"],
    }),
    /field is missing/,
  );
  await assert.rejects(
    fingerprint(root, {
      normalizeJsonField: ["payload/renamed-release-package.json=/release/tag"],
    }),
    /normalized JSON document is not part of the fingerprint surface/,
  );
});

test("root traversal is rejected", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    fingerprintReleaseTree({ root, paths: ["../outside"] }),
    ReleaseTreeFingerprintError,
  );
});
