---
title: Dependency Upgrade Audit
description: Dependency upgrade audit notes.
---

# Dependency Upgrade Audit

Audit date: 2026-07-15

The audit covers the root workspaces, `cli/`, `e2e/`, `mcp/`, `openclaw/`,
repository workflows, and deployment files. The independent `app/` and
`server/` dependency graphs are intentionally excluded.

Authoritative checks used the npm and PyPI registries, the Node.js and Python
release indexes, GitHub repository tags, and Docker Hub image tags/manifests.
The repeatable npm check is:

```powershell
npx --yes npm-check-updates@22.2.9 --workspaces --root --format group --target latest
yarn deps:audit:cli-client
yarn deps:audit:cli-server
yarn deps:audit:e2e
```

## Current Toolchains

| Toolchain | Version |
| --- | --- |
| Root CI/tooling runtime | Node.js `26.5.0` |
| Yarn | `4.17.1` |
| Root CI/MCP Corepack | `0.35.0` |
| TypeScript | `7.0.2` |
| esbuild | `0.28.1` |
| Prettier | `3.9.5` |
| npm-check-updates | `22.2.9` |
| Turborepo | `2.10.5` |
| Python (macOS native build) | `3.14.6` |
| `@yao-pkg/pkg` | `6.21.0` |

`@yao-pkg/pkg` 6.21.0 only publishes Node 22 and Node 24 base binaries. CI
hosts use Node 26, while packaged CLI and MCP bundles continue to target the
latest supported embedded runtime, `node24`.

## Current Images

| Image | Version |
| --- | --- |
| MCP Dockerfile frontend | `docker/dockerfile:1.25.0` |
| MCP Node Alpine | `node:26.5.0-alpine3.23` |
| Single-container Dockerfile frontend | `docker/dockerfile:1.7` (upgrade deferred) |
| Single-container Node Alpine | `node:24-alpine` (upgrade deferred) |
| Single-container Node Debian slim | `node:24-bookworm-slim` (upgrade deferred) |
| n8n | `n8nio/n8n:2.30.5` |
| MariaDB | `mariadb:12.3.2` |
| Redis | `redis:8.8.0-alpine` |
| Floci | `floci/floci:1.5.33-compat` |
| Docker socket proxy | `tecnativa/docker-socket-proxy:v0.4.2` |

`n8nio/n8n:2.31.1` exists, but the upstream npm and container registries mark
it as `beta`/`next`/`rc`. Version `2.30.5` is the newest release on both the
`stable` and `latest` channels, so deployments use that exact tag.

## Current Actions

| Action | Major tag | Latest release checked |
| --- | --- | --- |
| `actions/checkout` | `v7` | `v7.0.0` |
| `actions/setup-node` | `v7` | `v7.0.0` |
| `actions/upload-artifact` | `v7` | `v7.0.1` |
| `actions/download-artifact` | `v8` | `v8.0.1` |
| `actions/setup-python` | `v6` | `v6.3.0` |
| `softprops/action-gh-release` | `v3` | `v3.0.2` |

The major tags above and their release refs were checked through the GitHub API
on the audit date. Root workflow lint covers every file under
`.github/workflows/`; nested `app/` and `server/` workflows remain independently
owned and are outside this audit.

## Compatibility Exceptions

- `@standardnotes/domain-core@1.41.3` still declares `uuid@^9.0.0`, whose newest
  compatible release is affected by GHSA-w5hq-g745-h8pq. The package only calls
  `uuid.v4()` without the affected caller-provided buffer path, but the root
  lockfile nevertheless resolves `uuid` to the first patched line, `11.1.1`.
  Root typechecks, builds, and tests validate that narrow major override.
- Hadolint rules DL3008 and DL3018 are ignored for distro packages. Exact
  Alpine/Debian package revisions are architecture- and mirror-specific and can
  make a pinned base image unbuildable after repository rotation. Outside the
  deferred single-container exception below, container bases, language package
  managers, Python packages, and Dockerfile frontend versions remain exact; all
  other Hadolint warnings still fail validation.
- The `Dockerfile.single` Node/Corepack/Supervisor upgrade is not retained. Its
  isolated build reached the app workspace focus step, where the in-progress app
  Yarn migration failed while loading `plugin-docker-build`. Resolving that
  requires an independently owned `app/` change, so the single-container file
  remains on its previously validated Node 24 contract until the app migration
  can be tested end to end.

## Upgrade Policy

Dependabot checks the root Yarn workspaces, each lockless standalone npm
package, GitHub Actions, and the owned Dockerfile locations every week. Major,
minor, and patch updates remain enabled. No policy entry targets `app/` or
`server/`.

Root lockfile changes must be generated with the declared Yarn version and land
with the matching manifest changes. Standalone CLI and e2e packages deliberately
retain their existing lockless `npm install --no-package-lock` CI contract.
