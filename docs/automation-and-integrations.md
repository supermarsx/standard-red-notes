---
title: Automation and Integrations
description: Runtime status, gates, and privacy boundaries for workflows, webhooks, OCR, CalDAV, plugins, GitHub publishing, reminders, and AI.
---

# Automation and Integrations

Integrations are not all at the same maturity or trust boundary. This page
describes the code that is present and calls out explicit deferrals.

{% include safety-alert.html
  level="trust"
  title="Integrations can receive decrypted content"
  body="Provider AI, the server OCR path, GitHub publishing, webhooks, reminders, and workflow tools can move selected plaintext or credentials beyond the encrypted client. Enable only the path you have reviewed, minimize its input, and document retention and revocation."
%}

## Status matrix

| Integration | Runtime status | Gate |
| --- | --- | --- |
| MCP | Shipped, with documented scope limits | Account credential or full decrypting token; server-enforced read-only/write mode; bridge writes off by default; selected-tag scope is not currently enforced |
| OpenClaw | Shipped with local MCP | Local MCP configuration and provider |
| Workflows/n8n | Phase 1 shipped | Operator master switch, per-user entitlement, explicit pairing |
| Webhooks | Shipped | Authenticated user or administrator for global hooks |
| GitHub publish | Shipped | Explicit user action and user-supplied PAT |
| Browser OCR | Shipped | Client setting/operator intent |
| Server OCR | Shipped, off by default | Operator master switch and per-user permission |
| CalDAV | Shipped read-only, off by default | Operator master switch, per-user permission, dedicated token |
| Plugins gallery proxy | Shipped, operator-configured | Repository URL and rendering policy |
| Email reminders | Shipped, operator-dependent | Mail delivery and per-user feature setting |
| Assistant proxy | Shipped, operator/provider-dependent | Per-user AI gate, provider configuration, limits |

## Workflows and n8n

The implemented workflow endpoints provide:

- status (`enabled`, `paired`, and editor URL);
- idempotent pair/unpair;
- a short-lived, HttpOnly, path-scoped editor cookie; and
- a same-origin proxy to the configured n8n editor.

Both the `WORKFLOWS_ENABLED` master switch and the user’s `WorkflowsEnabled`
setting are checked on every call. The proxy also checks active entitlement and
pairing.

Phase 1 does **not** automatically provision a per-user MCP credential or
Standard Red Notes-to-n8n trigger webhooks. The controller explicitly defers
those operations because MCP credential creation requires client-wrapped key
material and a webhook target exists only after a workflow defines one. Treat
the [Workflows plan](WORKFLOWS_PLAN.md) as roadmap context.

Keep the internal n8n service private. Expose the editor only through the
protected `/workflows-ui` proxy.

## Webhooks

Webhooks can be user-specific or global. Only an administrator may register a
global webhook. Use HTTPS, verify the receiving endpoint, subscribe to the
smallest event set, and ensure the receiver is idempotent.

Webhook payloads and delivery metadata can leave the encrypted application
boundary depending on the event. Do not send decrypted note content unless the
integration explicitly requires and protects it.

Rotate or delete unused webhooks and audit global-hook changes.

## GitHub publishing

`POST /v1/integrations/github/publish` publishes one note after the client
converts it to Markdown. The request contains:

- decrypted note content;
- a user-supplied GitHub personal access token; and
- repository/path/commit information.

The gateway forwards the content and PAT to GitHub and is designed not to
persist or log either. Use a fine-grained token limited to the target repository
and revoke it when publishing is complete. Review the rendered Markdown for
secrets, embedded files, internal links, and private metadata.

The browser is a separate persistence boundary. **Remember this token on this
device** is off by default; enabling it stores the PAT unencrypted in that
browser’s `localStorage`. Leave it off on shared or untrusted devices. To remove
a previously remembered PAT, submit the next publish with **Remember** cleared,
or remove only the `standardnotes.github.publish.token.v1` key with the
browser’s site-storage tools. Do not clear all Standard Red Notes site data
unless the account is fully synchronized and backed up. Revoke the PAT at
GitHub if the device may be lost or compromised.

## OCR

Browser OCR keeps page imagery on the device. Server OCR requires the client to
decrypt PDF pages and upload rasterized images to `/v1/ocr/recognize`; the server
therefore sees those page images for the duration of the request.

Server OCR fails closed behind:

1. `OCR_SERVER_ENABLED`;
2. the per-user `OCR_SERVER_ALLOWED` setting; and
3. the client offering the action only when both are true.

Administrators can also set the default language, maximum pages, and maximum
image bytes. Use browser OCR for sensitive documents when possible.

{% include safety-alert.html
  level="caution"
  title="Server OCR uploads decrypted page images"
  body="The client rasterizes decrypted PDF pages and sends those images to the server OCR endpoint. Browser OCR keeps that image path on the device; use it when the document must not be disclosed to the server."
%}

## CalDAV

CalDAV publishes a read-only reminders/calendar feed under the configurable
base path (default `/dav`). It uses dedicated `calendar-read` tokens. The
operator master switch and the user’s CalDAV setting must both be enabled before
token issuance.

Create one labeled token per calendar client. The username shown by the web UI
is `caldav`; the generated token is the password. Revoke a token when a device
is lost. The feed is a published view, not bidirectional editing.

## Plugins gallery

The gateway can retrieve a configured `packages.json` index and package files,
and can serve component assets for isolated rendering. A repository compromise
can turn plugin distribution into code delivery.

- Pin the repository to a trusted HTTPS origin.
- Review packages and checksums before publishing the index.
- Keep same-origin rendering disabled unless its stronger trust is explicitly
  accepted.
- Use restrictive content security and sandboxing.
- Remove the repository URL to disable an untrusted source.

## Reminders and assistant providers

Email reminders require server mail configuration and the user’s reminder
setting. Delivery metadata and reminder text sent by email leave the encrypted
client boundary.

AI assistant requests can be routed to Anthropic, OpenAI, or Ollama-compatible
providers according to operator configuration. Apply per-user enablement and
request/token limits. Hosted providers receive the prompt and selected content;
local providers reduce external disclosure but still require secured local
logs, models, and network access.

{% include safety-alert.html
  level="trust"
  title="Review the AI route, not only the model name"
  body="A direct browser provider receives the selected prompt and tool context from the client. A proxy route also exposes that request to the configured Standard Red Notes server before it reaches the provider. Self-hosting the app does not make a hosted AI request local."
%}

## Integration review checklist

For every integration, record:

- master switch and per-user gate;
- credential owner, scope, rotation, and revocation;
- decrypted content that leaves the client;
- destination and transport security;
- retry/idempotency behavior;
- audit or structured-log evidence;
- failure behavior; and
- how to disable and remove retained data.

For MCP and assistant-specific configuration, see [MCP Bridge](mcp-bridge.md)
and [OpenClaw](openclaw.md).
