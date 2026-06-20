# Standard Red Notes Roadmap

## Current State

- App and server are separate upstream monorepos checked out under one folder.
- The app is AGPL-licensed and has web, desktop, mobile, SNJS, services, encryption, files, and UI packages.
- The server is AGPL-licensed and has auth, sync, files, revisions, websockets, home-server, analytics, and shared domain packages.
- Upstream subscription behavior is implemented through server roles, subscription records, offline codes, feature status checks, and client premium modals.
- Dependency updates to the current latest releases include many major upgrades, including React 19, Electron 42, Express 5, Inversify 8, TypeORM 1, Jest 30, ESLint 10, and TypeScript 6.

## Principles

- Keep cryptography and zero-knowledge sync behavior intact.
- Make full features the default self-hosted product mode, not an entitlement or client-side bypass.
- Rebrand visible product surfaces while preserving upstream copyright and AGPL notices.
- Move in small vertical slices with build and migration checkpoints.
- Add MCP access only where user data can be handled safely, locally, and with explicit permission.

## Phase 1 - Monorepo Foundation

- Initialize root git repository and GitHub remote.
- Keep `app/` and `server/` as nested projects initially.
- Add root scripts for build, test, lint, dependency audit, and MCP development.
- Add root documentation for roadmap, MCP, dependency updates, no-entitlement design, and fork compliance.
- Avoid committing Yarn caches and runtime data in the new root repo.

## Phase 2 - Brand Baseline

- Replace first-load web metadata with Standard Red Notes branding.
- Point default web service URLs at local/self-hosted services.
- Update desktop package product metadata and bundle identifiers.
- Replace visible support, website, release, and help links with fork-owned destinations.
- Leave protocol migration details explicit, especially `standardnotes://` compatibility and local database identifiers.

## Phase 3 - No-Entitlement Full Feature Mode

- Add server configuration:
  - `STANDARD_RED_FEATURES_MODE=included|legacy`
  - `STANDARD_RED_FILE_UPLOAD_BYTES_LIMIT=-1`
  - `STANDARD_RED_STORAGE_QUOTA_BYTES=-1`
  - `STANDARD_RED_MAX_SHARED_VAULTS=-1`
- Keep `STANDARD_RED_ENTITLEMENT_MODE=provisioned-full` only as a deprecated compatibility bridge for old subscription-row provisioning.
- Return included, non-expiring feature and subscription-shaped responses by default without requiring subscription records.
- Add a capability endpoint so web, desktop, mobile, and MCP clients can consume included-feature state directly.
- Move file limits, storage quotas, and sharing limits to neutral operational settings.
- Remove premium modals, purchase flows, plans links, subscription dashboard links, and offline subscription-code UI from included mode.

## Phase 4 - Feature Completion Pass

- Confirm editor availability: plain, rich text, markdown variants, spreadsheets, tasks, code, and super editor.
- Confirm file flows: upload, download, preview, backups, file limits, and storage quotas.
- Confirm account flows: registration, login, MFA, sessions, recovery messaging, offline mode, and home server.
- Confirm collaboration flows: vaults, invites, contacts, shared subscription screens, and role messaging.
- Confirm export/import flows: encrypted backup, plaintext export, data import, file backup, and desktop backups.
- Remove purchase CTAs from self-hosted mode and replace with included-feature status or admin guidance.

## Phase 5 - MCP Support

- Ship a local stdio MCP server first for desktop and developer workflows.
- Add a Streamable HTTP MCP service only after auth, CSRF, DNS rebinding, and audit logging are in place.
- Expose decrypted note content only from a local client-side process after unlock and permission approval.
- Keep server-side MCP tools limited to encrypted item metadata, admin/status operations, and sync diagnostics unless a trusted client decrypts content locally.

## Phase 6 - Dependency Upgrade Program

- Freeze baseline builds for app web, desktop, mobile, server, and MCP.
- Apply patch and minor upgrades first, regenerate lockfiles, and run typecheck/test/build.
- Upgrade framework majors in dedicated branches:
  - React 19 and React Native 0.85
  - Electron 42 and builder/signing changes
  - Express 5 with route and middleware compatibility checks
  - Inversify 8 and inversify-express-utils compatibility
  - TypeORM 1 and migration behavior
  - Jest 30, ESLint 10, TypeScript 6
- Remove deprecated packages and replace unsupported loaders/plugins after framework upgrades.

## Phase 7 - Monorepo Unification

- Choose one package manager policy for the full repo.
- Move root workspace ownership from only `mcp/` to all app/server packages once lockfiles are stable.
- Normalize TypeScript project references and package build order.
- Replace duplicated lint/prettier/test config where the codebases agree.
- Add CI pipelines that build affected packages and full release candidates.

## Phase 8 - Release and Operations

- Add Docker compose for local app, server, files, and websocket development.
- Add seeded dev users for full-feature mode.
- Add backup and restore docs for self-hosted deployments.
- Add release artifacts for web, desktop, server images, and MCP package.
- Add security docs covering AGPL source offer, secrets, MCP permissions, and update cadence.
