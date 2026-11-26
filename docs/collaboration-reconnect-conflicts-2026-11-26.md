# Collaboration presence and own-note conflict investigation — 26 November 2026

## Reproduced: lease renewal looked like an editor leaving and returning

`EncryptedYjsProvider.attachActiveLease` activates a renewed editor lease and sends
its first presence heartbeat before releasing the previous lease. The Yjs client ID
and socket are unchanged, but the gateway assigns the renewed lease a new presence ID.

`EphemeralRoomPresence.acceptJoined` previously rejected that announcement because
the old presence already occupied the client ID. The old lease's subsequent
`clean-leave` removed the old presence and announced a departure. The next heartbeat
made the replacement look like a new arrival. This happens during ordinary lease
renewal and does **not** establish that the physical WebSocket closed.

The regression test reproduces the gateway ordering: old join, replacement join
with the same client and account, old leave, replacement heartbeat. It failed before
the fix. Renewal now transfers presence continuity without removing awareness or
announcing a departure/arrival. An obsolete leave cannot remove the new presence.
Client-ID reuse by a different authenticated account is still refused. A lease
replacement also no longer triggers a newcomer full-document response.

## Reproduced: another session on this account was announced as a collaborator

Presence excluded the current Yjs client ID, rather than every session belonging to
the signed-in account. Another tab or device therefore reached the notification
renderer with this user's own identity. Notifications now compare stable account
UUIDs. Matching display names alone never suppress another user's notifications.
Other sessions still participate in awareness, collaboration and saver election.

## Reproduced: an acknowledged own save manufactured a sync conflict

`DeltaRemoteRetrieved` processed `itemsSavedOrSaving` before the known-stale echo
check. In addition, `ServerSyncResponseResolver` did not provide its `saved_items`
acknowledgements to that delta. A local edit made during an upload therefore met
its own previous uploaded content as an apparent competing revision. With an older
user-edit timestamp and no matching history entry, ordinary conflict resolution
created a copy of the newer local edit and emitted the older body at the note UUID.

Known-stale decrypted retrievals are now recognized while an upload is in flight.
A matching acknowledgement additionally establishes coverage up to its positive,
safe-integer server timestamp. This requires the UUID to belong to the operation's
saved/saving payloads, and matching content type, vault and key-system identity.
The complete resolver regression verifies that the newest local body remains at
its original UUID, remains dirty, and adopts the acknowledged server timestamp.

The saved/saving UUID list spans multiple response pages, including items already
acknowledged and clean. That UUID alone no longer makes a clean saved note conflict
with a normal newer peer update. Older page echoes are ignored, while body-stripped
lazy-loaded notes still hydrate from a full retrieval.

Newer peer writes, unknown writes, missing timestamps, deleted acknowledgements,
and mismatched UUID/type/vault/key identity still take ordinary conflict handling.
The CRDT revision-stamp policy and its insertion/deletion ancestry checks remain
in force for collaborative bodies; no timestamp or body hash alone is used to
discard a genuinely newer unproved revision.

A second resolver regression reproduced an older save acknowledgement overwriting
the result of a genuinely newer peer retrieval later in the same response. Saved
note metadata is now ignored when it is behind a readable retrieved revision or
the current note. This keeps the newer server clock and the legitimate conflict
copy, and prevents a late acknowledgement from clearing newer pending work.

## Actual connection loss is a separate event

The gateway still uses WebSocket ping/pong health checks. The collaboration/push
client and sync worker also detect unanswered application heartbeats and reconnect
with backoff. Session revocation, protocol refusal, server shutdown, network loss,
browser suspension and operating-system sleep can still end a connection.

Room presence has a 45-second TTL and normally refreshes three times per TTL.
The provider already restarts heartbeats on visibility restoration. A suspended
page can miss that TTL while its underlying socket remains open; presence expiry,
room lease expiry and physical socket closure must not be treated as synonyms.

There was no running local Standard Red Notes gateway container or captured close
event from the reported session during this investigation. These are reproducible
source/runtime findings, not a claim to have captured the production network
failure or verified a deployed build. The existing sync diagnostics distinguish
heartbeat/ack deadlines, server policy/protocol refusals and connection loss;
correlating those readings with a recurrence can identify an additional actual
socket failure after the presence fixes.

## Regression coverage

- Presence lease handoff, obsolete leaves, client/account collision, reconnect grace,
  own-account notification suppression and encrypted provider lifecycle.
- Dirty self echoes during uploads and with acknowledgements, newer peer writes,
  legacy timestamps, vault/key/type mismatch and complete sync-response application.
- Accordion insertion, preservation of selected block formatting, undo, repeated
  open/close persistence, reload and read-only viewing without document mutation.

Local validation passed: 357 model tests, 157 collaboration/editor tests, 93
push-socket tests, 76 selected sync-worker heartbeat/reauthentication/reconnect
tests, and four complete sync-response regressions. The models build, web and
sync TypeScript checks, scoped lint, styles and whitespace checks passed.
