---
title: Capability Map
description: An evidence-backed map of Standard Red Notes clients, services, tools, and operator surfaces.
---

# Capability Map

Standard Red Notes is more than the browser application. The repository ships
web, desktop, and mobile clients, two operator-facing CLIs, an encrypted note
CLI, an MCP bridge, the OpenClaw assistant, server administration, and several
backup and integration paths.

This page separates three important states:

- **Shipped** means executable code and tests or release automation are present.
- **Operator-gated** means the implementation is present but an administrator
  must enable or configure it.
- **Planned** means the repository contains a design document, not a promise
  that the complete design is available at runtime.

## Product surfaces

| Surface | Status | What is present | Primary evidence |
| --- | --- | --- | --- |
| Web app | Shipped | Encrypted notes, files, search, editors, vaults, sharing, backups, assistant UI, preferences, and administration | [`app/packages/web`](../app/packages/web) |
| Desktop app | Shipped | Electron client, keychain integration, automatic local backups, multiple windows, tray behavior, deep links, file access, and updates | [`app/packages/desktop`](../app/packages/desktop) |
| Android and iOS | Shipped | React Native shell around the web bundle, native keychain and biometric support, privacy protection, file handling, notifications, and OS share targets | [`app/packages/mobile`](../app/packages/mobile) |
| Browser clipper | Shipped from source | Firefox MV2 and Chromium MV3 builds; selected content, a DOM node, or a Readability article can be sent to the app | [`app/packages/clipper`](../app/packages/clipper) |
| Home server | Shipped | Containerized API gateway, authentication, sync, files, revisions, scheduler, WebSocket, database, Redis, and web client | [`docker-compose.yml`](../docker-compose.yml) and [`server/packages`](../server/packages) |
| `srn-client` | Shipped | Headless encrypted note CRUD, import, export, profiles, and secure local session storage | [`cli/srn-client/README.md`](../cli/srn-client/README.md) |
| `srn-server` | Shipped | Health, status, logs, compose lifecycle, and configuration checks | [`cli/srn-server/README.md`](../cli/srn-server/README.md) |
| `srn-admin` | Shipped | User, role, group, registration, webhook, integration, security, limit, diagnostics, and audit operations | [`SrnAdminCli.ts`](../server/packages/auth/src/Infra/Cli/SrnAdminCli.ts) |
| MCP bridge | Shipped | Local stdio and authenticated HTTP transports with note, tag, vault, and health tools | [`mcp/src/index.ts`](../mcp/src/index.ts) |
| OpenClaw | Shipped | `doctor`, one-shot `ask`, and interactive `chat` over a separately installed local MCP bridge | [`openclaw/README.md`](../openclaw/README.md) |

## Server capability groups

| Group | Status | Notes |
| --- | --- | --- |
| End-to-end encrypted sync | Shipped | Clients encrypt and decrypt item payloads. The server stores and distributes encrypted item data. |
| Files and revisions | Shipped | Dedicated services support encrypted file transfer and note revision history. |
| Realtime updates | Shipped, per-user controllable | WebSocket infrastructure pushes changes; an administrator can disable realtime for a user without disabling manual sync. |
| Shared vaults | Shipped, entitlement-gated | Invitations and `read`, `write`, and `admin` permissions are enforced by server save rules. |
| Public and burn-after-reading shares | Shipped | Public links intentionally disclose the shared payload to anyone holding the link; burn links add one-time retrieval behavior. |
| App passwords and MCP tokens | Shipped, with MCP limitations | App passwords still require the account password. A full MCP token carries wrapped items keys and can decrypt without the password; read-only/write mode is enforced, but selected-tag scope is not enforced by the current bridge. Token deletion blocks new authentication but does not erase an already-issued session or local decrypted data. |
| Trusted-device and push MFA | Shipped | New sign-ins can be approved from a trusted session; pending challenges and trusted devices have dedicated endpoints. |
| User administration and RBAC | Shipped | The web console and CLI cover users, roles, groups, effective permissions, registration policy, bans, suspension, and audit. |
| Email backups | Operator-gated | The server master switch and per-user settings must both allow the scheduled encrypted backup. |
| Nextcloud/WebDAV backups | Operator-gated | The server master switch and complete per-user WebDAV settings are required. |
| OCR | Operator-gated | Server OCR has a master switch, URL, request limits, and an admin configuration surface. |
| Workflows/n8n | Operator-gated link discovery | The gateway returns a strictly validated separate-origin link. n8n owns authentication, authorization, project isolation, and credentials. Operators can manually connect n8n to the SRN MCP bridge. |
| Plugins repository | Operator-gated | The gateway can proxy a configured package index and component files with rendering isolation controls. |
| GitHub publishing | Configured integration | A server endpoint and web client publish one converted note to a configured GitHub target. |
| CalDAV | Read-only and per-user gated | The server exposes a read-only calendar surface when the administrator enables the user setting. |

## Documentation taxonomy

The repository previously had strong pages for the in-app guide, API,
self-hosting, deployment, production gates, and hardening. The following topic
groups needed dedicated runtime documentation:

| Missing topic group | New reference |
| --- | --- |
| Client differences and installation boundaries | [Client Platforms](client-platforms.md) |
| Sync, offline state, conflicts, revisions, and deletion | [Sync and Data Lifecycle](sync-and-data-lifecycle.md) |
| Authentication, credentials, recovery, and trust boundaries | [Security and Account](security-and-account.md) |
| Vault permissions, invitations, and public sharing | [Sharing and Collaboration](sharing-and-collaboration.md) |
| User exports through infrastructure restoration | [Backups and Recovery](backups-and-recovery.md) |
| MCP runtime rather than the design plan | [MCP Bridge](mcp-bridge.md) |
| OpenClaw runtime rather than the design plan | [OpenClaw](openclaw.md) |
| All three command-line surfaces | [Command-Line Tools](command-line-tools.md) |
| Web and CLI administration | [Administration](administration.md) |
| Shipped integrations and their gates | [Automation and Integrations](automation-and-integrations.md) |
| n8n deployment, isolation, and MCP bridge use | [Workflows with n8n](workflows.md) |
| Layered diagnosis and safe incident response | [Monitoring and Troubleshooting](monitoring-and-troubleshooting.md) |
| Release streams, assets, upgrades, and rollback | [Releases and Upgrades](releases-and-upgrades.md) |
| Monorepo structure and verification commands | [Development Guide](development-guide.md) |

## How to verify a capability claim

For a high-confidence answer, use more than a visible control:

1. Find the client entry point or CLI command.
2. Find the server route or service that executes the operation.
3. Check the environment or persisted setting that gates it.
4. Find the focused test or release contract.
5. Verify the deployed profile actually includes the required service.

A design document is useful intent evidence, but it is not runtime evidence.
Use [Workflows with n8n](workflows.md) for the implemented boundary. The
[MCP support plan](MCP_SUPPORT_PLAN.md) and [OpenClaw plan](OPENCLAW_PLAN.md)
should be read with that distinction.
