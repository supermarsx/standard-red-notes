# srn-server

An operational command-line tool for a self-hosted **Standard Red Notes** server
(the Docker stack defined by the repo's `docker-compose.yml`). It provides safe,
mostly non-destructive helpers for operators: health checks, stack status, logs,
config validation, and thin wrappers around `docker compose`.

It has **zero runtime dependencies** (Node built-ins only), so it is a standalone
package that never touches the app/server lockfiles.

## Install / build

```bash
cd cli/srn-server
npx tsc -p tsconfig.json     # or: node ../../node_modules/.bin/tsc -p tsconfig.json
node dist/index.js --help
```

Run it from inside the repo so it can auto-locate the repo root (the directory
containing `docker-compose.yml`); or pass `--repo <path>` from anywhere.
Requires Node 22+ and, for the docker-wrapping commands, Docker with the Compose
plugin on your PATH.

## Commands

| Command | Wraps / hits | Description |
| --- | --- | --- |
| `health` | HTTP `GET /healthcheck` | Probe the server healthcheck endpoint |
| `status` | `docker compose ps` | Show stack/service status |
| `logs [service]` | `docker compose logs` | Tail service logs |
| `up [service]` | `docker compose up -d` | Start the stack (`--build` to rebuild) |
| `down` | `docker compose down` | Stop the stack — **requires `--yes`** |
| `config` | reads `.env` (+ optional `docker compose config`) | Validate resolved required env vars |
| `version` | HTTP `GET /healthcheck` | Print CLI version and probe reachability |
| `help` | — | Show help |

`health` and `version` talk to the server over HTTP. `status`, `logs`, `up`, and
`down` shell out to `docker compose` from the repo root. `config` reads and
validates the `.env` file.

### Global options

```
--repo <path>       Repo root (default: auto-located via docker-compose.yml)
-h, --help          Show help
```

### health / version options

```
--url <url>         Server base URL (default http://localhost:3000 / $SRN_SERVER_URL)
--server-key <key>  X-Shared-Server-Key header value (or $SHARED_SERVER_ACCESS_KEY)
--timeout <ms>      Per-probe timeout (default 5000)
```

### logs / up / down / config options

```
logs:    -f, --follow      Follow output
         --tail <n>        Last N lines only
up:      --build           Rebuild images before starting
down:    --yes             REQUIRED confirmation to actually stop the stack
         --volumes         Also remove data volumes (DESTROYS ALL DATA)
config:  --env <path>      Path to the .env file (default <repo>/.env)
         --compose-config  Also print the resolved `docker compose config`
```

## Examples

```bash
srn-server health --url http://localhost:3000
srn-server config
srn-server status
srn-server logs server --tail 100 -f
srn-server up --build
srn-server down --yes
```

## Safety

- **Destructive ops are gated.** `down` refuses to run without an explicit
  `--yes`; adding `--volumes` (which deletes all data) is also opt-in and clearly
  warned. No other command stops or deletes anything.
- **Secrets are never printed.** `config` reports whether each required secret is
  present and well-formed (e.g. 64-char hex, no `CHANGE-ME` placeholder) but never
  echoes the secret value. It also reports whether the optional shared-server-key
  gate is enabled and in which mode.
