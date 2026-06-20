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

## Self-hosting

The fastest way to run your own server is the setup script, which generates a
complete `.env` (with securely-generated secrets), lets you customize the
domain/ports, and brings the Docker Compose stack up.

```bash
# macOS / Linux
./scripts/setup.sh

# Windows (PowerShell)
./scripts/setup.ps1
```

Then open `http://localhost:3001`. Add `--up` (bash) / `-Up` (PowerShell) to
start the stack automatically, or `--yes` / `-Yes` to accept all defaults.

See [docs/self-hosting.md](docs/self-hosting.md) for the full guide: the
5-minute tutorial, what each service does, every environment variable explained,
choosing a domain/ports, start/stop/upgrade, where data lives, and
backup/restore + troubleshooting. `.env.example` documents every key.

## Docker

```powershell
yarn docker:config
yarn docker:up
```

The compose stack builds the web app, all-in-one self-hosted server, MySQL,
Redis, LocalStack SNS/SQS, and an optional MCP stdio image. The web app is
served on `http://localhost:3001`, the API gateway on `http://localhost:3000`,
and the files service on `http://localhost:3125`. The server defaults to
`STANDARD_RED_FEATURES_MODE=included`, so feature and subscription queries return
full included access without subscription provisioning.

Start the MCP container only when a client needs a stdio bridge:

```powershell
docker compose --profile mcp run --rm mcp
```

## Product Direction

The fork defaults should target a self-hosted Standard Red Notes server, not the hosted Standard Notes service. Full-feature access is the baseline product mode, not a subscription or entitlement. Do not implement client-side bypasses for third-party hosted services.

See:

- [Roadmap](docs/ROADMAP.md)
- [MCP Support Plan](docs/MCP_SUPPORT_PLAN.md)
- [No-Entitlement Plan](docs/NO_ENTITLEMENT_PLAN.md)
- [Dependency Upgrade Audit](docs/DEPENDENCY_UPGRADE_AUDIT.md)
- [Fork Compliance Notes](docs/FORK_COMPLIANCE.md)
