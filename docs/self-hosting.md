---
title: Self-hosting
description: Run your own fully featured Standard Red Notes server.
---

# Self-hosting Standard Red Notes

Run your own fully-featured Standard Red Notes server with Docker
Compose. One setup script generates a correct `.env` (with securely-generated
secrets), then a single `docker compose up` brings the whole stack online.

Standard Red Notes is licensed under AGPL-3.0; it is a self-hosted fork of
Standard Notes. See the [LICENSE](../LICENSE.md) file for details.

- [Deploy in 5 minutes](#deploy-in-5-minutes)
- [What the stack contains](#what-the-stack-contains)
- [Prerequisites](#prerequisites)
- [Configuration (the `.env` file)](#configuration-the-env-file)
- [Choosing a domain and ports](#choosing-a-domain-and-ports)
- [Running behind a reverse proxy](#running-behind-a-reverse-proxy)
- [Start, stop, and upgrade](#start-stop-and-upgrade)
- [Where your data lives](#where-your-data-lives)
- [Backup and restore](#backup-and-restore)
- [Troubleshooting](#troubleshooting)

---

## Deploy in 5 minutes

A friendly walkthrough for a first-time, single-machine install. By the end you
will have the web app open in your browser.

### 1. Get the code

```bash
git clone <your-repo-url> standard-red-notes
cd standard-red-notes
```

### 2. Run the setup script

The script checks that Docker is installed, asks a few questions (you can press
Enter through them for a localhost install), generates all the secrets, and
writes a complete `.env` file.

**macOS / Linux**

```bash
./scripts/setup.sh
```

**Windows (PowerShell)**

```powershell
./scripts/setup.ps1
```

> Tip: add `--up` (bash) or `-Up` (PowerShell) to build and start the stack
> automatically once the `.env` is written. Add `--yes` / `-Yes` to accept all
> defaults without prompts.

### 3. Start the stack (if you didn't use `--up`)

```bash
docker compose up -d --build
```

The first run downloads images and builds the app and server, which can take a
few minutes. Watch progress with `docker compose logs -f`.

### 4. Open the app

Go to **http://localhost:3001** (or the app port / domain you chose). Create an
account and you're in. The fork ships with all features included, so there is no
subscription or entitlement to configure.

That's it. To stop the stack later: `docker compose down`.

---

## What the stack contains

`docker-compose.yml` defines these services on a private bridge network:

| Service             | Image                          | Purpose |
|---------------------|--------------------------------|---------|
| `app`               | built from `./app`             | The web client (nginx serving the built web app). Published on `APP_PORT` (default 3001). |
| `server`            | built from `./server`          | The all-in-one Standard Notes server: api-gateway, auth, syncing-server, files, and revisions run together under supervisord (`MODE=self-hosted`). The realtime websocket gateway runs IN-PROCESS inside the api-gateway on the SAME port (no separate process). Internal-only — publishes NO host ports; the `app` front door proxies the API + websocket (container port 3000) and files (container port 3104) same-origin. |
| `db`                | `mariadb:11`                   | Primary datastore for accounts, notes, sync, and revisions. |
| `cache`             | `redis:8-alpine`               | Cache, sessions, and pub/sub used for realtime delivery. Persists with append-only file. |
| `floci`             | `floci/floci:1.5.29-compat`    | Local AWS SNS/SQS emulator ([floci.io](https://floci.io), MIT). The server publishes domain events to SNS topics; the in-container websocket-gateway and server workers consume SQS queues. Bootstrapped on every start (see below). Replaces LocalStack: no auth token required (LocalStack 2026.3.0+ demands one even for SNS/SQS, which is why we last pinned `localstack:4.4.0`), and it is far lighter (single native binary vs a Python runtime). It is LocalStack wire-compatible, so switching back only means swapping the image — see the escape-hatch comment in `docker-compose.yml`. |
| `mcp`               | built from `./mcp`             | Optional MCP stdio bridge. Only runs with the `mcp` profile: `docker compose --profile mcp run --rm mcp`. |

### The SNS/SQS bootstrap

On every start, floci runs
`server/docker/localstack_bootstrap.sh` (mounted into its LocalStack-compatible
`init/ready.d` directory — the script name is historical). That script creates
the SNS topics and SQS queues and wires up the subscriptions the server relies
on - including the `websocket-local-queue` that the realtime gateway consumes.
floci's queue state is in-memory, so the bootstrap re-runs on each container
start (all its calls are idempotent) — there is no emulator data volume to
manage. See [Troubleshooting](#troubleshooting) if realtime updates aren't
flowing.

---

## Prerequisites

- **Docker** with the **Compose v2** plugin (`docker compose`, not the legacy
  `docker-compose`, though the scripts fall back to it if present).
  - macOS / Windows: [Docker Desktop](https://docs.docker.com/get-docker/)
  - Linux: [Docker Engine](https://docs.docker.com/engine/install/) +
    [compose plugin](https://docs.docker.com/compose/install/linux/)
- **git** to clone the repository.
- The setup scripts need a secure random source. On macOS/Linux that's
  `openssl` (or `/dev/urandom` via `xxd`/`od`), already present on virtually all
  systems. On Windows the PowerShell script uses the .NET cryptographic RNG, so
  no extra tooling is required.

You do **not** need Node.js, Yarn, or a database installed on the host - the
containers provide all of that.

---

## Configuration (the `.env` file)

Everything is driven by a single `.env` file in the repo root. The setup scripts
generate it for you; `.env.example` documents every key with placeholder values.
The real `.env` is git-ignored and **must never be committed** - it holds your
secrets.

### Required variables

These must be present and non-empty or the stack will not start. The secrets are
64-character hex strings (32 random bytes); the encryption key in particular
**must** be exactly 32 bytes of hex (the auth service validates this and refuses
to boot otherwise).

| Variable | Purpose | How it's generated |
|----------|---------|--------------------|
| `AUTH_JWT_SECRET` | Signs/verifies cross-service JWTs across the server and the websocket-gateway. | `openssl rand -hex 32` / .NET RNG |
| `AUTH_SERVER_ENCRYPTION_SERVER_KEY` | Server-side encryption key for sensitive auth data (e.g. MFA secrets). Must be exactly 32 bytes of hex. | `openssl rand -hex 32` / .NET RNG |
| `VALET_TOKEN_SECRET` | Signs the short-lived valet tokens that authorize file uploads/downloads. | `openssl rand -hex 32` / .NET RNG |
| `AUTH_SERVER_PSEUDO_KEY_PARAMS_KEY` | Seed for pseudo key-params returned on login for unknown accounts (prevents user enumeration). The container auto-generates one if unset, but it would then change on every restart - so it is pinned in `.env`. | `openssl rand -hex 32` / .NET RNG |
| `WEBSOCKET_GATEWAY_INTERNAL_SECRET` | Shared secret authenticating the server -> websocket-gateway internal calls. Must match on both. | `openssl rand -hex 32` / .NET RNG |
| `WEB_SOCKET_CONNECTION_TOKEN_SECRET` | Signs the short-lived tokens browsers use to open a realtime websocket connection. | `openssl rand -hex 32` / .NET RNG |
| `MYSQL_PASSWORD` | Password for the application database user. | `openssl rand -hex 32` / .NET RNG |
| `MYSQL_ROOT_PASSWORD` | MariaDB root password. | `openssl rand -hex 32` / .NET RNG |
| `MYSQL_DATABASE` | Database name. | Your choice (default `standard_notes_db`) |
| `MYSQL_USER` | Application database user. | Your choice (default `std_notes_user`) |
| `DB_CONNECTION_LIMIT` | Per-process TypeORM connection pool ceiling. | `20` |
| `DB_MAX_CONNECTIONS` | MariaDB server connection ceiling. Keep above total service pools. | `150` |
| `DB_INNODB_BUFFER_POOL_SIZE` | MariaDB InnoDB cache size. Tune with `DB_MEM_LIMIT`. | `512M` |
| `DB_MAX_ALLOWED_PACKET` | Maximum MariaDB packet for large encrypted payloads. | `128M` |
| `APP_PORT` | The single host port. The app's nginx front door serves the web UI and proxies the API, files, and websocket same-origin — no other service publishes a host port. | Your choice (default `3001`) |
| `PUBLIC_FILES_SERVER_URL` | Public URL clients use to reach the files service. It is the app origin + `/files` (the front door's prefix-strip proxy). | Computed by the script |
| `AUTH_SERVER_U2F_RELYING_PARTY_ID` | WebAuthn/hardware-key relying-party ID (your host). | Computed (host of your domain, or `localhost`) |
| `AUTH_SERVER_U2F_EXPECTED_ORIGIN` | Allowed WebAuthn origins. | Computed from your domain + app port |

### Cookie / domain variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `COOKIE_DOMAIN` | Domain scope for the auth session cookie. Empty = host-only (works on localhost and bare hosts/IPs). Set to your domain for an HTTPS deployment. | empty |
| `COOKIE_SECURE` | Send the auth cookie only over HTTPS. Set `true` for real HTTPS deployments; `false` for plain-http localhost. | `false` |
| `ADMIN_EMAILS` | Comma-separated emails granted the in-app Admin panel and `/admin` endpoints. | empty |

### Optional variables

Left commented in `.env`; `docker-compose.yml` applies sensible defaults when
they're unset. These include logging (`LOG_LEVEL`), cookie tuning
(`COOKIE_SAME_SITE`, `COOKIE_PARTITIONED`), feature/entitlement mode
(`STANDARD_RED_FEATURES_MODE`, `STANDARD_RED_ENTITLEMENT_MODE`, defaulting to
fully-included), revision retention (`REVISIONS_RETENTION_DAYS`,
`REVISIONS_MAX_COUNT_PER_ITEM`), the optional Assistant/LLM proxy
(`ASSISTANT_*`), operation limits (`RATE_LIMIT_*`, `REGISTRATION_*`, upload and
request caps), and the optional MCP bridge (`STANDARD_RED_NOTES_*`). See
`.env.example` for the full list and [Operations hardening](operations-hardening.md)
for the database, Redis, operation-limit, and image-pinning model.

### Server-wide shared access key (optional obfuscation gate)

> **This is obfuscation / access-gating, not end-to-end security.** It does not
> replace and does not strengthen the existing client-side end-to-end
> encryption, which is what actually protects your note content. The shared key
> only makes the server refuse to talk to clients that do not present it -
> analogous to a reverse-proxy "basic auth" gate, but built into the gateway so
> the official clients can pass it. It deters a casual scanner who stumbles onto
> your server; it is *not* a defense against an attacker who already has the key
> (or can read it off a client device). It is also **not** a user password.

Two variables control it, both **OFF by default** (leaving them unset means zero
behavior change for existing installs):

| Variable | Description | Default |
| --- | --- | --- |
| `SHARED_SERVER_ACCESS_KEY` | The shared secret. Empty/unset disables the gate entirely. | empty (off) |
| `SHARED_SERVER_ACCESS_KEY_MODE` | `all` = every request must present the key (the `/healthcheck` path is always exempt so the container stays healthy); `registration` = only new account sign-ups require the key, leaving existing users (sync, sign-in) unaffected. | `all` (only relevant once a key is set) |

When enabled, the api-gateway requires the key in the `X-Shared-Server-Key`
header and rejects non-matching requests with a generic `401`. The comparison is
constant-time and the key is never logged.

On each client, enter the same key under **Preferences -> Security -> Server
Access Key**. It is stored locally on that device (never synced) and attached to
outgoing requests automatically. Because sign-in and registration also pass
through the gate, configure the key on a device *before* signing in to a gated
server.

---

## Choosing a domain and ports

- **Local-only (default).** Leave the domain blank. The app is reachable at
  `http://localhost:3001`. Cookies are host-only and non-secure, which works on
  `localhost` or any bare host/IP over plain HTTP.
- **Behind a domain over HTTPS.** Give the setup script your domain (e.g.
  `notes.example.com`) and answer "yes" to the HTTPS question. The script sets
  `COOKIE_DOMAIN`, `COOKIE_SECURE=true`, and computes `PUBLIC_FILES_SERVER_URL`
  and the WebAuthn origins for you. Terminate TLS at a reverse proxy
  (nginx/Caddy/Traefik) in front of the published ports - Compose itself serves
  plain HTTP on the host ports. See
  [Running behind a reverse proxy](#running-behind-a-reverse-proxy) for the full
  proxy config (`TRUST_PROXY`, nginx/Traefik examples, websocket upgrade).
- **Port already in use?** Re-run the setup script and choose a different host
  port, or edit `APP_PORT` in `.env`, then `docker compose up -d` again. It is
  the only published port — the API gateway and files service are internal-only
  and reached through the app front door.

---

## Running behind a reverse proxy

For any internet-facing deployment you should terminate TLS at a reverse proxy
(nginx, Traefik, or Caddy) in front of the stack. The stack has a **single
front door**: the `app` container's nginx (host port `APP_PORT`, default 3001)
serves the web UI and already proxies the `/v1` API, the `/files/` endpoints,
and the realtime `/sockets` websocket same-origin to the internal-only `server`
container. Your proxy therefore needs exactly **one upstream** - the app port -
and one certificate.

### Required environment

TLS is terminated at the proxy, so the containers receive plain HTTP. They must
trust the proxy's forwarded headers and the cookie must be marked Secure:

| Variable | Set to | Why |
|----------|--------|-----|
| `TRUST_PROXY` | usually leave at the default | Makes the server honor `X-Forwarded-Proto` / `X-Forwarded-For` so `req.secure` and the client IP are correct. The default (`loopback, linklocal, uniquelocal`) trusts a proxy on loopback or a private/Docker network - which is exactly the case when the proxy is another container or runs on the same host. Set it to `true`, a hop count, or a CSV of proxy IPs/subnets only if your proxy reaches the stack from a public IP. |
| `COOKIE_SECURE` | `true` | The auth cookie is then only sent over HTTPS. Without this the browser may drop it on an HTTPS origin and every request 401s. |
| `COOKIE_DOMAIN` | your domain (e.g. `notes.example.com`) | Scopes the auth cookie to your host. Leave empty only for bare-host/IP setups. |
| `PUBLIC_FILES_SERVER_URL` | `https://notes.example.com` (or a files subpath/host) | The public URL clients use to reach the files service - must be the HTTPS URL the browser can reach, routed by the proxy. |
| `AUTH_SERVER_U2F_EXPECTED_ORIGIN` | `https://notes.example.com` | WebAuthn/hardware-key origin must match the HTTPS origin. |
| `AUTH_SERVER_U2F_RELYING_PARTY_ID` | `notes.example.com` | WebAuthn relying-party id (the host, no scheme/port). |

> Why `TRUST_PROXY`? Express only fills `req.secure` / `req.protocol` / `req.ip`
> from the `X-Forwarded-*` headers when "trust proxy" is configured. Without it,
> the server thinks every request is plain HTTP from the proxy's address.

### Single external host

Route the whole hostname to the app front door (`app` container, host port
`APP_PORT`/3001, container port 8080). The front door's nginx
(`app/docker/nginx.conf`) then fans out by path on the internal Docker network:

- `/` -> the web UI (static bundle)
- `/v1`, `/v2`, `/auth`, `/subscription`, `/healthcheck` -> the **API gateway**
  (`server` container, port 3000)
- `/files/` -> the **files service** (`server` container, port 3104; the front
  door strips the `/files` prefix). Point `PUBLIC_FILES_SERVER_URL` at the
  public app origin + `/files`, e.g. `https://notes.example.com/files`.
- `/sockets` -> the **websocket gateway** (in-process inside the api-gateway on
  port 3000). The `/sockets` path needs the WebSocket Upgrade headers - the
  front door already sends them, but YOUR proxy must pass `Upgrade`/`Connection`
  through too. The browser opens `wss://<host>/sockets`. (`WEB_SOCKET_SERVER_URL`
  is container-internal - the api-gateway minting tokens against itself - and
  should stay at its default.)
- `/workflows-ui/` -> the optional embedded Workflows editor (auth-checked by
  the api-gateway, which proxies to the internal-only n8n container).

The web client does not hard-code an API origin - it defaults to its own origin
and follows the gateway's advertised files URL - so single-origin routing works
out of the box.

### Compose: dropping host ports

The default `docker compose up` publishes the single app port (`APP_PORT`) so
the stack works standalone; the `server` service publishes nothing. When a proxy
fronts the stack you can drop even that port: attach the `app` service to a
shared Docker network and let the proxy reach it by service name.
`docker-compose.yml` ships commented examples: create the network once with
`docker network create proxy`, then uncomment the `# - proxy` network line (and
the Traefik `labels:` block) on the `app` service. Leaving the examples
commented keeps the default flow unchanged.

### nginx example

TLS terminates at nginx; it forwards plain HTTP to the single app front door
(host port `APP_PORT`, default 3001), which handles all path routing itself.
Note the explicit `Upgrade`/`Connection` handling on the websocket location and
the unbuffered `/files/` location for large uploads/downloads.

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name notes.example.com;

    ssl_certificate     /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;

    client_max_body_size 0;   # allow large file uploads (server enforces its own limit)

    # Headers every location needs so the server sees the real scheme + client IP.
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host  $host;

    # Realtime websocket - WebSocket Upgrade pass-through is required.
    location /sockets {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;       # keep long-lived sockets open
    }

    # Files - stream large encrypted chunks without buffering them on disk.
    location /files/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_request_buffering off;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }

    # Everything else (web UI, /v1 API, /workflows-ui, ...) - the app front
    # door routes by path internally.
    location / { proxy_pass http://127.0.0.1:3001; }
}
```

Set in `.env`: `COOKIE_SECURE=true`, `COOKIE_DOMAIN=notes.example.com`,
`PUBLIC_FILES_SERVER_URL=https://notes.example.com/files`, and the WebAuthn
origins. (`WEB_SOCKET_SERVER_URL` is container-internal and should stay at its
default.) `TRUST_PROXY` can stay at its default when nginx runs on the same host
(loopback) or on the Docker network; set it to nginx's address otherwise.

### Traefik example

Traefik (v2/v3) with the Docker provider. Only the `app` service needs to join
Traefik's network and be labeled - it is the single front door and proxies the
API, files, and websocket internally. Traefik forwards `X-Forwarded-*` and
proxies the WebSocket `Upgrade`/`Connection` headers automatically, so no
special websocket config is needed beyond the one router.

```yaml
# In docker-compose.yml (see the commented examples there):
services:
  app:
    networks: [standard-red-notes, proxy]
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=proxy"
      - "traefik.http.routers.srn-web.rule=Host(`notes.example.com`)"
      - "traefik.http.routers.srn-web.entrypoints=websecure"
      - "traefik.http.routers.srn-web.tls.certresolver=le"
      - "traefik.http.services.srn-web.loadbalancer.server.port=8080"

networks:
  proxy:
    external: true
```

Because the proxy and the stack share the `proxy` Docker network (a private
subnet), the default `TRUST_PROXY` already trusts Traefik - no override needed.
Use the same `.env` values as the nginx example.

### Manual verification

- **Secure cookie behind the proxy.** Against the API gateway, send a forwarded
  HTTPS header and confirm the auth cookie comes back `Secure` (requires
  `COOKIE_SECURE=true`):

  ```bash
  curl -sik -H 'X-Forwarded-Proto: https' \
    -H 'Content-Type: application/json' \
    -d '{"email":"you@example.com","password":"...","api":"20200115"}' \
    https://notes.example.com/v1/login | grep -i set-cookie
  # expect: Set-Cookie: access_token_...; HttpOnly; Secure; ...
  ```

- **Websocket upgrade through the proxy.** Confirm the proxy upgrades the
  connection (HTTP 101):

  ```bash
  curl -sik -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGVzdA==' \
    https://notes.example.com/sockets/
  # expect: HTTP/1.1 101 Switching Protocols
  ```

- **Real client IP in logs.** With `TRUST_PROXY` set correctly the server logs
  the client's address (from `X-Forwarded-For`), not the proxy's.

---

## Start, stop, and upgrade

```bash
# Build (if needed) and start everything in the background
docker compose up -d --build

# Follow logs
docker compose logs -f
docker compose logs -f server   # one service

# Check status / health
docker compose ps

# Stop (containers removed, named volumes / data kept)
docker compose down

# Upgrade: pull newer base images and rebuild the app/server images
git pull
docker compose pull            # refresh mariadb / redis / floci images
docker compose up -d --build   # rebuild app/server/gateway and restart
```

> `docker compose down` keeps your data (it lives in named volumes).
> `docker compose down -v` **deletes the volumes and all your data** - only use
> it for a clean reset.

---

## Where your data lives

Data is stored in Docker **named volumes**, so it survives `docker compose down`
and container rebuilds:

| Volume            | Holds | Notes |
|-------------------|-------|-------|
| `mariadb-data`    | The MariaDB database - **all accounts, notes, and revisions**. | The one to back up. |
| `redis-data`      | Redis append-only persistence (cache/sessions/pub-sub). | Safe to lose; rebuilt at runtime. |
| `uploads`         | Uploaded file attachments stored by the files service. | Back this up alongside the DB if you use file uploads. |
| `server-logs`     | Server process logs. | Disposable. |
| `mcp-data`        | MCP bridge local state (only with the `mcp` profile). | Disposable. |

List them with `docker volume ls | grep standard-red-notes`.

---

## Backup and restore

The critical data is the MariaDB volume (and `uploads` if you store
attachments).

**Back up the database** (logical dump, while the stack is running):

```bash
# Reads MYSQL_* from your .env
docker compose exec db sh -c \
  'exec mariadb-dump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines "$MYSQL_DATABASE"' \
  > backup.sql
```

**Restore** into a running stack:

```bash
docker compose exec -T db sh -c \
  'exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
  < backup.sql
```

**Back up uploaded files**:

```bash
docker run --rm -v standard-red-notes_uploads:/data -v "$PWD":/backup \
  alpine tar czf /backup/uploads-backup.tar.gz -C /data .
```

Keep your `.env` backed up in a safe place too: if you lose
`AUTH_SERVER_ENCRYPTION_SERVER_KEY` or change the other secrets, existing users
can be locked out and encrypted server-side data becomes unreadable.

For database tuning and restore drills, see [Operations hardening](operations-hardening.md).

---

## Troubleshooting

**A service is unhealthy / keeps restarting.**
Check `docker compose ps` and `docker compose logs <service>`. `server` has a
long `start_period` (90s) because it boots several processes under supervisord;
give it a minute on first run before assuming failure.

**Realtime updates / the websocket gateway aren't working after a reset.**
The SNS topics and SQS queues are created by the bootstrap script on *every*
floci start (its state is in-memory). If the bootstrap didn't run or something
looks wrong, just restart the emulator:

```bash
docker compose restart floci
```

Confirm the queues exist (the `-compat` image ships `awslocal`):

```bash
docker compose exec floci awslocal sqs list-queues
```

If you previously ran the LocalStack-based stack, a leftover
`standard-red-notes_localstack-data` volume can be deleted — floci doesn't use
it: `docker volume rm standard-red-notes_localstack-data`.

**"Port is already allocated" on startup.**
Another process owns one of your host ports. Change the `*_PORT` values in
`.env` (or re-run the setup script) and `docker compose up -d` again.

**The stack exits immediately complaining a variable is "not set".**
Your `.env` is missing a required secret (e.g. `AUTH_JWT_SECRET`,
`VALET_TOKEN_SECRET`, or `AUTH_SERVER_ENCRYPTION_SERVER_KEY`). Re-run the setup
script to regenerate a complete file, or copy `.env.example` and fill in real
64-char hex values.

**Logged in but every request returns 401.**
Cookie settings don't match how you're reaching the app. For plain-http
localhost use empty `COOKIE_DOMAIN` and `COOKIE_SECURE=false`; for an HTTPS
domain set `COOKIE_DOMAIN` to your domain and `COOKIE_SECURE=true`.

**Database connection errors on first boot.**
MariaDB takes a few seconds to initialize a brand-new `mariadb-data` volume. The
server waits on the db healthcheck, but if you changed `MYSQL_*` values after the
volume was already initialized, the credentials won't match - reset with
`docker compose down -v` (destroys data) or fix the volume's existing user.
