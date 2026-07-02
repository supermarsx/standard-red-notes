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

---

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
   Per-user n8n accounts are provisioned at pairing time where the n8n edition
   allows; if community-edition user-management APIs are too limited, access is
   instead gated at the SRN proxy (only entitled + paired users can reach the
   editor) — implementation picks the feasible variant and documents it.
3. **Editor UI: embed n8n's editor** (sandboxed same-origin iframe). A native
   "simple mode" builder may come later.

## 7. Phases

- **Phase 1 — foundation:** n8n service in docker-compose (internal network, own
  volume); `WORKFLOWS_ENABLED` + `WorkflowsEnabled` admin flag + Admin-pane
  toggle; gateway `/v1/workflows/*` (status/pair/unpair) + same-origin UI proxy;
  sidebar section + WorkflowsView with pairing flow (provision n8n user, mint
  scoped MCP token, register SRN credential + webhooks); iframe embed.
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
