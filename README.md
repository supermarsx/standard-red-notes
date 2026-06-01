# Standard Red Notes

Standard Red Notes is a private fork workspace that brings the Standard Notes app and server into one repository, adds a new MCP bridge package, and tracks the work required to make the self-hosted product fully featured.

This repository currently preserves the upstream package boundaries:

- `app/` - web, desktop, mobile, shared client packages.
- `server/` - auth, sync, files, revisions, websockets, home server, and supporting packages.
- `mcp/` - Standard Red Notes MCP bridge bootstrap.

The app and server still use their upstream Yarn projects internally. The root package is a coordinator for monorepo scripts and new packages while the larger workspace migration is phased in.

## Commands

```powershell
yarn install
yarn build:mcp
yarn start:mcp
yarn deps:audit
```

The full app and server builds still run through their existing project-level scripts:

```powershell
yarn --cwd app build:all
yarn --cwd server build
```

## Product Direction

The fork defaults should target a self-hosted Standard Red Notes server, not the hosted Standard Notes service. Full-feature access should be provided by server-issued self-hosted entitlements and roles. Do not implement client-side bypasses for third-party hosted services.

See:

- [Roadmap](docs/ROADMAP.md)
- [MCP Support Plan](docs/MCP_SUPPORT_PLAN.md)
- [Full Feature Entitlement Plan](docs/FULL_FEATURE_ENTITLEMENT_PLAN.md)
- [Dependency Upgrade Audit](docs/DEPENDENCY_UPGRADE_AUDIT.md)
- [Fork Compliance Notes](docs/FORK_COMPLIANCE.md)
