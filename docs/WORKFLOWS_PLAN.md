---
title: Workflows Plan
description: n8n-backed workflow automation plan.
---

# Workflows — n8n-backed automation engine (plan)

A "Workflows" section in the sidebar (next to Files) backed by an n8n engine running
beside the server, letting a user visually build automations ("offbook" workloads)
that can: run AI-agent steps, create and send emails, create and send notes, send
messages, share/send a PDF, and react to events in their notebook. Access is
account-gated: the user must be signed in to a server AND the account must be
allowed to use the workflows backend (admin-manageable, like AI/OCR/Nextcloud).

Everything below builds on subsystems that already exist in this fork — the
webhooks + REST API + scoped MCP tokens (#316), the assistant proxy, share links,
valet-token file access, SMTP email, the Settings/feature-flag + admin surface,
and the MCP bridge.

## 1. Architecture at a glance

```
┌─ web client ─────────────────────────────┐
│ Sidebar: Workflows (gated)               │
│   WorkflowsView pane                     │
│    ├─ pairing/status UI (SRN-native)     │
│    └─ n8n editor (iframe, same-origin    │
│       proxied, sandboxed)                │
└──────────────┬───────────────────────────┘
               │ /v1/workflows/* (session-authed)
┌─ api-gateway ┴───────────────────────────┐
│ WorkflowsController                      │
│  - status / pair / unpair / entitlement  │
│  - reverse-proxy to n8n UI+API           │
└───────┬──────────────────────┬───────────┘
        │                      │
┌─ auth service ─┐      ┌─ n8n container ──────────────┐
│ WorkflowsEnabled│      │ per-user n8n account/project │
│ setting + admin │      │ SRN credential = MCP token   │
│ toggle; MCP     │      │ custom SRN nodes package     │
│ token provision │      └──────┬───────────────────────┘
└─────────────────┘             │ calls back with scoped token
        ▲                       ▼
        │   SRN webhooks ──► n8n webhook triggers (HMAC-signed)
        │   REST API / assistant proxy / shares / valet / SMTP
```

Key idea: **n8n is a peer service, not a trusted core.** It talks to Standard Red
Notes only through the same authenticated, scoped surfaces any external
integration would use (MCP scoped token → session → REST API; HMAC-verified
webhooks). The E2E encryption boundary is preserved by construction.

## 2. Account gating (must-have, per your requirement)

- **Global master switch:** `WORKFLOWS_ENABLED` env (mirrors `OCR_SERVER_ENABLED`
  pattern). Off = feature invisible everywhere.
- **Per-user flag:** `SettingName.WorkflowsEnabled`, added to
  `ADMIN_MANAGEABLE_SETTINGS` in `BaseAdminController.ts` with a strict
  'true'/'false' validator → manageable from **Preferences → Admin** per-user
  feature flags (same endpoints as AiEnabled/OcrServerAllowed).
- **Client:** `FeatureName.Workflows`; the sidebar button renders only when
  (a) signed into a server, (b) `WorkflowsEnabled` resolves true. Server
  re-checks entitlement on every `/v1/workflows/*` call (never trust the client).
- **Pairing is explicit:** even when enabled, the user clicks "Connect workflows"
  in the WorkflowsView, which provisions their n8n account + credentials. Unpair
  revokes the MCP token and disables their n8n account.

## 3. How n8n integrates (no new auth invented)

1. **SRN → n8n (triggers):** the pairing step registers per-user **webhooks**
   (item.created/updated/deleted, user.login, …) whose target is the user's n8n
   webhook URL. Payloads are HMAC-signed (`X-SRN-Signature`) and metadata-only
   (uuids/timestamps — never note content). A custom "SRN Trigger" n8n node
   verifies the signature and exposes the event.
2. **n8n → SRN (actions):** pairing mints a **scoped MCP token**
   (`<uuid>.<secret>`, read-only or read-write) and stores it as an n8n
   credential. Custom SRN nodes authenticate via `POST /mcp-tokens/authenticate`
   → session → call the REST API / assistant proxy / shares / valet endpoints.
3. **Gateway wiring:** add `callWorkflowsServer` to `ServiceProxyInterface`
   (Direct + Http impls), a `/v1/workflows/*` controller (status/pair/unpair) and
   a same-origin reverse proxy for the n8n editor UI (see §5) so no CSP changes
   are needed.

## 4. The action catalog (your list, mapped to real capabilities)

| Action | Mechanism | Status |
|---|---|---|
| AI agent step | assistant proxy `/v1/assistant/*` (providers, per-user limits, metering already enforced) | exists — needs an n8n node |
| Create email / send email | server SMTP (nodemailer path used by backups/reminders) or n8n's built-in email nodes with the operator's SMTP creds | exists — thin node/config |
| Send a note (to someone) | **share link**: `POST /v1/shares` (E2E preserved — key stays in the URL fragment), then email/message the link | exists — needs a node |
| Send a PDF | valet-token file download (`/v1/files/valet-tokens`) for stored files; for note→PDF there is **no server-side renderer today** — Phase 2 adds a headless-render step (Puppeteer/Gotenberg sidecar) or attaches the shared-link | partial — gap flagged |
| Send message | in-app: reuse the websocket event path to raise a notification/toast for the user; external: n8n's own Slack/Telegram/etc. nodes | partial — define "message" target |
| **Create a note** | E2E constraint: the server cannot encrypt note content. Done via a **key-bearing runner** — the existing MCP bridge (snjs) which the user pairs with credentials; an "SRN Create Note" node calls the bridge | needs decision (§6 Q1) |

## 5. Client UI (exact wiring known from recon)

- `AppPaneId.Workflows` + `ElementIds.WorkflowsColumn` + `TABBABLE_PANES` entry;
  `WorkflowsSectionButton` rendered right after `FilesSectionButton` in
  `Navigation.tsx`; `WorkflowsView` case in `NoteGroupView.renderViewTab`.
- WorkflowsView = SRN-native header (status, pair/unpair, quotas, recent runs)
  + the **n8n editor embedded in a sandboxed iframe**, served same-origin via the
  gateway/nginx proxy (`/workflows-ui/` → n8n) so cookies + CSP stay clean.
  Sandbox/allow flags mirror `WebEmbedNode.tsx`'s vetted set; click-to-load.
- Feature-gated exactly like other server-dependent features (hidden signed-out).

## 6. Decisions (settled 2026-07-02)

1. **Note-creation path (E2E): key-bearing MCP bridge.** The existing MCP bridge
   (snjs) is the note-writing runner, paired with the user's credentials on
   their own host; trust boundary = the user's own server.
2. **n8n topology: one shared n8n container** on the internal docker network.
   **Settled (Phase 1 implementation): access is gated at the SRN proxy** —
   only entitled + explicitly PAIRED users can reach the editor through the
   authenticated `/workflows-ui` gateway proxy; the n8n container publishes no
   host port. Finding: n8n's public REST API does expose `POST /api/v1/users`
   (invite) and `POST /api/v1/credentials` on the community edition, BUT (a)
   the public API requires an owner-provisioned API key that only exists after
   manual owner setup, (b) invites are an email/URL acceptance flow, not silent
   provisioning, and (c) the community edition lacks credential *sharing*, so a
   credential created via the owner's API key cannot be handed to an invited
   member account. Per-user n8n accounts therefore buy little on community
   edition; the shared instance runs in single-owner mode and per-user
   enforcement lives at the SRN boundary, which this plan explicitly allows.
3. **Editor UI: embed n8n's editor** (sandboxed same-origin iframe). A native
   "simple mode" builder may come later.

## 7. Phases

- **Phase 1 — foundation:** n8n service in docker-compose (internal network, own
  volume); `WORKFLOWS_ENABLED` + `WorkflowsEnabled` admin flag + Admin-pane
  toggle; gateway `/v1/workflows/*` (status/pair/unpair) + same-origin UI proxy;
  sidebar section + WorkflowsView with pairing flow (provision n8n user, mint
  scoped MCP token, register SRN credential + webhooks); iframe embed.

### 7.1 Phase 1 server implementation status (done 2026-07-02)

**Shipped:**
- `SettingName.WorkflowsEnabled` (`WORKFLOWS_ENABLED`) in domain-core; added to
  `ADMIN_MANAGEABLE_SETTINGS` in auth's `BaseAdminController` with the strict
  'true'/'false' validator (mirrors `OcrServerAllowed`), and to the
  unencrypted/unsensitive lists in `SettingsAssociationService` so token minting
  reads it without per-user key material.
- Entitlement transport: `workflows_enabled` on the cross-service token
  (`CreateCrossServiceToken` emits it ONLY when the setting is literally 'true';
  absent = disabled, so existing tokens stay valid), projected onto
  `response.locals.settings` by the gateway `AuthMiddleware`. Note: admin
  toggles propagate on the next token mint (cross-service token cache TTL),
  same as `AiEnabled`.
- Gateway `WorkflowsController` (`/v1/workflows/status|pair|unpair`) behind
  `RequiredCrossServiceTokenMiddleware`, implementing the fixed contract
  (`{enabled, paired, editorUrl}` / `{paired: true, editorUrl}` / `{paired:
  false}`; 403 `workflows-disabled` / `workflows-not-allowed` when not
  entitled). Pairing state = JSON file store (`WorkflowsPairingStore`, default
  `./data/workflows/pairings.json`, override `WORKFLOWS_DATA_PATH`) — the
  api-gateway has no database; this mirrors the CalDAV/reminder-delivery
  stores. Caveat: pairing records live in the container filesystem, so a
  container REBUILD clears them — users simply re-pair (one click); move to a
  volume/db if that ever matters.
- Editor same-origin proxy: `/workflows-ui/` mounted on the gateway (and the
  app nginx forwards the same path to the gateway, keeping the iframe
  same-origin with the web app). The iframe cannot send an Authorization
  header, so the session-authed status/pair endpoints mint a short-lived
  (12h default), purpose-scoped, HttpOnly, path-scoped cookie (HS256,
  `AUTH_JWT_SECRET`); the proxy verifies it AND re-checks the master switch AND
  the pairing record on every request (unpair revokes on the next request).
  Streaming pipe over node http; n8n runs with `N8N_PUSH_BACKEND=sse` +
  `N8N_PATH=/workflows-ui/` so no WebSocket upgrade or path rewriting is
  needed. Caveat: deployments using `SHARED_SERVER_ACCESS_KEY_MODE=all` gate
  the iframe requests too (no header channel) — same class of caveat as CalDAV
  clients.
- docker-compose: optional `n8n` service under the `workflows` profile
  (internal network only, own `n8n-data` volume, healthcheck, hardened); the
  `server` service does NOT depend on it, so the stack is healthy without the
  image. `WORKFLOWS_ENABLED` (default false) + `WORKFLOWS_N8N_URL` in the
  shared server env.

**Deferred (honest gaps, in dependency order):**
1. **Scoped MCP token minting at pair time — deferred to Phase 2 (client-driven
   pairing step).** `CreateMcpToken` requires CLIENT-side wrapped key material
   (`wrappedKeys`/`kdfSalt`/`kdfParams`) that only the signed-in client can
   produce; the server alone cannot mint one. Additionally there is nowhere to
   put the credential yet: creating an n8n credential via its public API needs
   an owner-provisioned n8n API key (manual owner setup). Phase 2: the
   WorkflowsView pairing flow calls the existing `/v1/mcp-tokens` surface (as
   the MCP bridge does) and stores the resulting token as an n8n credential;
   `WorkflowsPairing.mcpTokenUuid` already reserves the bookkeeping slot.
2. **SRN webhook registration at pair time — deferred to Phase 2.** Webhook
   targets are per-workflow n8n URLs that only exist once the user has created
   a workflow with an SRN Trigger node (Phase 2). Registering a placeholder at
   pair time would deliver events nowhere. `WorkflowsPairing.webhookUuids`
   reserves the slot.
3. **Audit-log entries + `admin.action` webhook on pair/unpair — deferred to
   Phase 3 (as already planned there).** The audit writer and webhook
   dispatcher are auth-internal and not reachable from the gateway's HTTP
   deployment path; Phase 1 records pair/unpair as structured gateway log lines
   (`workflows.paired` / `workflows.unpaired` with user uuid + ip). Admin
   TOGGLES of the per-user flag DO get the full audit + `admin.action` webhook
   treatment already, via the existing `setUserFeatureFlag` path.
4. **Per-user n8n accounts — not pursued on community edition** (see §6.2
   finding); the SRN proxy is the enforcement point.
- **Phase 2 — SRN node package** (`n8n-nodes-standard-red-notes`): SRN Trigger
  (HMAC verify), AI Agent (assistant proxy), Share Note / Send Link, Send Email,
  Send File (valet), Create/Update Note (via MCP bridge), note→PDF sidecar.
- **Phase 3 — governance & polish:** per-user execution quotas + metering
  (mirror AiRequestLimit), run history in WorkflowsView, template gallery
  ("Summarize new notes with AI and email me weekly"), admin overview + audit
  log entries for pair/unpair and admin toggles.

## 8. Security invariants (non-negotiable)

- n8n never receives the user's master key, password, or session cookie — only a
  revocable, scoped MCP token held as an n8n credential.
- Webhook payloads stay metadata-only; signatures verified on both directions.
- Every `/v1/workflows/*` call re-validates session + `WorkflowsEnabled` + role
  where relevant; pairing/unpairing writes audit-log entries + `admin.action`
  webhooks like other admin-adjacent operations.
- The n8n container sits on the internal network only; its UI is reachable
  exclusively through the authenticated gateway proxy.
