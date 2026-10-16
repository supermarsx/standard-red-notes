// Diagnostic for a KNOWN UNFIXED bug: success confirms the failure exists.
// Not a production command or a passing-health CI gate. Uses synthetic data only.
// Read-only source probe; run from repository root:
// node scripts/audit-private-comment-concurrency.cjs
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const repo = path.resolve(__dirname, "..");
const appRequire = createRequire(path.join(repo, "app/package.json"));
const ts = appRequire("typescript");
require.extensions[".ts"] = (mod, file) => {
  const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  mod._compile(code, file);
};
const source = path.join(repo, "app/packages/models/src/Domain");
const { ConflictDelta } = require(
  path.join(source, "Runtime/Deltas/Conflict.ts"),
);
const { PayloadCollection } = require(
  path.join(source, "Runtime/Collection/Payload/PayloadCollection.ts"),
);
const { ImmutablePayloadCollection } = require(
  path.join(source, "Runtime/Collection/Payload/ImmutablePayloadCollection.ts"),
);
const { DecryptedPayload } = require(
  path.join(source, "Abstract/Payload/Implementations/DecryptedPayload.ts"),
);
const { SNUserPrefs } = require(
  path.join(source, "Syncable/UserPrefs/UserPrefs.ts"),
);
const { ContentType } = appRequire("@standardnotes/domain-core");
const domain = "org.standardnotes.sn";
const key = "privateNoteComments";
const record = (id, text) => ({
  id,
  text,
  authorUuid: "user",
  authorName: "You",
  createdAt: "2026-10-16T00:00:00.000Z",
});
const make = (notes, timestamp) =>
  new DecryptedPayload({
    uuid: "one-personal-preference-item",
    content_type: ContentType.TYPES.UserPrefs,
    created_at: new Date(0),
    updated_at: new Date(timestamp),
    updated_at_timestamp: timestamp,
    dirty: true,
    dirtyIndex: 1,
    content: {
      references: [],
      appData: {
        [domain]: { [key]: { version: 1, ownerUuid: "user", notes } },
      },
    },
  });
function resolve(localNotes, remoteNotes) {
  const local = make(localNotes, 20);
  const remote = make(remoteNotes, 10);
  const collection = new PayloadCollection();
  collection.set(local);
  const delta = new ConflictDelta(
    ImmutablePayloadCollection.FromCollection(collection),
    local,
    remote,
    {},
  );
  const result = delta.result();
  assert.equal(result.emits.length, 1, "no recoverable duplicate emitted");
  const notes = new SNUserPrefs(result.emits[0]).getPref(key).notes;
  assert.deepEqual(
    notes,
    localNotes,
    "singleton conflict preserves only local preference map",
  );
  return notes;
}
const a = record("comment-a", "device A comment");
const b = record("comment-b", "device B comment");
const original = record("old-comment", "old text");
const additions = resolve({ "note-a": [a] }, { "note-b": [b] });
assert.equal(additions["note-b"], undefined);
console.log(
  "CONFIRMED: concurrent additions to different notes lose the remote comment; no duplicate is retained.",
);
const deletedElsewhere = resolve({ "note-a": [original, a] }, {});
assert.equal(deletedElsewhere["note-a"][0].id, original.id);
console.log(
  "CONFIRMED: a stale local addition can restore a comment purged on another device.",
);
const localPurge = resolve({}, { "note-b": [b] });
assert.deepEqual(localPurge, {});
console.log(
  "CONFIRMED: a local purge snapshot can discard a concurrent remote addition.",
);
console.log(
  "Read-only source probe passed all 3 scenarios. No server or user data was accessed.",
);
