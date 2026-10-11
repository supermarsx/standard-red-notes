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

test("a drifted audited file names two hashes that share a 12-character prefix", () => {
  // This diagnostic is the whole output of the gate that pins files by content
  // hash, and it is what somebody reads to decide "legitimate change, or a
  // regression being laundered by re-pinning?". It used to truncate both
  // hashes to twelve characters, so a tail-only difference printed
  // `changed (X -> X)`: two identical strings. Pin a hash that deliberately
  // shares a twelve-character prefix with the real one and require the
  // message to tell them apart.
  const auditedPath = Object.keys(manifest.forkAuditedFiles)[0];
  const actual = normalizedSha256(
    fs.readFileSync(path.join(repositoryRoot, auditedPath), "utf8"),
  );
  const prefix = actual.slice(0, 12);
  const filler = actual[12] === "0" ? "1" : "0";
  const pinned = `${prefix}${filler.repeat(64 - prefix.length)}`;
  assert.match(pinned, /^[a-f0-9]{64}$/);
  assert.equal(pinned.slice(0, 12), prefix);
  assert.notEqual(pinned, actual);
  assert.equal(pinned.slice(0, 12), actual.slice(0, 12));

  const drifted = structuredClone(manifest);
  drifted.forkAuditedFiles[auditedPath] = pinned;
  const message = validateManifest(drifted, repositoryRoot).find((diagnostic) =>
    diagnostic.includes("compatibility-audited content changed"),
  );
  assert.ok(message, "the drifted file must still be reported");

  // The guard: both hashes must be readable IN FULL, so no truncation can
  // collapse them into one string, whatever prefix they share.
  assert.ok(
    message.includes(pinned),
    `the pinned hash is not printed in full, so a reader cannot tell it from the actual one: ${message}`,
  );
  assert.ok(
    message.includes(actual),
    `the actual hash is not printed in full, so a reader cannot tell it from the pinned one: ${message}`,
  );
  const printedHashes = new Set(
    [...message.matchAll(/[a-f0-9]{12,}/g)].map(([run]) => run),
  );
  assert.ok(
    printedHashes.size >= 2,
    `the message prints the two hashes indistinguishably: ${message}`,
  );

  // And it must point at the content, not only at the digests: a pair of
  // hashes alone cannot answer the question the reader has.
  assert.ok(message.includes(auditedPath), message);
  assert.ok(
    message.includes(`git diff -- ${auditedPath}`),
    `the message must name the command that shows the change: ${message}`,
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
