import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DOCUMENT_PATH,
  MANIFEST_PATH,
  normalizedSha256,
  validateCompatibilityDocument,
  validateManifest,
} from "./validate-standard-notes-compatibility.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, MANIFEST_PATH), "utf8"),
);

test("normalizes line endings before hashing audited source", () => {
  assert.equal(
    normalizedSha256("one\r\ntwo\r\n"),
    normalizedSha256("one\ntwo\n"),
  );
});

test("pins the audited fork and upstream-parity source files", () => {
  assert.deepEqual(validateManifest(manifest, repositoryRoot), []);

  const drifted = structuredClone(manifest);
  const auditedPath = Object.keys(drifted.forkAuditedFiles)[0];
  drifted.forkAuditedFiles[auditedPath] = "0".repeat(64);
  assert.match(
    validateManifest(drifted, repositoryRoot).join("\n"),
    /compatibility-audited content changed/,
  );
});

test("requires explicit interoperability limits in the compatibility matrix", () => {
  const markdown = fs.readFileSync(
    path.join(repositoryRoot, DOCUMENT_PATH),
    "utf8",
  );
  assert.deepEqual(validateCompatibilityDocument(markdown, manifest), []);

  const withoutKnownFolderFailure = markdown.replaceAll(
    "content_type_error",
    "generic conflict",
  );
  assert.match(
    validateCompatibilityDocument(withoutKnownFolderFailure, manifest).join(
      "\n",
    ),
    /known upstream Folder rejection/,
  );

  const overclaimed = `${markdown}\n| Original Standard Notes client | <span class="compatibility-badge compatibility-badge--confirmed">Confirmed</span> | Unsafe claim |\n`;
  assert.match(
    validateCompatibilityDocument(overclaimed, manifest).join("\n"),
    /may not be marked Confirmed/,
  );

  const mislabeledFailure = markdown.replaceAll(
    'compatibility-badge compatibility-badge--incompatible">Known incompatible boundary',
    'compatibility-badge compatibility-badge--unverified">Known incompatible boundary',
  );
  assert.match(
    validateCompatibilityDocument(mislabeledFailure, manifest).join("\n"),
    /must use the danger badge/,
  );
});
