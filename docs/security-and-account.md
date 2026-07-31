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
  body="An MFA recovery code restores only the second factor. Account recovery is a separate, opt-in client flow that must be enabled before password loss and requires its own high-entropy code. Without the password, that account-recovery code, or an independently usable backup, an administrator cannot decrypt the account."
  link_url="/backups-and-recovery.html"
  link_text="Build a tested recovery procedure"
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

{% include safety-alert.html
  level="caution"
  title="The instance operator remains part of the security boundary"
  body="A server cannot read normal note ciphertext, but it controls sign-in responses, sessions, sync availability, server-delivered web code, and operational metadata. Verify the exact HTTPS host, keep clients updated, and do not enter account or recovery credentials into an instance you do not trust."
  link_url="/self-hosting.html#running-behind-a-reverse-proxy"
  link_text="Secure the public host"
%}

## Authentication controls

| Control | Purpose | Important boundary |
| --- | --- | --- |
| Account password | Sign-in and client key derivation | Do not reuse it or pass it to automation through command history |
| Two-factor authentication | Adds a server-side sign-in challenge | Save its MFA recovery code outside the account; it cannot replace the account password |
| Optional account recovery | Lets a signed-out client recover escrowed root-key material and rotate credentials | Enable it before password loss; its separate code can decrypt the escrow offline |
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
decrypt an account. Standard Red Notes instead ships an optional,
off-by-default recovery flow whose cryptographic work remains in the client.

### What must happen before password loss

While signed in, open **Preferences -> Security -> Account recovery**, enter the
current password, and enable recovery. The client:

1. validates the current password and obtains the active root key locally;
2. generates a separate high-entropy recovery secret;
3. encrypts a bounded root-key recovery record with that secret;
4. uploads only the versioned ciphertext escrow; and
5. shows one recovery code containing the account locator and secret exactly
   once.

Store that code in a protected password manager or offline recovery package,
separate from the Standard Red Notes account and the only backup. The recovery
secret and wrapping key are never sent to the server.

### Logged-out recovery and credential rotation

From the signed-out screen, choose **Recover account with an account recovery
code**. On a trusted computer, enter the complete code and a strong new password
twice. The client uses the code's high-entropy UUID locator to retrieve only the
bounded v2 ciphertext escrow, decrypts it locally, signs in with the recovered
root key, and changes the credentials through the normal authenticated,
compare-and-swap rotation path.

Successful credential rotation invalidates the old escrow and signs out other
sessions under the normal password-change contract; the newly issued recovery
session remains active. The client then creates a fresh
escrow and displays a replacement recovery code. If sign-in succeeds but
rotation or re-enrollment fails, the UI reports that partial outcome instead of
claiming complete recovery; finish the password change or enable recovery again
from Security preferences.

{% include safety-alert.html
  level="danger"
  title="Recovery deliberately widens the trust boundary"
  body="Anyone who obtains the recovery code can retrieve the ciphertext escrow and decrypt the account root key offline. MFA is still required for ordinary server sign-in, but it cannot protect a copied recovery code from offline decryption. Treat code exposure as account-key compromise and replace it immediately."
%}

### Recovery boundaries

- Recovery must be enabled before password loss. The server does not create an
  escrow automatically.
- A high-entropy UUID locator reduces account enumeration, but secrecy comes
  from the recovery secret in the full code.
- The server returns generic unavailable responses for absent, malformed, or
  legacy escrow; older escrow can be deleted but not used by this flow.
- Changing the account password invalidates the current escrow. Opt in again
  afterward only if you still accept the tradeoff.
- Replacing a code immediately invalidates the previous code. Disabling
  recovery deletes the server-side escrow and invalidates every issued code.
- Recovery is not a backup: it does not preserve deleted items, unsynced local
  changes, attachments outside the backup set, or an unavailable server.

A resilient safety net therefore includes:

1. a saved 2FA recovery code;
2. a known account password;
3. if opted in, the separate account-recovery code;
4. at least one current encrypted export; and
5. verified access to the backup’s password or other decryption material.

An administrator can reset a user’s server-side MFA state. That operation does
not recover the account encryption password.

## Recovery-code handling

- Label MFA recovery material and account-recovery material distinctly; they
  solve different problems.
- Display and copy either recovery code only in a private environment.
- Store it outside the Standard Red Notes account it protects.
- Prefer an offline password manager record or sealed recovery package.
- Replace account-recovery material immediately if it may have been exposed;
  rotate MFA recovery material through the appropriate MFA control.
- Test the documented recovery path before depending on it.

{% include safety-alert.html
  level="caution"
  title="Clipboard and local history can retain recovery material"
  body="A trusted browser session is not enough if the computer has malware, clipboard history, screen recording, cloud-synced clipboard, or an exposed terminal. Copy and use recovery material only on a secured device, clear transient copies, and rotate the code after suspected local compromise."
%}

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

{% include safety-alert.html
  level="danger"
  title="Revocation cannot erase a recipient's copy"
  body="Removing a member or public link prevents later authorized retrieval, but it cannot retract plaintext, screenshots, downloads, or model output already obtained by a recipient. Confirm the exact content and audience before sharing."
%}

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

{% include safety-alert.html
  level="danger"
  title="Do not expose internal services to the public network"
  body="Publishing MariaDB, Redis, internal APIs, Docker sockets, or an unauthenticated automation service can bypass the intended application boundary or expose availability-critical state. Bind only the documented front door and explicitly secured integration hosts."
  link_url="/operations-hardening.html#docker-image-and-runtime-hardening"
  link_text="Harden the runtime"
%}

For operator controls, continue with [Administration](administration.md). For
credential use in automation, see [MCP Bridge](mcp-bridge.md) and
[Workflows with n8n](workflows.md).
