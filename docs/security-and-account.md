---
title: Security and Account
description: Encryption boundaries, sign-in controls, recovery, scoped credentials, sharing risks, and operator security.
---

# Security and Account

Standard Red Notes combines client-side encryption with server-side identity,
authorization, abuse prevention, and availability controls. These layers solve
different problems.

{% include safety-alert.html
  level="danger"
  title="The account password is not recoverable by an administrator"
  body="MFA recovery codes can restore the second factor, but they do not decrypt notes or replace a forgotten account password. Keep the password and a tested encrypted backup independently recoverable before changing credentials."
  link_url="/backups-and-recovery.html"
  link_text="Build a recovery plan"
%}

## Trust boundary

The account password participates in deriving client encryption keys. Normal
note and item contents are encrypted before sync and decrypted by clients. The
server still necessarily handles operational metadata such as account identity,
sessions, timestamps, encrypted payload sizes, IP-derived security events, and
authorization records.

Some optional features intentionally widen the data path:

- A hosted AI provider receives the prompt and note/tool content supplied to
  that request.
- Public share recipients receive the content made available through the link.
- Server OCR receives the file pages configured for extraction.
- Email and Nextcloud backup delivery sends encrypted backup artifacts to those
  external systems.
- Plaintext desktop backups store readable content outside the encrypted
  account.

Enable those features only when their additional trust boundary is acceptable.

## Authentication controls

| Control | Purpose | Important boundary |
| --- | --- | --- |
| Account password | Sign-in and client key derivation | Do not reuse it or pass it to automation through command history |
| Two-factor authentication | Adds a server-side sign-in challenge | Save the recovery code outside the account |
| Trusted devices/push approval | Lets an existing trusted session approve a new challenge | Review and revoke old devices |
| App passcode | Locks a local application session and protects local key material | It does not replace the account password or server MFA |
| Local app-lock passkey | Adds another local unlock step on supported web/desktop clients | It requires an app passcode as a recovery factor; it is not an account passkey or encryption key |
| Session management | Lists and revokes signed-in clients | Revoke unknown sessions and rotate credentials after compromise |
| App password | Lets a non-interactive client pass the MFA gate | It never supplies the encryption key; the client still needs the real account password to decrypt |
| Full MCP token | Authenticates the bridge and unwraps the account’s items keys without the password | Treat it as decrypting access: use read-only mode where possible; selected-tag scope is not currently enforced; deletion does not terminate an already-issued session |

Use a dedicated app password or MCP token to avoid placing interactive MFA
material in automation. A full MCP token is still a high-impact decrypting
credential, not a less-sensitive substitute for the account password. For
access to only a subset of notes, use a dedicated automation account; the
current bridge does not enforce selected-tag scope.

## Recovery

There is no conventional administrator-readable password reset that can simply
decrypt an account. The normal safety net is:

1. a saved 2FA recovery code;
2. a known account password;
3. at least one current encrypted export; and
4. verified access to the backup’s password/key material.

The source tree contains optional, off-by-default account-recovery escrow
primitives. A signed-in client can create an escrow blob wrapped with a
high-entropy recovery secret, and a client service can decrypt a supplied blob.
The repository does **not** currently wire a verified logged-out flow that
retrieves that escrow, installs the recovered keys, changes credentials, and
signs the user back in. Treat this as incomplete/experimental substrate, not an
available forgotten-password recovery path. The default guidance remains:
without the known password and an independent usable backup, the encrypted
account is unrecoverable.

{% include safety-alert.html
  level="danger"
  title="Escrow is not a finished recovery path"
  body="Do not rely on or advertise the escrow primitives as recovery. Anyone who obtains both the server-side escrow and its recovery secret can decrypt the account key. Leave escrow disabled unless you are developing and independently validating the missing end-to-end flow."
%}

An administrator can reset a user’s server-side MFA state. That operation does
not recover the account encryption password.

## Recovery-code handling

- Display and copy a recovery code only in a private environment.
- Store it outside the Standard Red Notes account it protects.
- Prefer an offline password manager record or sealed recovery package.
- Replace the recovery material if it may have been exposed.
- Test the documented recovery path before depending on it.

## Protected notes and local locks

Protected-item access and app locks reduce accidental local disclosure. They do
not change what a deliberately unlocked client can decrypt, and they do not
prevent screen capture, clipboard capture, malware, or an authorized recipient
from copying content.

On supported web and desktop clients, the local passkey gate is an additional
app-lock factor. It can be registered only while an app passcode exists. If the
platform passkey later becomes unavailable, verify the app passcode and choose
the passcode fallback to disable that local passkey credential. Removing the app
passcode also disables and removes the passkey gate.

On mobile, biometric/keychain integrations and privacy-snapshot or secure-window
controls add platform protection. On desktop, OS keychain security and the
machine’s account security remain part of the boundary.

{% include safety-alert.html
  level="caution"
  title="An unlocked device can read unlocked notes"
  body="App locks and protected-item prompts reduce casual local exposure; they do not stop malware, screenshots, clipboard capture, memory inspection, or an authorized user from copying content. Use full-disk encryption, an OS login, timely screen locking, and device revocation together."
%}

## Public sharing and collaboration

Shared vaults preserve an authenticated membership and permission model.
Public links do not: possession of the link is the access mechanism. A
burn-after-reading link reduces repeated retrieval but cannot revoke a copy
already made by the first reader.

Before sharing:

- verify the exact note and attachment set;
- choose the narrowest vault permission;
- set expiry or burn behavior where available;
- transmit links through an appropriate channel; and
- revoke links and memberships that are no longer needed.

## Server-side security

Operators can use the Admin **Security** tab or `srn-admin` for:

- rate-limit tiers and adaptive escalation;
- IP block and allow lists;
- account lockout review and unlock;
- permanent, temporary, and shadow bans;
- reversible suspension;
- registration policy and approval;
- role/group/effective-permission review; and
- audit-log inspection.

Administrative actions are server-authorized. Hiding an admin control in the
web client is not sufficient authorization.

## Secrets and configuration

- Keep `.env`, server-settings overlays, app passwords, backup credentials,
  provider API keys, and MCP HTTP bearer tokens out of version control.
- Use long independent random values for JWT, valet, database, and shared-gate
  secrets.
- Terminate TLS at a trusted reverse proxy and preserve the real client IP only
  through explicitly trusted proxy hops.
- Do not expose database, Redis, internal service ports, or the Docker socket
  to untrusted networks. Put n8n on its own TLS hostname with its own login;
  never route it through the Standard Red Notes origin.
- Review audit logs after changes to users, roles, registration, security
  lists, feature gates, and service lifecycle.

For operator controls, continue with [Administration](administration.md). For
credential use in automation, see [MCP Bridge](mcp-bridge.md) and
[Workflows with n8n](workflows.md).
