---
title: Architecture
description: End-to-end architecture for Standard Red Notes.
---

# Architecture

Standard Red Notes keeps the upstream Standard Notes package split while adding a
self-hosted operational layer around it. The user-facing client, server-side
services, files, realtime relay, command-line tools, and MCP bridge are separate
concerns with explicit boundaries.

## Runtime Shape

| Layer | Path | Responsibility |
| --- | --- | --- |
| Web app | `app/packages/web` | Browser client, local encryption/decryption, note editing, settings, admin UI, files UI, and local IndexedDB state. |
| Shared client packages | `app/packages/*` | Models, crypto helpers, services, editors, icons, styles, mobile/desktop shared code. |
| API gateway and services | `server/packages/*` | Auth, sync, files metadata, revisions, gateway routing, websocket gateway, scheduled jobs, server settings, and admin endpoints. |
| Single-container server | `Dockerfile.single`, `docker-compose.single.yml` | Small/self-hosted deployment profile: web app plus all-in-one home server with SQLite and persisted data volume. |
| Multi-container stack | `docker-compose.yml` | Production-grade layout with app, gateway, auth/sync/files/revisions services, MySQL, Redis, and queue emulator. |
| CLI tools | `cli/` and `server/packages/auth/bin/srn_admin.ts` | User-facing encrypted note CLI, operator CLI, and in-container admin helper. |
| MCP bridge | `mcp/` | Stdio bridge for MCP-capable clients using scoped app passwords/tokens. |
| Docs and validation | `docs/`, `e2e/` | Operator docs, API docs, Playwright smoke/correctness/stress tests, and screenshot capture. |

## Request Flow

1. The browser loads the web app from the app front door.
2. The app uses same-origin paths for sync, files, auth, and websockets by
   default.
3. The client encrypts notes/files before sending them to server endpoints.
4. The gateway routes API calls to auth, sync, files, revisions, and realtime
   services.
5. Server settings and admin registration controls are stored as an overlay so
   operator changes apply without rebuilding the image.
6. Realtime updates travel through the websocket gateway when available, with
   HTTP sync remaining the fallback path.

## Encryption Boundary

The server stores ciphertext for note contents and file payloads. Features that
need plaintext either run locally in the client or require explicit operator/user
configuration, such as optional AI assistant providers. When an optional feature
sends content outside the browser, the UI and docs should name that boundary
plainly.

## Deployment Profiles

Use the single-container profile for local evaluation, small deployments, and
simple backups. Use the multi-container stack when you want independent service
scaling, MySQL/Redis, or a reverse-proxy-managed production layout.

## Validation Layers

| Check | Scope |
| --- | --- |
| Unit/render tests | Component behavior, helpers, search, settings panes, editor utilities. |
| TypeScript builds | Package contracts and frontend/server compile integrity. |
| Docker config/build checks | Deployment wiring, environment shape, and image construction. |
| Playwright app-open tests | Real browser bootstrap, styling, console errors, and app responsiveness. |
| Playwright correctness/stress tests | IndexedDB reload integrity, search/tag references, sync push/pull, and large-vault behavior. |

See [Validation](validation.md) for the practical commands.
