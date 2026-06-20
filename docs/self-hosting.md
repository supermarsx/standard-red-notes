# Self-hosting Standard Red Notes

Run your own fully-featured Standard Red Notes server with Docker
Compose. One setup script generates a correct `.env` (with securely-generated
secrets), then a single `docker compose up` brings the whole stack online.

Standard Red Notes is licensed under AGPL-3.0; it is a self-hosted fork of
Standard Notes. See the [LICENSE](../LICENSE) file for details.

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
| `server`            | built from `./server`          | The all-in-one Standard Notes server: api-gateway, auth, syncing-server, files, and revisions run together under supervisord (`MODE=self-hosted`). Publishes the API on `SERVER_PORT` (3000) and files on `FILES_PORT` (3125). |
| `websocket-gateway` | built from `./websocket-gateway` | Self-hosted realtime push gateway (replaces AWS API Gateway WebSockets). Published on `WEBSOCKET_PORT` (3106). |
| `db`                | `mariadb:11`                   | Primary datastore for accounts, notes, sync, and revisions. |
| `cache`             | `redis:8-alpine`               | Cache, sessions, and pub/sub used for realtime delivery. Persists with append-only file. |
| `localstack`        | `localstack/localstack:4`      | Local AWS SNS/SQS emulator. The server publishes domain events to SNS topics; the websocket-gateway and server workers consume SQS queues. Bootstrapped on first start (see below). |
| `mcp`               | built from `./mcp`             | Optional MCP stdio bridge. Only runs with the `mcp` profile: `docker compose --profile mcp run --rm mcp`. |

### The localstack bootstrap

On first start, localstack runs
`server/docker/localstack_bootstrap.sh` (mounted into its `init/ready.d`
directory). That script creates the SNS topics and SQS queues and wires up the
subscriptions the server relies on - including the `websocket-local-queue` that
the realtime gateway consumes. This bootstrap only runs when the localstack data
volume is empty (a fresh start). See [Troubleshooting](#troubleshooting) if
realtime updates aren't flowing.

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
| `APP_PORT` | Host port for the web app. | Your choice (default `3001`) |
| `SERVER_PORT` | Host port for the API gateway. | Your choice (default `3000`) |
| `FILES_PORT` | Host port for the files service. | Your choice (default `3125`) |
| `WEBSOCKET_PORT` | Host port for the realtime gateway. | Your choice (default `3106`) |
| `PUBLIC_FILES_SERVER_URL` | Public URL clients use to reach the files service. Derived from your domain + `FILES_PORT`. | Computed by the script |
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
(`ASSISTANT_*`), and the optional MCP bridge (`STANDARD_RED_NOTES_*`). See
`.env.example` for the full list.

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
- **Port already in use?** Re-run the setup script and choose different host
  ports, or edit `APP_PORT` / `SERVER_PORT` / `FILES_PORT` / `WEBSOCKET_PORT` in
  `.env`, then `docker compose up -d` again.

---

## Running behind a reverse proxy

For any internet-facing deployment you should terminate TLS at a reverse proxy
(nginx, Traefik, or Caddy) in front of the stack. The Compose services speak
plain HTTP on the host ports; the proxy adds HTTPS and forwards requests to
them. This lets you serve the **whole app under one external host** - the web
UI, the `/v1` API, the files endpoints, and the realtime websocket - with a
single certificate.

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

Route everything under one hostname by path:

- `/` -> the **web** app (`app` container, port 80)
- `/v1`, `/v2`, `/healthcheck` -> the **API gateway** (`server` container, port 3000)
- the **files** endpoints -> the files port (`server` container, port 3104 inside;
  published as `FILES_PORT`/3125). Point `PUBLIC_FILES_SERVER_URL` at the public
  URL you route to it.
- the **websocket** gateway -> the `websocket-gateway` container, port 3106. The
  browser opens `wss://<host>/...`; set `WEB_SOCKET_SERVER_URL` to that URL.

The web client does not hard-code an API origin - it uses whatever sync-server
URL you configure in the client - so single-origin routing is purely a proxy
concern.

### Compose: dropping host ports

The default `docker compose up` publishes host ports so it works standalone. When
a proxy fronts the stack you can instead attach the proxy-facing services to a
shared Docker network and stop publishing ports. `docker-compose.yml` ships
commented examples: create the network once with `docker network create proxy`,
then uncomment the `# - proxy` network lines (and the Traefik `labels:` blocks)
on the `app`, `server`, and `websocket-gateway` services. Leaving the examples
commented keeps the default flow unchanged.

### nginx example

TLS terminates at nginx; it forwards plain HTTP to the published container ports
(adjust the `proxy_pass` upstreams to your host/ports). Note the explicit
`Upgrade`/`Connection` handling on the websocket location.

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

    # API gateway (auth, sync, etc.)
    location /v1/ { proxy_pass http://127.0.0.1:3000; }
    location /v2/ { proxy_pass http://127.0.0.1:3000; }
    location /healthcheck { proxy_pass http://127.0.0.1:3000; }

    # Files service (range requests pass through transparently)
    location /files/ { proxy_pass http://127.0.0.1:3125/; }

    # Realtime websocket gateway - WebSocket Upgrade pass-through is required.
    location /sockets/ {
        proxy_pass http://127.0.0.1:3106/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 1h;       # keep long-lived sockets open
    }

    # Web app (catch-all, last)
    location / { proxy_pass http://127.0.0.1:3001; }
}
```

Set in `.env`: `COOKIE_SECURE=true`, `COOKIE_DOMAIN=notes.example.com`,
`PUBLIC_FILES_SERVER_URL=https://notes.example.com/files`,
`WEB_SOCKET_SERVER_URL=wss://notes.example.com/sockets`, and the WebAuthn
origins. `TRUST_PROXY` can stay at its default when nginx runs on the same host
(loopback) or on the Docker network; set it to nginx's address otherwise.

### Traefik example

Traefik (v2/v3) with the Docker provider. Add the stack services to Traefik's
network and label them. Traefik forwards `X-Forwarded-*` and proxies the
WebSocket `Upgrade`/`Connection` headers automatically, so no special websocket
config is needed beyond a router.

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
      - "traefik.http.services.srn-web.loadbalancer.server.port=80"

  server:
    networks: [standard-red-notes, proxy]
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=proxy"
      - "traefik.http.routers.srn-api.rule=Host(`notes.example.com`) && PathPrefix(`/v1`, `/v2`, `/healthcheck`)"
      - "traefik.http.routers.srn-api.entrypoints=websecure"
      - "traefik.http.routers.srn-api.tls.certresolver=le"
      - "traefik.http.routers.srn-api.service=srn-api"
      - "traefik.http.services.srn-api.loadbalancer.server.port=3000"
      # A second router/service for the files port (3104) can be added the same way.

  websocket-gateway:
    networks: [standard-red-notes, proxy]
    labels:
      - "traefik.enable=true"
      - "traefik.docker.network=proxy"
      - "traefik.http.routers.srn-ws.rule=Host(`notes.example.com`) && PathPrefix(`/sockets`)"
      - "traefik.http.routers.srn-ws.entrypoints=websecure"
      - "traefik.http.routers.srn-ws.tls.certresolver=le"
      - "traefik.http.services.srn-ws.loadbalancer.server.port=3106"

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
docker compose pull            # refresh mariadb / redis / localstack images
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
| `localstack-data` | localstack's SNS/SQS state. | Recreated by the bootstrap on a fresh volume. |
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

---

## Troubleshooting

**A service is unhealthy / keeps restarting.**
Check `docker compose ps` and `docker compose logs <service>`. `server` has a
long `start_period` (90s) because it boots several processes under supervisord;
give it a minute on first run before assuming failure.

**Realtime updates / the websocket gateway aren't working after a reset.**
The localstack queues are created by the bootstrap script *only when the
`localstack-data` volume is empty*. If you cleared volumes or the bootstrap
didn't run, recreate localstack with a fresh volume:

```bash
docker compose rm -sf localstack
docker volume rm standard-red-notes_localstack-data
docker compose up -d localstack
```

Confirm the queues exist:

```bash
docker compose exec localstack awslocal sqs list-queues
```

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
