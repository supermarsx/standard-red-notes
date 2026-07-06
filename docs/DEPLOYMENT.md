# Deploying Standard Red Notes

There are **three** ways to run Standard Red Notes. All three self-host to
*themselves* (the web app syncs to its own origin — never `api.standardnotes.com`)
and keep your notes end-to-end encrypted.

| Mode | Containers / services | Datastore | Best for |
| --- | --- | --- | --- |
| **A. Full multi-container** (default) | app, server (6 node services under supervisord), MariaDB, Redis, floci (SNS/SQS) | MySQL + Redis | Production, many users, horizontal scaling, realtime push |
| **B. All-in-one single container** | 1 container (home-server + nginx under supervisord) | embedded **sqlite** + **in-memory** cache | Local use, a household/small team, the simplest Docker deploy |
| **C. LXC / systemd** | native systemd service + nginx (no Docker) | embedded **sqlite** + **in-memory** cache | Proxmox / lxd system containers, bare VMs, Docker-averse hosts |

Modes B and C run the **home-server**: a single Node process that mounts auth,
syncing, files, revisions and the api-gateway together, with **in-process domain
events** (no SNS/SQS) — so they need **no MySQL, no Redis, and no floci**. The
trade-off vs. Mode A: no horizontal scaling, and live realtime *push* (the
websocket bridge) is disabled without Redis, so clients fall back to normal
periodic sync. Everything else — accounts, notes, files, revisions, admin panel,
AI proxy, OCR, CalDAV — works the same.

---

## A. Full multi-container (existing, unchanged)

The original, production-grade stack. Nothing here changed.

```sh
cp .env.example .env          # set real secrets for any non-local deploy
docker compose up -d
# open http://localhost:3001
```

See the top of `docker-compose.yml` and `docs/self-hosting.md` for the full env
reference, reverse-proxy (Traefik) examples, and optional profiles (`mcp`,
`workflows`).

---

## B. All-in-one single container (new)

One image, zero external services. Ideal when you just want notes running on a
laptop, NAS, or a small VPS.

```sh
# Optional: copy the env template and set anything you want to customize
cp .env.single.example .env

# Build + run
docker compose -f docker-compose.single.yml up -d --build

# open http://localhost:3001  (change with APP_PORT)
```

**Secrets.** With none supplied, the container **generates strong per-instance
secrets on first boot and persists them** to the `single-data` volume
(`/data/secrets.env`), so sessions and encrypted MFA stay valid across restarts.
For a backup/restore-friendly deploy, pin them in `.env`
(`openssl rand -hex 32`; `ENCRYPTION_SERVER_KEY` must be 64 hex chars). There is
**no published-default-secret** to worry about — nothing insecure ships enabled.

**Persistence.** The named volume `single-data` holds the sqlite database,
uploaded files, generated secrets, admin overrides and feature stores (all under
`/data`). Back it up to back up the whole instance.

**Ports.** Only `8080` (nginx) is published, mapped to `APP_PORT` (default 3001).
The home-server's `:3000` stays container-internal; nginx reverse-proxies
`/v1`, `/auth`, `/files`, `/sockets` to it same-origin.

**Common env** (all optional; see `.env.single.example`):

| Var | Purpose |
| --- | --- |
| `APP_PORT` | Host port (default 3001) |
| `ADMIN_EMAILS` | Emails granted the in-app Admin panel |
| `PUBLIC_FILES_SERVER_URL` | Public `/files` URL behind a domain, e.g. `https://notes.example.com/files` |
| `COOKIE_DOMAIN`, `COOKIE_SECURE` | Set `COOKIE_SECURE=true` + your domain behind HTTPS |
| `SYNC_SERVER` | Force the app's sync origin (default: its own origin) |
| `OCR_ENABLED` | Client-side PDF OCR toggle |
| `SHARED_SERVER_ACCESS_KEY` | Optional access gate (`X-Shared-Server-Key`) |
| `ASSISTANT_*` | AI assistant proxy (Anthropic / OpenAI-compatible / Ollama) |

**Manage:**

```sh
docker compose -f docker-compose.single.yml logs -f
docker compose -f docker-compose.single.yml down          # keep data
docker compose -f docker-compose.single.yml down -v       # DELETE data volume
```

**Behind a reverse proxy / HTTPS.** Front the container with Caddy/nginx/Traefik
and set `COOKIE_SECURE=true`, `COOKIE_DOMAIN=…`, `PUBLIC_FILES_SERVER_URL=https://…/files`.

### Architecture

```
                 ┌────────────────────── single container ──────────────────────┐
  browser ─▶ 8080│  nginx  ──(127.0.0.1:3000)──▶  home-server (one Node process) │
                 │   │                              ├─ auth / syncing / files     │
                 │   └─ serves the web SPA          ├─ revisions / api-gateway    │
                 │      (+ CSP self-heal)           └─ sqlite + in-memory cache    │
                 │                                     + in-process events         │
                 │  supervisord runs nginx + home-server                          │
                 │  /data volume: sqlite, uploads, secrets                        │
                 └───────────────────────────────────────────────────────────────┘
```

Why nginx + home-server (not home-server serving static itself): it reuses the
app image's **CSP inline-script self-heal** (`app/docker/docker-entrypoint.sh`)
verbatim, so the served Content-Security-Policy hash always matches the served
inline bootstrap script across OCR/SYNC templating — the exact behavior the
multi-container app image already ships.

> **Note — sqlite migration compatibility shim.** Several of the server's sqlite
> migrations were authored MySQL-first (double-quoted SQL string literals), which
> the fork's `better-sqlite3` 12.x (SQLite with DQS off) rejects on first boot.
> Modes B and C therefore run `server/docker/single/fix-sqlite-migrations.js` at
> start/install: it rewrites those literals to single quotes in the **compiled**
> `dist/migrations/sqlite/*.js` only (never repo source), is idempotent, and
> becomes a no-op once the migrations are corrected upstream. Mode A (MySQL) is
> unaffected — it never executes the sqlite migrations.

---

## C. LXC / systemd (new)

Run natively (no Docker) inside a Debian/Ubuntu LXC system container or VM. Same
single-process backend as Mode B, installed as a systemd service with nginx in
front.

```sh
# inside a fresh Debian 12+/Ubuntu 22.04+ container, as root:
git clone https://github.com/<owner>/standard-red-notes.git /opt/standard-red-notes
cd /opt/standard-red-notes/deploy/lxc
REPO_URL=https://github.com/<owner>/standard-red-notes.git ./install.sh
```

Full copy-paste steps (Proxmox `pct` / `incus` container creation, upgrade,
backup, HTTPS) are in **`deploy/lxc/README.md`**. The installer is idempotent,
persists secrets under `/var/lib/standard-red-notes`, and installs
`standard-red-notes.service` (`journalctl -u standard-red-notes -f`).

---

## Opt-in container restart (Redis / MariaDB)

The admin panel (Preferences → Admin → Server) can restart the sibling **server**
processes out of the box — they run under supervisord inside the server container,
so the gateway drives them with allow-listed `supervisorctl` calls (no extra
setup). The **WebSocket gateway** control lives here too; because the realtime
gateway runs *in-process* inside the API gateway, that button restarts the
`api-gateway` program under the hood (it will briefly drop your admin connection).

The **Redis `cache`** and **MariaDB `db`** containers, however, run *outside* that
supervisord. Restarting them requires talking to the Docker daemon, which the
server container deliberately cannot do (the raw docker socket is never mounted
into it). This capability is therefore **OFF by default** and gated behind an
opt-in, least-privilege `docker-socket-proxy` sidecar.

**Security model**

- The raw `/var/run/docker.sock` is mounted **only** into the `docker-socket-proxy`
  container (read-only), **never** into the server container.
- The proxy denies everything by default; only `ALLOW_RESTARTS=1` is enabled, so
  the sole reachable Docker operation is *restart a container*. No image pull, no
  container create/exec, no volume/network access.
- The gateway restarts only an **allowlist** of container names (`cache`, `db`);
  any other name is rejected before any HTTP call.
- When the flag is off or the proxy is unreachable, the endpoint returns 503 and
  the UI shows the controls as unavailable — never an error.

**Enable it**

1. Start the proxy with the `ops` compose profile (additive — the base
   `docker compose up` is unchanged):

   ```sh
   docker compose --profile ops up -d docker-socket-proxy
   ```

2. Turn the capability on for the server and point it at the proxy, then recreate
   the server so it picks up the env:

   ```sh
   # in your .env (or the shell environment used for compose)
   SERVICE_CONTROL_DOCKER_ENABLED=true
   SERVICE_CONTROL_DOCKER_PROXY_URL=http://docker-socket-proxy:2375

   docker compose --profile ops up -d
   ```

   Container names default to `<project>-<service>-1` (e.g.
   `standard-red-notes-cache-1`), matching the compose project `name:`. Override
   the project prefix with `SERVICE_CONTROL_DOCKER_PROJECT`, or map names
   explicitly with `SERVICE_CONTROL_DOCKER_CONTAINERS=cache=my-redis,db=my-mariadb`.

Once enabled and reachable, an "Infrastructure containers" section appears under
**Server health** with a danger-confirmed **Restart** for Redis and MariaDB. Every
restart is admin-gated and audit-logged (`admin.container-control`). To turn the
feature back off, unset `SERVICE_CONTROL_DOCKER_ENABLED` and stop the proxy
(`docker compose --profile ops stop docker-socket-proxy`).

---

## Verifying the CSP self-heal

Modes B and C serve the SPA with a Content-Security-Policy that pins the single
inline bootstrap `<script>` by its sha256. The served hash is recomputed from the
*actual served* script at start/install, so it always matches. To verify:

```sh
BASE=http://localhost:3001        # or your host

# 1. Extract the sha256 the served CSP pins:
curl -fsSI "$BASE/" | tr ';' '\n' | grep -o "sha256-[A-Za-z0-9+/=]*"

# 2. Hash the served inline script body and compare (Linux/macOS shell):
curl -fsS "$BASE/" \
  | awk 'BEGIN{RS="</script>"} /<script>/{ sub(/.*<script[^>]*>/,""); print; exit }' \
  | tr -d '\n' > /tmp/inline.js
printf 'sha256-%s\n' "$(openssl dgst -binary -sha256 /tmp/inline.js | openssl base64)"
```

The token from step 1 and step 2 must match (when they do, the pin is intact; if
the entrypoint ever falls back, step 1 shows `unsafe-inline` instead and the app
still boots). The container's own build/curl verification is captured in the PR
description.
```
