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

test("root traversal is rejected", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(
    fingerprintReleaseTree({ root, paths: ["../outside"] }),
    ReleaseTreeFingerprintError,
  );
});
