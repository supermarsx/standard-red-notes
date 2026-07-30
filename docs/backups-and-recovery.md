---
title: Backups and Recovery
description: A layered backup and restore strategy for accounts, desktop data, files, and self-hosted infrastructure.
---

# Backups and Recovery

Sync is not a backup. Sync propagates both desired changes and mistakes; a
backup is an independent, restorable copy with a known retention policy.

{% include mermaid.html %}

```mermaid
flowchart TD
  A[Live encrypted account] --> B[User export]
  A --> C[Desktop automatic backup]
  A --> D[Email or Nextcloud encrypted backup]
  E[Database and file volumes] --> F[Infrastructure backup]
  B --> G[Restore drill]
  C --> G
  D --> G
  F --> H[Whole-service restore drill]
```

## Backup layers

| Layer | Protects against | Does not by itself protect against |
| --- | --- | --- |
| Encrypted account export | Accidental deletion, client loss, account migration | Forgotten export password/key, missing external files if not included |
| Decrypted export | Easy content-level recovery | Disclosure if the file or storage is compromised |
| Desktop encrypted text backup | Frequent local note recovery | Loss of the same computer/disk |
| Desktop plaintext backup | Simple inspection and emergency recovery | Any attacker who can read the folder |
| Desktop file backup | Attachment recovery | Notes, tags, account settings, or server identity |
| Email encrypted backup | Off-device encrypted account copy | Mailbox loss, mail retention, or forgotten decryption material |
| Nextcloud/WebDAV encrypted backup | Scheduled off-server encrypted copy | Nextcloud account loss or incomplete WebDAV configuration |
| Database and volume backup | Whole self-hosted service recovery | Client-only unsynchronized edits or unknown application secrets |

Use at least one user-level export and one infrastructure-level backup for a
self-hosted deployment.

## Manual account exports

The client supports encrypted and decrypted data exports and import. Prefer an
encrypted export for routine retention:

1. Run a full sync.
2. Export the account data.
3. Move the file to independent storage.
4. Record the client/server version and export date.
5. Verify the archive can be opened or imported in an isolated test account.

A decrypted export should be treated as sensitive plaintext. Encrypt the
storage medium or place the export in a separately encrypted archive, and
delete temporary copies after verification.

The `srn-client export` command can also create JSON or Markdown exports. Its
output is decrypted and therefore inherits the same plaintext handling rules.

## Desktop automatic backups

The desktop client exposes separate backup paths:

- automatic encrypted text backups;
- optional plaintext backups;
- attachment/file backups; and
- a cross-platform backup decryption drop zone.

Keep the destination outside application data so uninstalling the client does
not remove the only copy. For stronger resilience, replicate the folder to an
offline or separately authenticated destination.

## Email backups

Email backups are available only when the server enables them and the account
is entitled/configured. They are scheduled encrypted artifacts, not plaintext
messages containing every note.

Before depending on email delivery:

- verify `EMAIL_BACKUPS_ENABLED` is effective;
- confirm outbound mail works;
- inspect the received attachment;
- understand mailbox retention and attachment-size limits; and
- complete a test decrypt/import.

## Nextcloud/WebDAV backups

Nextcloud backups use encrypted server-generated backup blobs uploaded over
WebDAV. Both the server master switch and complete per-user settings are
required:

- Nextcloud base URL;
- destination folder;
- dedicated app password; and
- backup frequency.

Create a low-privilege Nextcloud app password rather than reusing the main
account password. The app password is sensitive server-side configuration and
is not returned by the administrator settings API.

The WebDAV client includes SSRF defenses, but operators must still restrict
network reachability and approve the destination. After configuration, verify a
new file appears and perform a restore drill.

## Self-hosted infrastructure backups

Back up these together:

- MariaDB/MySQL data;
- Redis only if the deployment deliberately relies on persistent Redis state;
- encrypted file-storage volumes or object storage;
- server settings and non-secret configuration;
- the exact secrets needed to validate sessions and decrypt protected
  configuration; and
- deployment manifests and image/version identifiers.

Do not store the only copy of `.env` beside the live host. Protect database
credentials, JWT secrets, valet secrets, shared access keys, SMTP credentials,
provider keys, and backup app passwords.

The repository’s `yarn ops:backup-restore` gate exercises the scripted backup
and restore contract. It is validation evidence, not a substitute for restoring
your own production-size data on your own storage.

## Restore order

For a whole-server recovery:

1. Stop application writes.
2. Preserve the failed state for investigation.
3. Restore configuration and secrets.
4. Restore the database.
5. Restore encrypted file storage.
6. Start dependencies, then application services.
7. Run liveness and readiness checks.
8. Sign in with a test account and open representative notes, revisions, and
   files.
9. Re-enable external traffic.
10. Confirm scheduled backups run again.

Follow the exact commands in [Self-Hosting](self-hosting.md) and
[Operations Hardening](operations-hardening.md) for the deployed profile.

> ⚠️ Do not run `srn-server down --yes --volumes` during a restore unless the
> named volumes have been verified and independent backups exist. The
> `--volumes` option destroys persistent data.

## Recovery drills

A useful quarterly drill proves:

- the backup exists outside the live failure domain;
- checksums or archive integrity pass;
- the required password and secrets are available;
- notes, tags, revisions, and representative attachments open;
- a restored client can sync without overwriting production; and
- the measured recovery time meets the service objective.

Record the date, backup identifier, restore duration, gaps found, and corrective
action. A backup that has never been restored is only an assumption.

## Retention and deletion

Live-account deletion does not remove independent copies. Define retention for
desktop folders, exports, email, Nextcloud, database snapshots, object storage,
and disaster-recovery replicas. When a deletion request must cover backups,
document whether the copy is immediately purged or expires through normal
rotation.
