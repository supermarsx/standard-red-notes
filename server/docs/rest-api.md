# Standard Red Notes — REST API for Integrations

This is the integrator-facing reference for wiring external automation platforms
(n8n, Zapier, Typeform, custom scripts) to a self-hosted **Standard Red Notes**
server. It documents only endpoints that exist in this fork; there is no
OpenAPI/Swagger document — this Markdown file is the contract.

> Companion doc: outbound webhooks are documented in
> [`webhooks.md`](./webhooks.md).

---

## 1. Concepts

### The API gateway
Every REST call goes to the **API gateway**, which authenticates the request and
proxies it to the internal `auth` / `syncing-server` services. All routes below
are relative to your gateway's public base URL, e.g.:

```
https://api.your-server.example
```

All integration routes live under the `/v1/` prefix.

### End-to-end encryption (read this first)
Standard Notes items are **end-to-end encrypted**. The server never has your
decryption keys, so the REST API returns items in their **encrypted** form
(`content` is ciphertext). To read note bodies you must decrypt client-side with
the account's key material. A "scoped API token" (below) can optionally carry the
**wrapped key material** so a bridge can unwrap keys and decrypt locally — but the
server itself cannot and will not return plaintext. Webhooks are likewise
metadata-only (see `webhooks.md`).

### Scoped API tokens (McpToken)
Instead of embedding an account email + password (SRP) in an integration, you mint
a **scoped API token**. In this codebase the token entity is called an
**MCP token**; it is exactly the "scoped API token" for REST access. Properties:

| Property         | Meaning                                                             |
|------------------|--------------------------------------------------------------------|
| `scope`          | `read` or `write`. `read` mints a **read-only** session server-side. |
| `scopeTagUuids`  | Optional list of tag UUIDs the token is restricted to (tag-scoping). |
| `expiresAt`      | Optional expiry; an expired token fails authentication.             |
| revocable        | Delete the token to revoke it immediately.                          |

The plaintext token is shown **exactly once** at creation, in the form
`<tokenUuid>.<secret>`. Store it securely; it is unrecoverable afterward.

---

## 2. Authentication model

There are two token layers:

1. **Scoped API token** (`<uuid>.<secret>`) — long-lived, revocable, scoped. This
   is the credential you configure in your integration.
2. **Session bearer** (`access_token`) — short-lived. You exchange the scoped API
   token for a session, then present the session's `access_token` as a Bearer
   token on every data call.

```
scoped API token  ──POST /v1/mcp-tokens/authenticate──▶  session { access_token, refresh_token }
session access_token  ──Authorization: Bearer <access_token>──▶  /v1/items, /v1/webhooks, ...
```

### Step 0 (one-time): create a scoped API token
Creating a token requires **client-wrapped key material** (`wrappedKeys`,
`kdfSalt`, `kdfParams`) produced by the Standard Notes client crypto stack, so in
practice you create the token in the **web app**:

> **Preferences → Security → Access / MCP Tokens → New token**, choose `read` or
> `write` (and optionally restrict to specific tags), then copy the one-time
> token.

The equivalent REST call (requires an existing authenticated session bearer) is:

```
POST /v1/mcp-tokens/
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "label": "n8n production",
  "scope": "read",
  "scopeTagUuids": ["b1e2...optional..."],
  "wrappedKeys": "<client-wrapped key blob>",
  "kdfSalt": "<hex>",
  "kdfParams": "<json>"
}
```

Response (the `token` field is returned **once**):

```json
{
  "mcpToken": {
    "uuid": "6f9c...",
    "label": "n8n production",
    "scope": "read",
    "scopeTagUuids": ["b1e2..."],
    "createdAt": "2026-07-01T10:00:00.000Z",
    "expiresAt": null
  },
  "token": "6f9c....<uuid>.<secret>"
}
```

> Because `wrappedKeys`/`kdfSalt`/`kdfParams` are only derivable inside the SN
> client, **prefer the web-app UI** to mint tokens. The raw endpoint is documented
> for completeness.

### Step 1: exchange the token for a session (the integration auth path)
This route is **unauthenticated** — the scoped token in the body *is* the
credential. It mints a real auth session **without SRP**.

```
POST /v1/mcp-tokens/authenticate
Content-Type: application/json

{
  "token": "6f9c....<uuid>.<secret>"
}
```

Optional body field `api` selects the API version (defaults to `20200115`).

Response (abridged):

```json
{
  "session": {
    "access_token": "eyJ...",
    "refresh_token": "eyJ...",
    "access_expiration": 1751365200000,
    "refresh_expiration": 1753957200000,
    "readonly_access": true
  },
  "key_params": { "...": "..." },
  "user": { "uuid": "…", "email": "…" },
  "mcp_scope": { "access": "read", "tagUuids": ["b1e2..."] },
  "mcp_key_material": {
    "wrappedKeys": "…",
    "kdfSalt": "…",
    "kdfParams": "…"
  }
}
```

Notes:
- `session.readonly_access` is `true` when the token `scope` is `read`. The server
  **enforces** read-only at the session level — write calls are rejected.
- `mcp_scope.tagUuids` echoes the token's tag-scoping. Tag scoping is **enforced
  client-side** by the bridge (the server threads it through for you); do not rely
  on it as a server-side authorization boundary for arbitrary item reads.
- `mcp_key_material` is present so a bridge can unwrap keys and decrypt items
  locally. It is `null` if key material can't be resolved.

### Step 2: call the API with the session bearer
Present the session `access_token` on every subsequent request:

```
Authorization: Bearer <access_token>
```

### Refreshing / revoking
- **Refresh** an expiring session: `POST /v1/sessions/refresh` with
  `{ "access_token": "...", "refresh_token": "..." }`.
- **Revoke** the integration entirely: delete the scoped token
  (`DELETE /v1/mcp-tokens/:mcpTokenId`) or revoke the session
  (`DELETE /v1/sessions/:uuid`). Session revocation also emits the
  `session.revoked` webhook (see `webhooks.md`).

---

## 3. Endpoint reference

All routes are under the gateway base URL. "Auth" = requires
`Authorization: Bearer <access_token>` unless noted.

### Scoped API tokens — `/v1/mcp-tokens`
| Method & path                          | Auth            | Purpose |
|----------------------------------------|-----------------|---------|
| `GET /v1/mcp-tokens/`                   | Bearer          | List your scoped tokens (no secrets). |
| `POST /v1/mcp-tokens/`                  | Bearer          | Create a token; returns plaintext token **once**. |
| `DELETE /v1/mcp-tokens/:mcpTokenId`     | Bearer          | Revoke a token. |
| `GET /v1/mcp-tokens/keys/:mcpTokenId`   | Bearer          | Fetch the token's wrapped key material. |
| `POST /v1/mcp-tokens/authenticate`      | **None** (token is the credential) | Exchange a token for a session. |

### Webhooks — `/v1/webhooks`
| Method & path                    | Auth   | Purpose |
|----------------------------------|--------|---------|
| `GET /v1/webhooks/`              | Bearer | List your webhooks + the `availableEvents` catalogue. |
| `POST /v1/webhooks/`            | Bearer | Register a webhook; returns HMAC `secret` **once**. |
| `DELETE /v1/webhooks/:webhookId` | Bearer | Delete a webhook. |

Full request/response shapes and the event catalogue: see
[`webhooks.md`](./webhooks.md).

### Items (data plane) — `/v1/items`
| Method & path                     | Auth   | Purpose |
|-----------------------------------|--------|---------|
| `POST /v1/items`                  | Bearer | **Sync**: the primary read/write endpoint. Send `items[]` to write, receive changed items to read. Encrypted payloads. |
| `POST /v1/items/check-integrity`  | Bearer | Integrity check (hash reconciliation). |
| `GET /v1/items/:uuid`             | Bearer | Fetch a single item by UUID (encrypted). |

> Standard Notes has no per-field CRUD REST surface; **all item reads and writes
> go through the sync endpoint** (`POST /v1/items`). A read-scoped session can
> call sync with an empty `items` array to pull changes but cannot persist writes.

### Sessions — `/v1/sessions`
| Method & path                | Auth   | Purpose |
|------------------------------|--------|---------|
| `GET /v1/sessions/`          | Bearer | List active sessions. |
| `POST /v1/sessions/refresh`  | tokens in body | Refresh an access token. |
| `DELETE /v1/sessions/:uuid`  | Bearer | Revoke a specific session. |
| `DELETE /v1/sessions/`       | Bearer | Revoke all other sessions. |

### Audit log — `/v1/admin/audit-log` (admin only)
| Method & path              | Auth                | Purpose |
|----------------------------|---------------------|---------|
| `GET /v1/admin/audit-log`  | Bearer (**admin** role `InternalTeamUser`) | Query the security audit log. |

Query params: `actorUuid`, `action`, `createdAfter` (epoch ms), `createdBefore`
(epoch ms), `limit`, `offset`. Response entries:

```json
{
  "uuid": "…",
  "actorUuid": "…",
  "action": "webhook.created",
  "targetType": "webhook",
  "targetUuid": "…",
  "ip": "203.0.113.4",
  "metadata": { "targetUrl": "https://…", "events": ["item.created"], "global": false },
  "createdAt": "2026-07-01T10:00:00.000Z"
}
```

Audit `action` values include: `login.success`, `login.failure`, `logout`,
`session.revoked`, `role.changed`, `ban.changed`, `setting.changed`,
`webhook.created`, `webhook.deleted`.

---

## 4. End-to-end example (curl)

```bash
GATEWAY="https://api.your-server.example"
API_TOKEN="6f9c....<uuid>.<secret>"   # minted once in the web app

# 1. Exchange the scoped token for a session.
SESSION=$(curl -s -X POST "$GATEWAY/v1/mcp-tokens/authenticate" \
  -H 'Content-Type: application/json' \
  -d "{\"token\": \"$API_TOKEN\"}")

ACCESS_TOKEN=$(echo "$SESSION" | jq -r '.session.access_token')

# 2. List the webhooks + discover the event catalogue.
curl -s "$GATEWAY/v1/webhooks/" \
  -H "Authorization: Bearer $ACCESS_TOKEN" | jq

# 3. Pull items via the sync endpoint (encrypted payloads).
curl -s -X POST "$GATEWAY/v1/items" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"items": [], "sync_token": null, "limit": 150}' | jq '.retrieved_items | length'
```

---

## 5. Errors

Errors are JSON: `{ "error": { "message": "..." } }` with a matching HTTP status.

| Status | Typical cause |
|--------|---------------|
| 400    | Malformed request / validation failure. |
| 401    | Missing/invalid/expired session, invalid scoped token, or non-admin calling an admin route. |

A `read`-scoped session that attempts a write is rejected by the server's
read-only enforcement.

---

## 6. What is intentionally NOT here
- No OpenAPI/Swagger file — this fork ships no such tooling; do not expect a
  generated client.
- No plaintext item content over REST (E2E encryption).
- No separate "API key" entity — the **scoped MCP token is the API token**.
