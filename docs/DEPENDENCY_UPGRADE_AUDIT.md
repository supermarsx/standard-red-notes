# Dependency Upgrade Audit

Audit date: 2026-06-01

Commands run:

```powershell
npx --yes npm-check-updates@22.2.1 --workspaces --root --format group --target latest
npm view @yarnpkg/cli-dist version
npm view @modelcontextprotocol/sdk version
npm view turbo version
npm view typescript version
npm view eslint version
npm view prettier version
```

Latest key tooling versions found:

- Yarn CLI dist: `4.15.0`
- MCP TypeScript SDK: `1.29.0`
- Turborepo: `2.9.16`
- TypeScript: `6.0.3`
- ESLint: `10.4.1`
- Prettier: `3.8.3`
- npm-check-updates: `22.2.1`

## App Upgrade Findings

The app has safe patch/minor updates available, but the latest set also includes framework and tooling major upgrades:

- React `18.2.0` to `19.2.6`
- React Native `0.78.1` to `0.85.3`
- Electron `35.2.0` to `42.3.0`
- Jest `29` to `30`
- ESLint `8` to `10`
- TypeScript `5.8.3` to `6.0.3`
- Webpack dev server `4` to `5`
- Tailwind `3` to `4`

These should be split by platform. Web, desktop, and mobile have different runtime constraints and should not be upgraded in one lockfile-only commit.

## Server Upgrade Findings

The server has broad patch/minor updates and several high-risk major upgrades:

- Express `4` to `5`
- Inversify `6` to `8`
- TypeORM `0.3` to `1`
- SQLite `5` to `6`
- Jest `29` to `30`
- ESLint `9` to `10`
- TypeScript `5.0.4` to `6.0.3`
- OpenTelemetry packages across multiple incompatible major/minor lines

Express, Inversify, and TypeORM should each have dedicated branches with integration tests because they affect routing, dependency injection, and persistence.

## Upgrade Policy

1. Lock baseline build and test commands before changing runtime dependencies.
2. Apply patch/minor updates first per project.
3. Apply major updates one subsystem at a time.
4. Regenerate lockfiles in the same commit as package metadata.
5. Run web build, desktop build, server build, and MCP build before merging dependency branches.

The root monorepo package uses the latest audited versions for new tooling and MCP support. The nested app/server dependency graph has been audited, but mass-updating every package to latest in one commit is intentionally deferred because it would mix multiple breaking migrations.
