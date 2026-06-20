# HTTP API reference

This document describes the HTTP API exposed by a self-hosted **Standard Red
Notes** server. It is generated from the source of truth in this repository:

- The API gateway route map —
  [`server/packages/api-gateway/src/Service/Resolver/EndpointResolver.ts`](../server/packages/api-gateway/src/Service/Resolver/EndpointResolver.ts)
  and the gateway controllers under
  [`server/packages/api-gateway/src/Controller`](../server/packages/api-gateway/src/Controller).
- The client path map the official clients actually call —
  [`app/packages/snjs/lib/Services/Api/Paths.ts`](../app/packages/snjs/lib/Services/Api/Paths.ts)
  and the published `@standardnotes/api` `Server/*/Paths.ts` modules.
- The auth and syncing-server controllers under
  [`server/packages/auth/src/Controller`](../server/packages/auth/src/Controller)
  and `server/packages/syncing-server`.

> Everything here is documented from real code paths. Endpoints unique to this
> fork are marked **(Standard Red Notes)**.

## Contents

- [Base URL and versioning](#base-url-and-versioning)
- [Authentication model](#authentication-model)
- [How to call the API](#how-to-call-the-api-curl)
- [End-to-end encryption implications](#end-to-end-encryption-implications)
- [Endpoints](#endpoints)
  - [Authentication and sessions](#authentication-and-sessions)
  - [Account recovery](#account-recovery)
  - [Users, settings and features](#users-settings-and-features)
  - [Sync and items](#sync-and-items)
  - [Revisions](#revisions)
  - [Files](#files)
  - [WebSocket realtime](#websocket-realtime)
  - [Subscriptions and offline tokens](#subscriptions-and-offline-tokens)
  - [Two-factor: authenticators and magic link](#two-factor-authenticators-and-magic-link)
  - [Collaboration: shared vaults, invites, messages](#collaboration-shared-vaults-invites-messages)
  - [App passwords (Standard Red Notes)](#app-passwords-standard-red-notes)
  - [MCP tokens (Standard Red Notes)](#mcp-tokens-standard-red-notes)
  - [Trusted devices and push MFA (Standard Red Notes)](#trusted-devices-and-push-mfa-standard-red-notes)
  - [Public share links (Standard Red Notes)](#public-share-links-standard-red-notes)
  - [Dead man's switches (Standard Red Notes)](#dead-mans-switches-standard-red-notes)
  - [Email reminders (Standard Red Notes)](#email-reminders-standard-red-notes)
  - [AI assistant proxy (Standard Red Notes)](#ai-assistant-proxy-standard-red-notes)
  - [Integrations (Standard Red Notes)](#integrations-standard-red-notes)
  - [Admin (Standard Red Notes)](#admin-standard-red-notes)
  - [Server metadata](#server-metadata)

## Base URL and versioning

All requests go to the **API gateway**. In the bundled Docker stack the gateway
listens on `http://localhost:3000`; the static web client is served separately
(`http://localhost:3001`) and the files service on `http://localhost:3125`. In a
production deployment you put a reverse proxy in front of the gateway and use
your own domain. The examples below use `$SERVER` for the gateway origin:

```bash
export SERVER="http://localhost:3000"
```

Paths are versioned by a leading `/v1` or `/v2` segment. The clients send a
payload-level API version field too (`api_version`), defined in
[`app/packages/api/src/Domain/Api/ApiVersion.ts`](../app/packages/api/src/Domain/Api/ApiVersion.ts):
`v0 = 20200115`, `v1 = 20240226`. The legacy snjs client sends `20240226`.

The current sign-in flow is `/v2` (PKCE). The older `/v1/login` path still
exists and resolves to the same PKCE handler on the gateway.

## Authentication model

Standard Red Notes uses the Standard Notes authentication protocol. The account
password is **never** sent to the server as-is and is **never** used to decrypt
on the server. The high-level flow:

1. **Key params (PKCE).** The client generates a random `code_verifier`, derives
   `code_challenge = base64url(sha256(code_verifier))`, and calls
   `POST /v2/login-params` with the email and the `code_challenge`. The server
   returns the account's **key params** (KDF algorithm, salt/nonce, iterations).
2. **Local key derivation.** The client derives the root key from the user's
   password + key params **on device** (argon2). It splits that into a "server
   password" (used only to prove knowledge to the server) and a master key
   (never leaves the device, used to encrypt/decrypt items).
3. **Sign in (PKCE).** The client calls `POST /v2/login` with the email, the
   `password` (the derived *server password*, not the user's password), and the
   `code_verifier`. On success the server returns a **session** containing an
   `access_token` and a `refresh_token`, plus the account's key params and user
   object.
4. **Authenticated requests.** Bearer the access token:
   `Authorization: Bearer <access_token>`. The
   [`FetchRequestHandler`](../app/packages/api/src/Domain/Http/FetchRequestHandler.ts)
   sets this header from the session access token. Browser clients additionally
   rely on session cookies set by the server (see the self-hosting guide on
   cookie configuration).
5. **Refresh.** When the access token expires, call
   `POST /v1/sessions/refresh` with `{ access_token, refresh_token }` to receive
   a new pair. The session body shape is in
   [`SessionRefreshResponseBody.ts`](../app/packages/api/src/Domain/Response/Auth/SessionRefreshResponseBody.ts):
   `{ session: { access_token, refresh_token, access_expiration, refresh_expiration, readonly_access } }`.

### Obtaining access (credentials and tokens)

- **Account credentials** — email + password (registered via `POST /v1/users`)
  are the primary way to obtain a session. Two-factor (TOTP authenticator or
  email magic link) may be required as a second factor at sign-in.
- **App passwords (Standard Red Notes)** — a per-account secret that satisfies
  the interactive 2FA challenge for a single sign-in, so headless clients do not
  need a live TOTP code. The account password is still required. See
  [App passwords](#app-passwords-standard-red-notes).
- **MCP tokens (Standard Red Notes)** — a scoped credential (`<uuid>.<secret>`)
  that authenticates without the account email/password and returns
  client-side-wrapped items keys in one round trip. Intended for the MCP bridge.
  See [MCP tokens](#mcp-tokens-standard-red-notes).
- **Trusted devices (Standard Red Notes)** — a per-device token that bypasses
  *only* the 2FA gate (never the account password) on future sign-ins. See
  [Trusted devices](#trusted-devices-and-push-mfa-standard-red-notes).

## How to call the API (curl)

The full sign-in flow requires deriving the server password locally (argon2),
so the simplest faithful client is the bundled `srn-client` CLI (see
[`cli/srn-client`](../cli/srn-client/README.md)), which runs the real protocol
via an embedded snjs client. The raw HTTP sketch below shows the request/response
shapes; replace the derivation step with the snjs/`srn-client` logic for a real
call.

```bash
SERVER="http://localhost:3000"
EMAIL="me@example.com"

# 1) Get key params (PKCE). Generate a code_verifier and its SHA-256 challenge.
#    (Pseudocode: code_challenge = base64url(sha256(code_verifier)))
curl -s -X POST "$SERVER/v2/login-params" \
  -H 'Content-Type: application/json' \
  -d "{\"api_version\":\"20240226\",\"email\":\"$EMAIL\",\"code_challenge\":\"<challenge>\"}"
# -> { "identifier": ..., "pw_nonce": ..., "version": ..., ... key params }

# 2) Derive the root key locally from your password + key params (argon2),
#    split into the server password. Then sign in:
curl -s -X POST "$SERVER/v2/login" \
  -H 'Content-Type: application/json' \
  -d "{\"api_version\":\"20240226\",\"email\":\"$EMAIL\",\"password\":\"<server_password>\",\"code_verifier\":\"<code_verifier>\",\"ephemeral\":false}"
# -> { "session": { "access_token": "...", "refresh_token": "...", ... },
#      "key_params": { ... }, "user": { ... } }

# 3) Make an authenticated request with the access token:
ACCESS_TOKEN="<from step 2>"
curl -s -X GET "$SERVER/v1/sessions" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
# -> [ { "uuid": ..., "api_version": ..., "user_agent": ..., ... }, ... ]
```

## End-to-end encryption implications

Item payloads are **ciphertext**. When you push items to `POST /v1/items` the
`content` and `enc_item_key` fields are already encrypted on the client with
keys derived from the account password; the server stores and relays them
without being able to read them. Likewise file contents, share payloads, and
MCP key material are stored as ciphertext or as opaque client-side wrappings.

Practical consequences when talking to the API directly:

- You cannot construct a valid item payload server-side — you must encrypt with
  the user's keys (use snjs / `srn-client`).
- The server-visible metadata is limited: item `uuid`, `content_type`,
  `created_at`/`updated_at` timestamps, item existence and size, the account
  email, and session/device info. It cannot see note titles or contents.
- Public share links store only ciphertext keyed by a `shareId`; the decryption
  key lives in the link fragment and never reaches the server.

---

## Endpoints

Notation: each entry shows the **client-facing method + path** (what you call on
the gateway). The "Resolver id" is the internal identifier the gateway maps the
route to in
[`EndpointResolver.ts`](../server/packages/api-gateway/src/Service/Resolver/EndpointResolver.ts);
it is included for traceability. Unless noted, request/response bodies are JSON.
Authenticated endpoints require `Authorization: Bearer <access_token>` (and, for
browser sessions, the session cookies).

### Authentication and sessions

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| POST | `/v2/login` | `auth.pkceSignIn` | PKCE sign-in. Body: `email`, `password` (derived server password), `code_verifier`, `ephemeral`, optional `hvm_token`, `workspace_identifier`. Returns `{ session, key_params, user }`. |
| POST | `/v2/login-params` | `auth.pkceParams` | PKCE key params. Body: `api_version`, `email`, `code_challenge`, optional `mfa_code`, `app_password`, `trusted_device_token`, `workspace_identifier`. Returns the account key params. |
| POST | `/v1/login` | `auth.pkceSignIn` | Legacy alias for PKCE sign-in (same handler as `/v2/login`). |
| GET  | `/v1/login-params` | `auth.pkceParams` | Legacy alias for key params. Optional cross-service token. |
| POST | `/v1/logout` | `auth.signOut` | Sign out the current session. |
| GET  | `/v1/sessions` | `auth.sessions.list` | List the user's active sessions. Authenticated. |
| DELETE | `/v1/sessions/:uuid` | `auth.sessions.delete` | Revoke a specific session. Authenticated. |
| DELETE | `/v1/sessions` | `auth.sessions.deleteAll` | Revoke all other sessions. Authenticated. |
| POST | `/v1/sessions/refresh` | `auth.sessions.refresh` | Body: `access_token`, `refresh_token`. Returns a refreshed session pair. |
| POST | `sessions/validate` | `auth.sessions.validate` | Internal: session validation used by gateway middleware. |

### Account recovery

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| POST | `/v1/recovery/codes` | `auth.generateRecoveryCodes` | Generate recovery codes. Requires cross-service token + `x-server-password` header. |
| POST | `/v1/recovery/login` | `auth.signInWithRecoveryCodes` | Body: `api_version`, `username`, `password`, `code_verifier`, `recovery_codes`, optional `hvm_token`. |
| POST | `/v1/recovery/login-params` | `auth.recoveryKeyParams` | Body: `api_version`, `username`, `code_challenge`, `recovery_codes`. |

### Users, settings and features

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| POST | `/v1/users` (`POST /auth`) | `auth.users.register` | Register. Body: key params content + `email`, `password` (server password), `api_version`, `ephemeral`, optional `hvm_token`. Returns a session. |
| PUT | `/v1/users/:userUuid/attributes/credentials` | `auth.users.updateCredentials` | Change email/password (re-wraps keys). Authenticated. |
| DELETE | `/v1/users/:userUuid` | `auth.users.delete` | Delete the account. |
| GET | `/v1/users/:userUuid/settings` | `auth.users.getSettings` | List the user's settings. |
| PUT | `/v1/users/:userUuid/settings` | `auth.users.updateSetting` | Upsert a setting (`name`, `value`). |
| GET | `/v1/users/:userUuid/settings/:settingName` | `auth.users.getSetting` | Read one setting. |
| DELETE | `/v1/users/:userUuid/settings/:settingName` | `auth.users.deleteSetting` | Delete one setting. |
| PUT | `/v1/users/:userUuid/subscription-settings` | `auth.users.updateSubscriptionSetting` | Update a subscription setting. |
| GET | `/v1/users/:userUuid/subscription-settings/:subscriptionSettingName` | `auth.users.getSubscriptionSetting` | Read one subscription setting. |
| GET | `/v1/users/:userUuid/features` | `auth.users.getFeatures` | List the account's feature entitlements (all included in this fork). |
| GET | `/v1/users/:userUuid/subscription` | `auth.users.getSubscription` | Read the account subscription (synthetic full-access in this fork). |
| GET | `/v1/users/:userUuid/mfa-secret` | `auth.users.getMfaSecret` | Read the MFA secret. Authenticated. |
| POST | `/v1/users/:userUuid/requests` | `auth.users.createRequest` | Create a user request (e.g. account-deletion / data export request). |

### Sync and items

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| POST | `/v1/items` | `sync.items.sync` | **The core sync endpoint.** Body: `items` (encrypted payloads), `sync_token`, `cursor_token`, `limit`, optional `shared_vault_uuids`, `api_version`. Returns retrieved/saved/conflicted items and new sync tokens. Item payloads are ciphertext. |
| POST | `/v1/items/check-integrity` | `sync.items.check_integrity` | Compare client/server item hashes to detect drift. |
| GET | `/v1/items/:uuid` | `sync.items.get_item` | Fetch a single item by uuid (ciphertext). |

> The gateway route `POST /v1/items` is resolved to `items/sync` (see
> `ItemsController`); the snjs client path constant is `/v1/items`.

### Revisions

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| GET | `/v2/items/:itemUuid/revisions` | `revisions.revisions.getRevisions` | List stored revisions for an item. |
| GET | `/v2/items/:itemUuid/revisions/:id` | `revisions.revisions.getRevision` | Fetch one revision (ciphertext). |
| DELETE | `/v2/items/:itemUuid/revisions/:id` | `revisions.revisions.deleteRevision` | Delete one revision. |

### Files

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| POST | `/v1/files/valet-tokens` | `auth.valet-tokens.create` | Mint a valet token authorizing an upload/download/delete against the files service. The actual chunked transfer happens against the files service host. |

File chunk operations (handled by the files service, authorized with the valet
token from above; client paths in `snjs/.../Paths.ts`):
`POST /v1/files/upload/create-session`, `POST /v1/files/upload/chunk`,
`POST /v1/files/upload/close-session`, `GET`/`DELETE /v1/files`, plus the
shared-vault variants under `/v1/shared-vault/files/*`.

### WebSocket realtime

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| POST | `/v1/sockets/tokens` | `sockets/tokens` | Create a WebSocket **connection token**. Requires cross-service token. Used to authenticate the realtime gateway connection. |
| POST | `/v1/sockets/connections` | `sockets/connections/:connectionId` | Register a connection (requires `connectionid` header). |
| DELETE | `/v1/sockets/connections` | `sockets/connections/:connectionId` | Deregister a connection. |

### Subscriptions and offline tokens

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| POST | `/v1/subscription-tokens` | `auth.subscription-tokens.create` | Mint a short-lived subscription token (used by extensions/services). |
| POST | `/v1/subscription-invites` | `auth.subscriptionInvites.create` | Create a subscription-sharing invite. |
| GET | `/v1/subscription-invites` | `auth.subscriptionInvites.list` | List invites. |
| DELETE | `/v1/subscription-invites/:inviteUuid` | `auth.subscriptionInvites.delete` | Cancel an invite. |
| POST | `/v1/subscription-invites/:inviteUuid/accept` | `auth.subscriptionInvites.accept` | Accept an invite. |
| GET | `/v1/offline/features` | `auth.offline.features` | Offline feature list for an offline subscription token. |
| POST | `/v1/offline/subscription-tokens` | `auth.offline.subscriptionTokens.create` | Mint an offline subscription token. |
| GET | `/v1/offline/users/subscription` | `auth.users.getOfflineSubscriptionByToken` | Look up an offline subscription by token. |

> In this fork every account has full access regardless of subscription
> (features mode `included`), so these endpoints exist for protocol
> compatibility but full access does not depend on them.

### Two-factor: authenticators and magic link

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| GET | `/v1/authenticators/` | `auth.authenticators.list` | List registered WebAuthn authenticators. |
| GET | `/v1/authenticators/generate-registration-options` | `auth.authenticators.generateRegistrationOptions` | Begin WebAuthn registration. |
| POST | `/v1/authenticators/verify-registration` | `auth.authenticators.verifyRegistrationResponse` | Complete WebAuthn registration. |
| POST | `/v1/authenticators/generate-authentication-options` | `auth.authenticators.generateAuthenticationOptions` | Begin WebAuthn authentication. |
| DELETE | `/v1/authenticators/:authenticatorId` | `auth.authenticators.delete` | Remove an authenticator. |
| POST | `/v1/mfa/magic-link/request` | `auth.magicLink.request` | Request an email magic-link code (falls back to on-screen when SMTP is unconfigured). |
| POST | `/v1/mfa/magic-link/status` | `auth.magicLink.setStatus` | Enable/disable magic-link 2FA. |
| GET | `/v1/mfa/magic-link/status` | `auth.magicLink.getStatus` | Read magic-link 2FA status. |

### Collaboration: shared vaults, invites, messages

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| GET | `/v1/shared-vaults/` | `sync.shared-vaults.get-vaults` | List shared vaults. |
| POST | `/v1/shared-vaults/` | `sync.shared-vaults.create-vault` | Create a shared vault. |
| DELETE | `/v1/shared-vaults/:sharedVaultUuid` | `sync.shared-vaults.delete-vault` | Delete a shared vault. |
| POST | `/v1/shared-vaults/:sharedVaultUuid/valet-tokens` | `sync.shared-vaults.create-file-valet-token` | Mint a valet token for a vault file. |
| POST | `/v1/shared-vaults/:sharedVaultUuid/invites` | `sync.shared-vault-invites.create` | Invite a contact to a vault. |
| PATCH | `/v1/shared-vaults/:sharedVaultUuid/invites/:inviteUuid` | `sync.shared-vault-invites.update` | Update an invite. |
| POST | `/v1/shared-vaults/:sharedVaultUuid/invites/:inviteUuid/accept` | `sync.shared-vault-invites.accept` | Accept an invite. |
| POST | `/v1/shared-vaults/:sharedVaultUuid/invites/:inviteUuid/decline` | `sync.shared-vault-invites.decline` | Decline an invite. |
| GET | `/v1/shared-vaults/invites` | `sync.shared-vault-invites.get-user-invites` | List the user's invites. |
| GET | `/v1/shared-vaults/invites/outbound` | `sync.shared-vault-invites.get-outbound` | List sent invites. |
| GET | `/v1/shared-vaults/:sharedVaultUuid/invites` | `sync.shared-vault-invites.get-vault-invites` | List a vault's invites. |
| DELETE | `/v1/shared-vaults/:sharedVaultUuid/invites/:inviteUuid` | `sync.shared-vault-invites.delete-invite` | Delete one invite. |
| DELETE | `/v1/shared-vaults/:sharedVaultUuid/invites` | `sync.shared-vault-invites.delete-all` | Delete a vault's invites. |
| DELETE | `/v1/shared-vaults/invites/inbound` | `sync.shared-vault-invites.delete-inbound` | Delete inbound invites. |
| DELETE | `/v1/shared-vaults/invites/outbound` | `sync.shared-vault-invites.delete-outbound` | Delete outbound invites. |
| GET | `/v1/shared-vaults/:sharedVaultUuid/users` | `sync.shared-vault-users.get-users` | List vault members. |
| DELETE | `/v1/shared-vaults/:sharedVaultUuid/users/:userUuid` | `sync.shared-vault-users.remove-user` | Remove a member. |
| POST | `/v1/shared-vaults/:sharedVaultUuid/users/:userUuid/designate-survivor` | `sync.shared-vault-users.designate-survivor` | Designate a survivor for the vault. |
| GET | `/v1/messages/` | `sync.messages.get-received` | Inbound asymmetric (key-exchange) messages. |
| GET | `/v1/messages/outbound` | `sync.messages.get-sent` | Outbound asymmetric messages. |
| POST | `/v1/messages/` | `sync.messages.send` | Send an asymmetric message. |
| DELETE | `/v1/messages/inbound` | `sync.messages.delete-all` | Delete all inbound messages. |
| DELETE | `/v1/messages/:messageUuid` | `sync.messages.delete` | Delete one message. |

### App passwords (Standard Red Notes)

App-specific passwords let headless clients satisfy the 2FA challenge without a
live TOTP code. The account password is still required. Source:
[`AppPasswordsController.ts`](../server/packages/auth/src/Controller/AppPasswordsController.ts).

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| GET | `/v1/app-passwords/` | `auth.appPasswords.list` | List app passwords (metadata only; secrets are never returned again). |
| POST | `/v1/app-passwords/` | `auth.appPasswords.create` | Body: `label`. Returns `{ appPassword: { uuid, label, createdAt }, password }` — the plaintext `password` is shown **once**. |
| DELETE | `/v1/app-passwords/:appPasswordId` | `auth.appPasswords.delete` | Revoke an app password. |

To use an app password, present it as `app_password` in the `POST /v2/login-params`
body; a valid value marks the interactive 2FA challenge satisfied for that sign-in.

### MCP tokens (Standard Red Notes)

Scoped tokens (`<uuid>.<secret>`) that authenticate without the account
email/password and return client-side-wrapped items keys. Built for the MCP
bridge. Source:
[`McpTokensController.ts`](../server/packages/auth/src/Controller/McpTokensController.ts).

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| GET | `/v1/mcp-tokens/` | `auth.mcpTokens.list` | List MCP tokens (metadata only). |
| POST | `/v1/mcp-tokens/` | `auth.mcpTokens.create` | Body: `label`, `scope` (`read`/`write`), optional `scopeTagUuids`, plus the client-side `wrappedKeys`, `kdfSalt`, `kdfParams`. Returns the token **once** in `<uuid>.<secret>` form. |
| DELETE | `/v1/mcp-tokens/:mcpTokenId` | `auth.mcpTokens.delete` | Revoke a token. |
| GET | `/v1/mcp-tokens/keys/:mcpTokenId` | `auth.mcpTokens.getKeys` | Fetch the wrapped key material + scope for a token. Authenticated. |
| POST | `/v1/mcp-tokens/authenticate` | `auth.mcpTokens.authenticate` | **Unauthenticated** (the token is the credential). Body: `token`, optional `apiVersion`. Returns `{ session, key_params, user, mcp_scope, mcp_key_material }` — a real session plus wrapped keys in one round trip. `scope=read` yields a read-only session. |

### Trusted devices and push MFA (Standard Red Notes)

A trusted-device token bypasses **only** the 2FA gate (never the account
password) on future sign-ins. Push-MFA approvals let another signed-in device
approve a pending sign-in. Sources:
[`TrustedDevicesController.ts`](../server/packages/auth/src/Controller/TrustedDevicesController.ts),
[`PendingMfaApprovalsController.ts`](../server/packages/auth/src/Controller/PendingMfaApprovalsController.ts).

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| POST | `/v1/trusted-devices/` | `auth.trustedDevices.create` | Register the current device as trusted; returns a device token. |
| GET | `/v1/trusted-devices/` | `auth.trustedDevices.list` | List trusted devices. |
| DELETE | `/v1/trusted-devices/:deviceId` | `auth.trustedDevices.delete` | Revoke a trusted device. |
| GET | `/v1/pending-mfa-approvals/` | `auth.pendingMfaApprovals.list` | List pending sign-in approvals. |
| POST | `/v1/pending-mfa-approvals/:challengeId/resolve` | `auth.pendingMfaApprovals.resolve` | Approve/deny a pending sign-in. |
| GET | `/v1/pending-mfa-approvals/:challengeId/status` | `auth.pendingMfaApprovals.status` | Poll a pending sign-in's status. |

To use a trusted-device token at sign-in, present it as `trusted_device_token`
in the `POST /v2/login-params` body. The server fails closed: a wrong/expired
token is ignored and the normal 2FA prompt still appears.

### Public share links (Standard Red Notes)

A signed-in user can publish a note as ciphertext keyed by a `shareId`; the
decryption key lives only in the link fragment and never reaches the server.
Source: [`SharesController.ts`](../server/packages/auth/src/Controller/SharesController.ts).

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| POST | `/v1/shares/` | `auth.shares.create` | Body: `type`, `encryptedPayload`, optional `nickname`, `oneTimeView`, `viewExpiresMinutes`. Returns `{ shareId, share }`. Authenticated. |
| GET | `/v1/shares/` | `auth.shares.list` | List the user's shares. Authenticated. |
| DELETE | `/v1/shares/:shareId` | `auth.shares.revoke` | Revoke a share. Authenticated. |
| GET | `/v1/shares/:shareId` | `auth.shares.get` | **Public, unauthenticated** read of the opaque ciphertext. Returns `404` when missing or revoked; never leaks the owner uuid. |

### Dead man's switches (Standard Red Notes)

A survivor switch: the server stores a full share URL (link + key) and emails it
to a recipient if the user stops checking in by the deadline. Source:
[`DeadManSwitchesController.ts`](../server/packages/auth/src/Controller/DeadManSwitchesController.ts).

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| POST | `/v1/dead-man-switches/` | `auth.deadManSwitches.create` | Create a switch (recipient, deadline, share URL). |
| GET | `/v1/dead-man-switches/` | `auth.deadManSwitches.list` | List switches. |
| POST | `/v1/dead-man-switches/:switchId/check-in` | `auth.deadManSwitches.checkIn` | Reset the deadline ("I'm alive"). |
| DELETE | `/v1/dead-man-switches/:switchId` | `auth.deadManSwitches.delete` | Delete a switch. |

### Email reminders (Standard Red Notes)

Reminders the server may **email** to the account email when due. Unlike in-app
reminders (E2E-encrypted in note appData), the time + message here are stored in
plaintext because the user opted that reminder into email delivery. Source:
[`EmailRemindersController.ts`](../server/packages/auth/src/Controller/EmailRemindersController.ts).

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| POST | `/v1/email-reminders/` | `auth.emailReminders.create` | Create an email reminder (time + message, plaintext). |
| GET | `/v1/email-reminders/` | `auth.emailReminders.list` | List email reminders. |
| DELETE | `/v1/email-reminders/:reminderId` | `auth.emailReminders.delete` | Delete an email reminder. |

### AI assistant proxy (Standard Red Notes)

A stateless LLM streaming proxy. Notes are E2E-encrypted, so the agent loop and
all tools run in the browser; this controller only forwards one model turn at a
time using a **server-held** provider key. Source:
[`AssistantController.ts`](../server/packages/api-gateway/src/Controller/v1/AssistantController.ts).
These routes are **not** part of the home-server `EndpointResolver` map.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/v1/assistant/config` | Public | Returns which providers the server has configured (non-sensitive) and the defaults. |
| GET | `/v1/assistant/models?provider=...` | Authenticated | Lists models the configured provider offers (queried with the server key). |
| GET | `/v1/assistant/usage` | Authenticated | Returns `{ used, limit, resetsAt }` for the per-user daily request budget. |
| POST | `/v1/assistant/stream` | Authenticated | Body: `provider`, `model`, `system`, `messages`, `tools`. Streams Server-Sent Events. Enforces per-user daily limits; `403` if AI disabled, `429` if over limit. |

### Integrations (Standard Red Notes)

Source:
[`IntegrationsController.ts`](../server/packages/api-gateway/src/Controller/v1/IntegrationsController.ts).
Not part of the `EndpointResolver` map.

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/v1/integrations/github/publish` | Authenticated | Pushes a single note (already converted to Markdown by the client) to a GitHub repo using a user-supplied PAT. Receives decrypted content + the PAT, forwards to GitHub, and persists/logs neither. |

### Admin (Standard Red Notes)

In-app admin panel endpoints, gated server-side on the internal-team role.
Source:
[`AdminController.ts`](../server/packages/api-gateway/src/Controller/v1/AdminController.ts).

| Method | Path | Resolver id | Notes |
| --- | --- | --- | --- |
| GET | `/v1/admin/lookup-user/:email` | `admin.lookupUser` | Look up a user by email. |
| GET | `/v1/admin/users/:userUuid/feature-flags` | `admin.getUserFeatureFlags` | Read a user's feature flags. |
| PUT | `/v1/admin/users/:userUuid/feature-flags` | `admin.setUserFeatureFlag` | Set a feature flag. |
| GET | `/v1/admin/users/:email/ban-status` | `admin.getUserBanStatus` | Read a user's ban status. |
| PUT | `/v1/admin/users/:userUuid/ban-status` | `admin.setUserBanStatus` | Set ban status. |
| GET | `/v1/admin/registration` | `admin.getRegistrationFlag` | Read whether open registration is enabled. |
| PUT | `/v1/admin/registration` | `admin.setRegistrationFlag` | Toggle open registration. |

### Server metadata

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/meta` | Public. Returns server metadata such as the CAPTCHA UI URL. |

---

## See also

- [Onboarding guide](onboarding.md) — using the app, accounts, editors, privacy.
- [Self-hosting guide](self-hosting.md) — env vars, reverse proxy, cookies/auth,
  backups.
- [`cli/srn-client`](../cli/srn-client/README.md) — a real, end-to-end-encrypted
  CLI client that exercises this API via an embedded snjs client.
- [MCP support plan](MCP_SUPPORT_PLAN.md) — the MCP bridge that uses MCP tokens.
