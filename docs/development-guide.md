---
title: Development Guide
description: Repository structure, toolchains, focused verification, and change discipline for Standard Red Notes contributors.
---

# Development Guide

Standard Red Notes is a multi-root monorepo. The root workspace owns MCP and
OpenClaw; the application and server retain their own workspace roots and build
systems. The root scripts compose those systems into repository-wide gates.

## Repository map

| Path | Responsibility |
| --- | --- |
| `app/packages/web` | Main web application and shared UI |
| `app/packages/desktop` | Electron shell and native desktop services |
| `app/packages/mobile` | React Native mobile shell and native adapters |
| `app/packages/clipper` | Firefox/Chromium browser extension |
| `app/packages/snjs` | Client protocol, item, encryption, sync, and service logic |
| `server/packages/api-gateway` | Public routing, admin, integrations, OCR, workflows, CalDAV |
| `server/packages/auth` | Accounts, sessions, roles, settings, audit, workers, `srn-admin` |
| `server/packages/syncing-server` | Item sync, shared-vault enforcement, backup events |
| `server/packages/files` | Encrypted file transfer |
| `server/packages/revisions` | Revision storage and retrieval |
| `server/packages/websocket-gateway` / `websockets` | Realtime token and socket paths |
| `mcp` | Headless Standard Notes MCP bridge |
| `openclaw` | Provider-driven CLI assistant over MCP |
| `cli/srn-client` | Standalone encrypted note CLI |
| `cli/srn-server` | Standalone operator/Compose CLI |
| `e2e` | Cross-component browser and operations tests |
| `scripts` | CI, coverage, release, backup, docs, and hardening contracts |
| `docs` | Jekyll documentation site |

## Toolchain

Repository-wide development uses Node.js 26 and Yarn 4.17.1. Some standalone
CLI packages declare Node 24+, but use the root toolchain when changing multiple
components. Docker with the Compose plugin is required for live server and
cross-service tests.

Install from the repository root:

```bash
corepack enable
yarn install --immutable
```

Do not regenerate an app or server lockfile from the wrong workspace root.

## Common commands

```bash
yarn build
yarn typecheck
yarn lint
yarn format:check
yarn test
yarn check
```

The root `build` covers MCP, OpenClaw, app, and server. `check` runs typecheck,
lint, formatting, and tests. The server test command builds before running its
tests.

Use focused commands while iterating:

```bash
yarn workspace @standard-red-notes/mcp typecheck
yarn workspace @standard-red-notes/mcp test
yarn workspace @standard-red-notes/openclaw typecheck
yarn workspace @standard-red-notes/openclaw test
cd app && yarn test
cd server && yarn build && yarn test
```

Then run the repository-level gate appropriate to the change.

## Contract and operations gates

| Command | Contract |
| --- | --- |
| `yarn ci:contracts` | CI tooling, generated app-docs/search consistency, and docs link integrity |
| `yarn ci:docker-hardening` | Container user, permissions, secrets, and installed admin wrapper |
| `yarn ci:verify-playwright` | Required Playwright report evidence |
| `yarn release:contract` | Release workflows, assets, matrices, and provenance |
| `yarn ops:backup-restore` | Backup/restore script contract |
| `yarn ops:load` | Operations load suite |
| `yarn deps:security:owned` | Recursive dependency vulnerability audit |
| `yarn coverage` | App/server coverage collection and report generation |

Run `git diff --check` before committing.

## Change workflow

1. Reproduce the behavior or identify the source contract.
2. Trace the complete path: client, API, service, persistence, restart, and
   recovery where applicable.
3. Add the smallest focused test that would fail without the change.
4. Implement within the owning package.
5. Run focused typecheck/test/format gates.
6. Run cross-package or contract gates for touched boundaries.
7. Inspect the actual diff for generated files, secrets, and unrelated changes.
8. Update runtime documentation when configuration, behavior, safety, or
   recovery changes.

For feature gates, test all four states: master off, user off, both on, and
stale/invalid client input. Authorization must fail closed at the server.

## End-to-end encryption changes

Changes around keys, serialization, sync, recovery, sharing, files, assistant
content, OCR, or backup require explicit boundary review:

- What is plaintext and where?
- Which process receives it?
- What is persisted or logged?
- Can authorization be bypassed by a modified client?
- What happens offline, on retry, and during conflict?
- How is access revoked?
- How is data restored?

Use real wire/E2E tests where possible rather than only mocking the API.

## Server settings and persistence

Several operator settings use a persisted runtime overlay layered over
environment defaults. A change is incomplete if only the admin control exists.
Verify:

- read and write API;
- validation and sensitive-value withholding;
- effective precedence;
- live/restart behavior;
- container persistence/mounting;
- CLI parity or recovery path;
- audit evidence; and
- tests for missing/corrupt settings.

## Documentation

Documentation pages use YAML front matter and Markdown. Internal links should
point to repository docs rather than generated `.html` when authoring. Mermaid
pages include `{% raw %}{% include mermaid.html %}{% endraw %}` once and use
fenced `mermaid` blocks.

Do not hand-edit generated search or coverage artifacts unless the generating
script identifies them as source files. Run the documented generator/checker
and commit source plus generated output together when the contract requires it.

```bash
# Rebuild after changing any documentation page
yarn docs:search:index

# Check generated docs, search freshness, screenshots, links, navigation,
# code fences, prose contracts, and every Mermaid diagram
yarn docs:check
```

The link gate also requires every top-level page to appear in
`docs/_data/navigation.yml`; add the page and its substantive headings to the
correct runtime or reference group rather than leaving it discoverable only
through search. It also rejects redundant Markdown horizontal rules and
roadmap-style wording that mislabels shipped MCP or OpenClaw functionality.

## Commit discipline

Keep commits coherent by concern. Avoid mixing dependency churn, generated
artifacts, UI behavior, server persistence, and documentation when they can be
reviewed independently. A clean final status and exact validation record make
later release and incident work substantially safer.
