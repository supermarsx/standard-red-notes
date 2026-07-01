# Standard Red Notes — Outbound Webhooks

Register an HTTPS endpoint and Standard Red Notes will POST a **signed JSON
payload** to it whenever a subscribed event occurs — ideal for driving n8n,
Zapier, Typeform, or a custom receiver.

> Auth and the REST surface are documented in [`rest-api.md`](./rest-api.md).

---

## 1. Privacy model (read this first)

Standard Notes items are **end-to-end encrypted**; the server has no decryption
keys. Webhook payloads therefore carry **metadata only** — event name, UUIDs, and
timestamps. **Decrypted note content is never sent** and cannot be, by design.

---

## 2. Registering a webhook

`POST /v1/webhooks/` with a session Bearer token (see `rest-api.md` §2).

```
POST /v1/webhooks/
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "targetUrl": "https://hooks.example.com/srn",
  "events": ["item.created", "item.deleted"],
  "global": false
}
```

| Field       | Required | Notes |
|-------------|----------|-------|
| `targetUrl` | yes      | Public HTTPS URL. Must resolve to a **public** address (see SSRF, §6). |
| `events`    | yes      | Non-empty array from the [event catalogue](#4-event-catalogue). Unknown names are rejected. |
| `global`    | no       | `true` = fire for **all users' events**. **Admin only** (role `InternalTeamUser`); a non-admin sending `global:true` gets `401`. Omit or `false` for a normal user-scoped webhook. |

### Response — the secret is shown ONCE

```json
{
  "webhook": {
    "uuid": "b0a1...",
    "userUuid": "u-123",
    "targetUrl": "https://hooks.example.com/srn",
    "events": ["item.created", "item.deleted"],
    "enabled": true,
    "createdAt": "2026-07-01T10:00:00.000Z"
  },
  "secret": "9f86d081...<64 hex chars>..."
}
```

`secret` (a 256-bit hex string) is the HMAC key used to sign deliveries. It is
returned **exactly once** and is never retrievable again — store it now. For a
`global` webhook, `webhook.userUuid` is `null`.

### Listing & deleting

```
GET    /v1/webhooks/            # -> { availableEvents: [...], webhooks: [...] }
DELETE /v1/webhooks/:webhookId
```

`GET /v1/webhooks/` returns the `availableEvents` catalogue alongside your
webhooks so a UI/integration can discover subscribable events dynamically. Listed
webhooks never include the secret. Admins additionally see global webhooks.

---

## 3. Delivery format

Each delivery is an HTTP `POST` to your `targetUrl` with:

**Headers**

| Header             | Value |
|--------------------|-------|
| `Content-Type`     | `application/json` |
| `X-SRN-Signature`  | `sha256=<hex>` — HMAC-SHA256 of the raw body (see §5). |
| `X-SRN-Event`      | The event name, e.g. `item.created`. |
| `X-SRN-Webhook-Id` | The webhook's UUID. |

**Body**

```json
{
  "event": "item.created",
  "deliveredAt": "2026-07-01T10:00:05.123Z",
  "userUuid": "u-123",
  "data": { "timestamp": 1751365205000 }
}
```

- `event` — the subscribed event name.
- `deliveredAt` — ISO-8601 dispatch timestamp.
- `userUuid` — the user the event originated from (lets a `global` subscriber
  attribute events). Never an email or any decrypted content.
- `data` — per-event metadata (see catalogue). May be `{}`.

Your endpoint should respond with any **2xx** status to acknowledge. Non-2xx (or a
timeout / connection error) triggers a retry (§7).

---

## 4. Event catalogue

| Event             | Status    | `data` payload          | Fires when |
|-------------------|-----------|-------------------------|------------|
| `item.created`    | **Live**  | `{ "timestamp": <ms> }` | A sync creates/updates items. |
| `item.updated`    | **Live**  | `{ "timestamp": <ms> }` | A sync creates/updates items. |
| `item.deleted`    | **Live**  | `{ "itemUuid": "..." }` | An item is deleted. |
| `user.login`      | **Live**  | `{}` (metadata only)    | A user successfully signs in. |
| `session.revoked` | Supported | `{}` (metadata only)    | A session is revoked / signed out. |
| `admin.action`    | Supported | metadata only           | An administrative action occurs. |

Notes:
- The internal sync signal does not distinguish create-vs-update per item, so a
  sync that changes items fans out to **both** `item.created` and `item.updated`.
  Subscribe to whichever you need; expect both to fire on a change.
- `session.revoked` and `admin.action` are part of the public contract and are
  **supported** for subscription today; their server-side dispatch is being
  finalized in parallel. `item.*` and `user.login` are already emitting.

### Example payloads

`item.deleted`:

```json
{
  "event": "item.deleted",
  "deliveredAt": "2026-07-01T10:00:05.123Z",
  "userUuid": "u-123",
  "data": { "itemUuid": "a7f3-..." }
}
```

`user.login`:

```json
{
  "event": "user.login",
  "deliveredAt": "2026-07-01T10:00:05.123Z",
  "userUuid": "u-123",
  "data": {}
}
```

---

## 5. Verifying the signature

Every delivery is signed with `HMAC-SHA256(secret, rawBody)`, hex-encoded, sent as
`X-SRN-Signature: sha256=<hex>`. **Verify over the exact raw request body** before
parsing JSON — re-serializing changes bytes and breaks the check. Compare in
**constant time**.

### Node.js (Express)

```js
const crypto = require('crypto')

// Capture the RAW body so the bytes match what was signed.
app.use('/srn', express.raw({ type: 'application/json' }))

function verify(rawBody, headerSig, secret) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)            // Buffer of the raw body
    .digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(headerSig || '')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

app.post('/srn', (req, res) => {
  const sig = req.header('X-SRN-Signature')
  if (!verify(req.body, sig, process.env.SRN_WEBHOOK_SECRET)) {
    return res.status(401).send('bad signature')
  }
  const payload = JSON.parse(req.body.toString('utf8'))
  // handle payload.event ...
  res.sendStatus(200)
})
```

### Generic HMAC recipe (any language)

```
received   = header "X-SRN-Signature"            # "sha256=<hex>"
computed   = "sha256=" + lowercase_hex(HMAC_SHA256(key = secret, msg = raw_request_body))
valid      = constant_time_equals(received, computed)
```

Reject the delivery if `valid` is false. The digest is lowercase hex; the
`sha256=` scheme prefix is part of the compared string.

### Python (Flask) example

```python
import hmac, hashlib
from flask import request, abort

def verify(raw_body: bytes, header_sig: str, secret: str) -> bool:
    expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header_sig or "")

@app.post("/srn")
def srn():
    if not verify(request.get_data(), request.headers.get("X-SRN-Signature"), SECRET):
        abort(401)
    # request.get_json() ...
    return "", 200
```

---

## 6. SSRF / public-URL restriction

`targetUrl` must resolve to a **public** IP. Targets that resolve to loopback,
private (RFC 1918), link-local, or cloud-metadata addresses are **rejected**:

- **At registration** — an internal/private URL fails `POST /v1/webhooks/` with a
  validation error, so it is never stored.
- **At delivery** — the target is re-resolved and re-validated right before each
  send (defends against DNS rebinding between registration and delivery). A target
  that has become private is logged and the delivery is dropped.

**Redirects are never followed** (`maxRedirects: 0`): a `3xx` to a private host is
a classic SSRF-filter bypass, so your endpoint must respond directly with a `2xx`,
not redirect.

---

## 7. Retry, backoff & timeout

Delivery is synchronous, in-process, best-effort:

| Parameter        | Value |
|------------------|-------|
| Timeout          | **5 seconds** per attempt. |
| Success          | Any **2xx** response. |
| Max attempts     | **3**. |
| Backoff          | Exponential, base **250 ms** → waits **250 ms** then **500 ms** between attempts. |
| On final failure | Logged server-side and dropped (no dead-letter queue). |
| Redirects        | Not followed (see §6). |
| Blocked (SSRF)   | Dropped immediately, **not** retried (re-resolving would block again). |

Make your receiver **fast** (respond `2xx` within 5 s; enqueue heavy work) and
**idempotent** (retries and the `item.created`/`item.updated` fan-out can deliver
duplicates). Deduplicate on `X-SRN-Webhook-Id` + `event` + `data`/`deliveredAt` as
appropriate.

---

## 8. Audit log

Webhook lifecycle actions are recorded to the security audit log. Creating a
webhook writes a `webhook.created` entry (metadata: `targetUrl`, `events`,
`global`); deleting one writes `webhook.deleted`. Admins can query these via
`GET /v1/admin/audit-log` (see [`rest-api.md`](./rest-api.md) §3). Audit metadata
never contains the HMAC secret.

---

## 9. Quick start (curl)

```bash
GATEWAY="https://api.your-server.example"
ACCESS_TOKEN="eyJ..."   # from /v1/mcp-tokens/authenticate (see rest-api.md)

# Register and capture the one-time secret.
RESP=$(curl -s -X POST "$GATEWAY/v1/webhooks/" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"targetUrl":"https://hooks.example.com/srn","events":["item.created","item.deleted"]}')

echo "$RESP" | jq -r '.secret'   # STORE THIS — shown only once.
```
