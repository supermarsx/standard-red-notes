---
title: Sync and Data Lifecycle
description: How encrypted data moves between local clients, sync services, realtime delivery, revisions, and deletion.
---

# Sync and Data Lifecycle

Standard Red Notes is local-first: a client maintains local state, encrypts
account items before transmission, and reconciles them through the sync
service. WebSocket delivery reduces latency, but the sync protocol remains the
source of truth.

{% include mermaid.html %}

```mermaid
flowchart LR
  A[Edit local item] --> B[Encrypt on client]
  B --> C[Sync encrypted payload]
  C --> D[(Server item store)]
  D --> E[Realtime notification]
  E --> F[Other client syncs]
  F --> G[Decrypt locally]
```

## Data classes

| Data class | Local behavior | Server behavior |
| --- | --- | --- |
| Notes, tags, preferences, and vault metadata | Stored in the client database and decrypted for use | Encrypted item payloads are synchronized |
| Files | Encrypted/decrypted at the client boundary; temporary previews may exist on the device | Encrypted file bytes and transfer metadata are handled by the files service |
| Sessions and feature settings | Tokens or keys use platform-appropriate secure storage where available | Authentication, revocation, roles, limits, and gates are server-side |
| Revisions | Requested and decrypted by an authorized client | Historical encrypted item revisions are retained according to server policy |
| Local-only items | Exist only in the local client profile when marked before first upload | No server copy; the app refuses to newly mark an already-synced item local-only because suppressing future uploads cannot retract existing ciphertext |

## Local-only is a pre-upload boundary

Selective sync is safe only when chosen before an item first uploads. The
client enforces that boundary in the item mutator and in note, tag, folder, and
sync-preferences controls. Clearing local-only is always allowed and uploads the
item on the next sync.

Older clients may have allowed an already-synced item to be flagged local-only.
That stops later versions from uploading, but it does not erase the server copy
that already exists. Re-enable sync or treat that server copy according to the
server's normal deletion and retention policy; do not assume changing a local
flag remotely purged it.

## Normal sync cycle

1. A local edit marks an item dirty.
2. The client serializes and encrypts the item.
3. The sync request sends encrypted changes and a cursor/token describing the
   client’s last known server state.
4. The server validates authorization and shared-vault rules, stores accepted
   changes, and returns remote changes.
5. The client decrypts, validates, and persists the reconciled result.
6. Other connected clients receive a realtime hint and start their own sync.

Realtime is an accelerator. If WebSockets are unavailable or disabled for a
user, manual and periodic sync still work.

The browser prefers `SYNC_ITEMS` for ordinary account sync and `API_RPC` for
eligible authenticated JSON reads and the session-activity heartbeat once the
socket is ready. Authentication, token refresh and socket-ticket requests
bootstrap over HTTP. Download-only sync barriers also use HTTP so a read-only
check cannot recover or replay an older pending upload. File transfers have
their own transport, and checks explicitly testing HTTP keep using HTTP.
Seeing a connected socket does not mean every request uses it. A request
refused before execution may safely fall back; an uncertain write must first
be reconciled using its durable command identity.

Failed commands that roll back before committing no longer retain an accepted
journal entry. For entries left behind by older builds, a status read can remove
an accepted, unclaimed entry after a 30-second grace period. The SQL predicate
preserves in-flight claims and committed results; clients then reconcile and
retry using the original command identity instead of dropping an uncertain write.

## Offline work

Edits can remain local while the network or server is unavailable. Before
signing out, deleting a browser profile, uninstalling a client, or replacing a
device:

1. Reconnect to the intended server.
2. Wait for sync to become idle and healthy.
3. Open several recently edited notes on another client.
4. Create an encrypted export.

Never assume that a visible local edit has reached the server merely because
the editor accepted it.

## Conflicts

Concurrent edits can produce a conflict when the client cannot safely merge
two versions. Preserve both versions until the intended content is confirmed.
A safe resolution sequence is:

1. Stop editing the note on other clients.
2. Copy both variants into temporary notes or an external encrypted workspace.
3. Compare them and create one authoritative version.
4. Sync that version, then confirm it on a second client.
5. Remove conflict copies only after verification.

Repeated conflicts usually point to a client that is offline for long periods,
an unstable connection, a stale session, or incompatible client versions.

## Shared vault sync

Shared-vault items carry a vault association. Server save rules enforce the
member’s `read`, `write`, or `admin` permission before accepting changes. A
client-side button is not the security boundary.

Membership changes can make locally cached content inaccessible. Removing a
member prevents future authorized sync, but it cannot make a recipient forget
plaintext they already saw or copied. See [Sharing and
Collaboration](sharing-and-collaboration.md).

## Revisions, trash, and deletion

These are separate recovery layers:

- **Revision history** preserves prior encrypted versions according to server
  policy and account entitlements.
- **Trash** is an application state that allows normal restoration before
  permanent deletion.
- **Permanent deletion** emits a deletion through sync so other clients remove
  the item.
- **Backups** are independent copies and may retain data after deletion from
  the live account.

Deletion from the live account does not automatically erase desktop backup
folders, exports, database dumps, email attachments, Nextcloud copies, recipient
devices, or logs that intentionally contain metadata. Retention must be handled
at every layer.

### Revision retention and automatic checkpoints

By default, each note keeps at most **200 revisions**, and revisions older than
**900 days** are removed. Both bounds apply: the newest 200 are not kept forever,
and a note cannot accumulate unlimited revisions within the 900-day window.

In **Settings → Admin → Server → Revision history**, an administrator can change
the count and age bounds, add total revision-count and encrypted-storage caps
per user and for the whole server, and tune automatic checkpoint creation.
An individual account's **Users → Manage → Storage → Revision history limits**
section can impose tighter account bounds. A user override cannot bypass a
server cap. Zero removes that additional limit; clearing an override restores
the environment/default or inherited server value. Total count/storage caps
default to unlimited; the per-note 200/900 defaults still bound each note.

Updated clients mark title/body/comment changes separately from changes to
preview text, timestamps and collaboration bookkeeping. Only an advisory
`automatic` or `metadata` marker is sent; comparisons stay on the device, and
no plaintext or content fingerprint is disclosed. Unknown or oversized content
is conservatively treated as a content change. Older clients remain supported.

Automatic saves within **30 seconds** of the previous save are combined into
the latest checkpoint, up to **5 minutes** of continuous editing. A longer idle
gap starts a new checkpoint. Author and encryption-context changes remain
separate. Combined entries are labelled **Automatic checkpoint** with the
number of saves combined. The latest checkpoint can continue updating during
that window; previous checkpoints remain available. Duplicate or older dump
deliveries do not replace newer content.

Limits are enforced transactionally when history is written or copied, across
all workers. Oldest revisions are removed first. A snapshot larger than its
entire account or server byte cap is skipped, preserving smaller existing
revisions. Storage counts UTF-8 bytes of
encrypted content, encrypted item keys and authentication hashes, matching the
revision-storage measurement; database/index overhead is excluded. These limits
apply to revision history, not current notes or the separate file-upload quota.
A rotating sweep also prunes inactive notes in batches of 100 each minute;
existing history converges to changed limits without requiring another edit.
Lowering limits permanently removes excess history.

Environment baselines are `REVISIONS_MAX_COUNT_PER_ITEM=200`,
`REVISIONS_RETENTION_DAYS=900`, `REVISIONS_MAX_COUNT_PER_USER=0`,
`REVISIONS_MAX_BYTES_PER_USER=0`, `REVISIONS_MAX_COUNT_TOTAL=0`,
`REVISIONS_MAX_BYTES_TOTAL=0`, `REVISIONS_DEBOUNCE_SECONDS=30`, and
`REVISIONS_CHECKPOINT_SECONDS=300`. Admin overrides are persisted under
`revisions` in the shared `SERVER_SETTINGS_PATH` and apply without a restart.
Both bundled Compose deployments expose these variables. Deploy the revisions
service migration before starting its workers when services are managed
separately.

## Files

Files use dedicated upload/download flows rather than being embedded in a note
sync payload. When diagnosing a file problem, separate:

- the note or file metadata item;
- the encrypted blob in the file store;
- a temporary client-side decrypted preview; and
- a desktop file-backup copy.

A synchronized file reference with a missing blob is not a complete backup.
Recovery drills should include opening representative attachments.

## Sync health checks

- In a graphical client, inspect sync status and retry after confirming the
  server URL and network.
- In MCP, call `standard_red_notes_status`; it reports sign-in state,
  background-sync failures, and the last sync error.
- For the server edge, run `srn-server health --url <base-url>`.
- For internal service dependencies, use `srn-admin status` or the Admin
  **Server** tab; readiness can distinguish a running process from a service
  that cannot reach Redis or its database.

For incident diagnosis, see [Monitoring and
Troubleshooting](monitoring-and-troubleshooting.md). For independent copies,
see [Backups and Recovery](backups-and-recovery.md).
