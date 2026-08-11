---
title: Self-hosting
description: Run your own Standard Red Notes server.
---

# Self-hosting Standard Red Notes

Run your own Standard Red Notes server with Docker Compose. It is fully featured
by default. One setup script generates a correct `.env` (with securely-generated
secrets), then a single `docker compose up` brings the whole stack online.

Standard Red Notes is licensed under AGPL-3.0; it is a self-hosted fork of
Standard Notes. See the [license](../license.md) file for details.

{% include safety-alert.html
  level="danger"
  title="Internet exposure needs TLS, unique secrets, and tested recovery"
  body="The localhost quickstart is not an internet-hardening guide. Before publishing an instance, terminate TLS, restrict ingress to the single app front door, replace or verify every secret, configure secure cookies and trusted proxy hops, and complete a database plus file restore drill."
  link_url="/operations-hardening.html"
  link_text="Review production hardening"
%}

- [Deploy in 5 minutes](#deploy-in-5-minutes)
- [What the stack contains](#what-the-stack-contains)
- [Prerequisites](#prerequisites)
- [Configuration (the `.env` file)](#configuration-the-env-file)
- [Standalone home-server release](#standalone-home-server-release)
- [The srn-admin binary](#the-srn-admin-binary)
- [Choosing a domain and ports](#choosing-a-domain-and-ports)
- [Running behind a reverse proxy](#running-behind-a-reverse-proxy)
- [Start, stop, and upgrade](#start-stop-and-upgrade)
- [Deploy a verified GHCR image pair](#deploy-a-verified-ghcr-image-pair)
- [Where your data lives](#where-your-data-lives)
- [Backup and restore](#backup-and-restore)
- [Troubleshooting](#troubleshooting)

## Deploy in 5 minutes

A friendly walkthrough for a first-time, single-machine install. By the end you
will have the web app open in your browser.

### 1. Get the code

```bash
git clone https://github.com/supermarsx/standard-red-notes.git standard-red-notes
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
account and you're in. The fork is fully featured by default, without
subscription provisioning. Optional integrations still require operator
configuration, and administrative capabilities require an administrator role.

That's it. To stop the stack later: `docker compose down`.

## What the stack contains

`docker-compose.yml` uses two private bridge networks. Core services use
`standard-red-notes`. The arbitrary-code `n8n` trust domain uses only
`workflows-mcp`, with the authenticated MCP service dual-homed so it can reach
the core API without giving n8n a direct service-network route or Compose DNS
address for the server, database, cache, or event emulator. Publicly exposed
endpoints remain reachable like they are to any external client:

| Service  | Image                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app`    | built from `./app`          | The web client (nginx serving the built web app). Published on `APP_PORT` (default 3001).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `server` | built from `./server`       | The all-in-one Standard Notes server: api-gateway, auth, syncing-server, files, and revisions run together under supervisord (`MODE=self-hosted`). The realtime websocket gateway runs IN-PROCESS inside the api-gateway on the SAME port (no separate process). Internal-only — publishes NO host ports; the `app` front door proxies the API + websocket (container port 3000) and files (container port 3104) same-origin.                                                                                                                                                                           |
| `db`     | `mariadb:12.3.2`            | Primary datastore for accounts, notes, sync, and revisions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cache`  | `redis:8.8.0-alpine`        | Cache, sessions, and pub/sub used for realtime delivery. Persists with append-only file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `floci`  | `floci/floci:1.5.33-compat` | Local AWS SNS/SQS emulator ([floci.io](https://floci.io), MIT). The server publishes domain events to SNS topics; the in-container websocket-gateway and server workers consume SQS queues. Bootstrapped on every start (see below). Replaces LocalStack: no auth token required (LocalStack 2026.3.0+ demands one even for SNS/SQS, which is why we last pinned `localstack:4.4.0`), and it is far lighter (single native binary vs a Python runtime). It is LocalStack wire-compatible; the current LocalStack escape hatch and required auth-token migration are documented in `docker-compose.yml`. |
| `mcp`    | built from `./mcp`          | Optional authenticated MCP bridge. It is the only service on both `standard-red-notes` and `workflows-mcp`: the first reaches the API and the second accepts n8n calls at `mcp:3010`. Only runs with the `mcp` profile.                                                                                                                                                                                                                                                                                                                                                                                 |
| `n8n`    | `n8nio/n8n:2.32.6`          | Optional operator-managed automation service under the `workflows` profile. It joins only `workflows-mcp`, has independent authentication and a loopback-only development port; production uses a separate TLS hostname and proxy network.                                                                                                                                                                                                                                                                                                                                                              |

### The SNS/SQS bootstrap

On every start, floci runs
`server/docker/localstack_bootstrap.sh` (mounted into its LocalStack-compatible
`init/ready.d` directory — the script name is historical). That script creates
the SNS topics and SQS queues and wires up the subscriptions the server relies
on—including the `websocket-local-queue` that the realtime gateway consumes.
Credential-bearing Nextcloud backup requests use
`nextcloud-backup-local-topic`, which has exactly one subscription to
`syncing-server-local-queue`; it is deliberately absent from the auth, files,
and websocket queues. The server entrypoint supplies the matching
`AUTH_SERVER_NEXTCLOUD_BACKUP_SNS_TOPIC_ARN` automatically. External AWS
deployments must provision the same isolated topology before enabling scheduled
Nextcloud backups; see [Backups and recovery](backups-and-recovery.md#rolling-upgrade-compatibility).
floci's queue state is in-memory, so the bootstrap re-runs on each container
start (all its calls are idempotent) — there is no emulator data volume to
manage. See [Troubleshooting](#troubleshooting) if realtime updates aren't
flowing.

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

## Configuration (the `.env` file)

Everything is driven by a single `.env` file in the repo root. The setup scripts
generate it for you; `.env.example` documents every key with placeholder values.
The real `.env` is git-ignored and **must never be committed** - it holds your
secrets.

The multi-container Compose file fails closed when either MariaDB password is
missing or empty. Before the database can start, a networkless one-shot check
also rejects the published example placeholders and reuse of the same value for
the application and root accounts. It reports variable names only, never secret
values. Run one of the setup scripts to generate independent random values. The
SQLite-based `docker-compose.single.yml` topology does not use MariaDB and is
therefore intentionally outside this gate; isolated server CI/test Compose files
retain their explicit test-only credentials.

### Required variables

These must be present and non-empty or the stack will not start. The secrets are
64-character hex strings (32 random bytes); the encryption key in particular
**must** be exactly 32 bytes of hex (the auth service validates this and refuses
to boot otherwise).

| Variable                                | Purpose                                                                                                                                                                                                                   | How it's generated                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `AUTH_JWT_SECRET`                       | Signs/verifies cross-service JWTs across the server and the websocket-gateway.                                                                                                                                            | `openssl rand -hex 32` / .NET RNG                                  |
| `AUTH_SERVER_ENCRYPTION_SERVER_KEY`     | Server-side encryption key for sensitive auth data (e.g. MFA secrets). Must be exactly 32 bytes of hex.                                                                                                                   | `openssl rand -hex 32` / .NET RNG                                  |
| `VALET_TOKEN_SECRET`                    | Signs the short-lived valet tokens that authorize file uploads/downloads.                                                                                                                                                 | `openssl rand -hex 32` / .NET RNG                                  |
| `AUTH_SERVER_PSEUDO_KEY_PARAMS_KEY`     | Seed for pseudo key-params returned on login for unknown accounts (prevents user enumeration). The container auto-generates one if unset, but it would then change on every restart - so it is pinned in `.env`.          | `openssl rand -hex 32` / .NET RNG                                  |
| `WEBSOCKET_GATEWAY_INTERNAL_SECRET`     | Shared secret authenticating the server -> websocket-gateway internal calls. Must match on both.                                                                                                                          | `openssl rand -hex 32` / .NET RNG                                  |
| `WEB_SOCKET_CONNECTION_TOKEN_SECRET`    | Signs the short-lived tokens browsers use to open a realtime websocket connection.                                                                                                                                        | `openssl rand -hex 32` / .NET RNG                                  |
| `ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY` | Encrypts optional guided ChatGPT/Codex pairing credentials in the persistent gateway store. Supported setup and LXC installers generate it once and preserve it automatically; never rotate it while pairing data exists. | Automatic installer secret; manual RNG only for custom deployments |
| `MYSQL_PASSWORD`                        | Password for the application database user.                                                                                                                                                                               | `openssl rand -hex 32` / .NET RNG                                  |
| `MYSQL_ROOT_PASSWORD`                   | MariaDB root password.                                                                                                                                                                                                    | `openssl rand -hex 32` / .NET RNG                                  |
| `MYSQL_DATABASE`                        | Database name.                                                                                                                                                                                                            | Your choice (default `standard_notes_db`)                          |
| `MYSQL_USER`                            | Application database user.                                                                                                                                                                                                | Your choice (default `std_notes_user`)                             |
| `DB_CONNECTION_LIMIT`                   | Per-process TypeORM connection pool ceiling.                                                                                                                                                                              | `20`                                                               |
| `DB_MAX_CONNECTIONS`                    | MariaDB server connection ceiling. Keep above total service pools.                                                                                                                                                        | `150`                                                              |
| `DB_INNODB_BUFFER_POOL_SIZE`            | MariaDB InnoDB cache size. Tune with `DB_MEM_LIMIT`.                                                                                                                                                                      | `512M`                                                             |
| `DB_MAX_ALLOWED_PACKET`                 | Maximum MariaDB packet for large encrypted payloads.                                                                                                                                                                      | `128M`                                                             |
| `APP_PORT`                              | The public app port. The nginx front door serves the web UI and proxies the API, files, and websocket same-origin. The optional workflows profile has a separate loopback-only development port.                          | Your choice (default `3001`)                                       |
| `PUBLIC_FILES_SERVER_URL`               | Public URL clients use to reach the files service. It is the app origin + `/files` (the front door's prefix-strip proxy).                                                                                                 | Computed by the script                                             |
| `PUBLIC_URL`                            | Canonical app origin used to isolate external integration hostnames.                                                                                                                                                      | Computed from the app origin                                       |
| `AUTH_SERVER_U2F_RELYING_PARTY_ID`      | WebAuthn/hardware-key relying-party ID (your host).                                                                                                                                                                       | Computed (host of your domain, or `localhost`)                     |
| `AUTH_SERVER_U2F_EXPECTED_ORIGIN`       | Allowed WebAuthn origins.                                                                                                                                                                                                 | Computed from your domain + app port                               |

### Cookie / domain variables

| Variable        | Purpose                                                                                                                                          | Default |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| `COOKIE_DOMAIN` | Domain scope for the auth session cookie. Empty = host-only (works on localhost and bare hosts/IPs). Set to your domain for an HTTPS deployment. | empty   |
| `COOKIE_SECURE` | Send the auth cookie only over HTTPS. Set `true` for real HTTPS deployments; `false` for plain-http localhost.                                   | `false` |

### Optional variables

Left commented in `.env`; `docker-compose.yml` applies sensible defaults when
they're unset. These include logging (`LOG_LEVEL`), the shared persisted admin
overlay (`SERVER_SETTINGS_PATH`, normally leave it inside the mounted
`server-data` volume), cookie tuning
(`COOKIE_SAME_SITE`, `COOKIE_PARTITIONED`), feature/entitlement mode
(`STANDARD_RED_FEATURES_MODE`, `STANDARD_RED_ENTITLEMENT_MODE`, defaulting to
fully-included), revision retention (`REVISIONS_RETENTION_DAYS`,
`REVISIONS_MAX_COUNT_PER_ITEM`), the optional Assistant/LLM proxy
(`ASSISTANT_*`, except the setup-generated subscription encryption key), operation limits (`RATE_LIMIT_*`, `REGISTRATION_*`, upload and
request caps), and the optional MCP bridge (`STANDARD_RED_NOTES_*`). See
`.env.example` for the full list and [Operations hardening](operations-hardening.md)
for the database, Redis, operation-limit, and image-pinning model.

### Server-wide shared access key (optional obfuscation gate)

{% include safety-alert.html
  level="caution"
  title="The shared access key is only an access gate"
  body="It does not replace TLS, account authentication, or client-side encryption. Anyone who extracts it from a configured device can pass the gate, and the value is stored locally on every configured client."
%}

Two variables control it, both **OFF by default** (leaving them unset means zero
behavior change for existing installs):

| Variable                        | Description                                                                                                                                                                                                                          | Default                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `SHARED_SERVER_ACCESS_KEY`      | The shared secret. Empty/unset disables the gate entirely.                                                                                                                                                                           | empty (off)                             |
| `SHARED_SERVER_ACCESS_KEY_MODE` | `all` = every request must present the key (the `/healthcheck` path is always exempt so the container stays healthy); `registration` = only new account sign-ups require the key, leaving existing users (sync, sign-in) unaffected. | `all` (only relevant once a key is set) |

When enabled, the api-gateway requires the key in the `X-Shared-Server-Key`
header and rejects non-matching requests with a generic `401`. The comparison is
constant-time and the key is never logged.

On each client, enter the same key under **Preferences -> Security -> Server
Access Key**. It is stored locally on that device (never synced) and attached to
outgoing requests automatically. Because sign-in and registration also pass
through the gate, configure the key on a device _before_ signing in to a gated
server.

## Standalone home-server release

The published `srn-home-server` binary is an advanced, backend-only deployment
option for an existing MySQL and Redis environment. It does not include the web
app, database, cache, or reverse proxy. Use the
[Docker quickstart](#deploy-in-5-minutes) when you need the complete stack.

For a standalone install:

1. Download the executable for your platform, `srn-home-server-migrations.zip`,
   and `SHA256SUMS.txt` from the
   [current published release](https://github.com/supermarsx/standard-red-notes/releases/tag/srn-home-server-v26.1),
   then verify both downloads against the checksums.
2. Put the executable in a dedicated directory and create `.env` there. Start
   from the checked-in
   [home-server environment sample](https://github.com/supermarsx/standard-red-notes/blob/srn-home-server-v26.1/server/packages/home-server/.env.sample),
   use the [configuration reference](#configuration-the-env-file) for secrets,
   cookies, limits, and optional integrations, and add the direct service values
   required by the binary: `DB_TYPE=mysql`, `DB_HOST`, `DB_PORT`, `DB_USERNAME`,
   `DB_PASSWORD`, `DB_DATABASE`, `CACHE_TYPE=redis`, `REDIS_URL`, `REDIS_HOST`,
   `REDIS_PORT`, `PORT`, `FILE_UPLOAD_PATH`, and `FILES_SERVER_URL`.
3. Extract `srn-home-server-migrations.zip` in that directory. Before first
   start, confirm that `migrations/mysql/*.js` is next to the executable. The
   binary finds that directory automatically; set `SRN_MIGRATIONS_DIR` to its
   absolute path only when you store it elsewhere. Database migrations run at
   startup, so take a database backup before upgrading.
4. Start the binary from the directory containing `.env`:

   ```bash
   chmod +x srn-home-server-linux-x64
   ./srn-home-server-linux-x64
   ```

   On Windows PowerShell, run `./srn-home-server-windows-x64.exe` instead.

After it starts, follow [Choosing a domain and ports](#choosing-a-domain-and-ports)
and [Running behind a reverse proxy](#running-behind-a-reverse-proxy) before
exposing it publicly. The binary is only the backend, so point a separately
deployed Standard Red Notes client at that public server URL.

## The srn-admin binary

`srn-admin` is the administrative CLI for a Standard Red Notes deployment. Like
the tools above it is published as native binaries (Windows, macOS, and Linux)
with a `SHA256SUMS.txt` for verification. Unlike `srn-home-server`, it is **not**
a standalone offline tool: every command runs against a **running** SRN stack and
its database, so a reachable server and database must already be up.

In the Docker stack the supported invocation runs it inside the `server`
container, which already holds the database connection and server configuration:

```bash
docker compose exec server srn-admin help
```

Administrator access is a persisted server-side role, not an email-based
environment setting. Register the intended account first, then bootstrap it
locally:

```bash
docker compose exec server srn-admin roles grant <user> ADMIN_USER
```

You can download and checksum the binary like the other published tools to keep
it on an operator machine, but it always targets a live deployment — it manages
an existing stack rather than starting a server of its own.

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
  the only public app port — the API gateway and files service are internal-only
  and reached through the app front door. The optional n8n development mapping
  remains host-loopback-only.

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

| Variable                           | Set to                                                | Why                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUST_PROXY`                      | usually leave at the default                          | Makes the server honor `X-Forwarded-Proto` / `X-Forwarded-For` so `req.secure` and the client IP are correct. The default (`loopback, linklocal, uniquelocal`) trusts a proxy on loopback or a private/Docker network - which is exactly the case when the proxy is another container or runs on the same host. Set it to `true`, a hop count, or a CSV of proxy IPs/subnets only if your proxy reaches the stack from a public IP.    |
| `ENFORCE_HTTPS_FROM_PROXY`         | `true`                                                | Enables the validated outer-proxy contract: the app front door trusts one exact `X-Forwarded-Proto: http` or `https` value and preserves the proxy's sanitized `X-Forwarded-For` chain. `http` redirects to `PUBLIC_URL`; `https` enables HSTS. Startup fails without a pathless HTTPS origin and loopback bind. Keep the app port private, and make the outer proxy overwrite both headers so clients cannot enter the trusted chain. |
| `APP_BIND_ADDRESS`                 | `127.0.0.1`                                           | Keeps the published inner HTTP port reachable only by a reverse proxy on the same host. Trusted-proxy mode refuses to start with any other declared bind. If Traefik reaches `app:8080` over a private Docker network, remove the Compose `ports` entry and leave this safety declaration at `127.0.0.1`. Direct HTTP/LAN mode retains the compatible `0.0.0.0` default only while proxy trust is disabled.                            |
| `COOKIE_SECURE`                    | `true`                                                | The auth cookie is then only sent over HTTPS. Without this the browser may drop it on an HTTPS origin and every request 401s.                                                                                                                                                                                                                                                                                                          |
| `COOKIE_DOMAIN`                    | your domain (e.g. `notes.example.com`)                | Scopes the auth cookie to your host. Leave empty only for bare-host/IP setups.                                                                                                                                                                                                                                                                                                                                                         |
| `PUBLIC_FILES_SERVER_URL`          | `https://notes.example.com` (or a files subpath/host) | The public URL clients use to reach the files service - must be the HTTPS URL the browser can reach, routed by the proxy.                                                                                                                                                                                                                                                                                                              |
| `PUBLIC_URL`                       | `https://notes.example.com`                           | Canonical app origin used for external-link hostname isolation; do not derive it from forwarded `Host`.                                                                                                                                                                                                                                                                                                                                |
| `AUTH_SERVER_U2F_EXPECTED_ORIGIN`  | `https://notes.example.com`                           | WebAuthn/hardware-key origin must match the HTTPS origin.                                                                                                                                                                                                                                                                                                                                                                              |
| `AUTH_SERVER_U2F_RELYING_PARTY_ID` | `notes.example.com`                                   | WebAuthn relying-party id (the host, no scheme/port).                                                                                                                                                                                                                                                                                                                                                                                  |

> Why `TRUST_PROXY`? Express only fills `req.secure` / `req.protocol` / `req.ip`
> from the `X-Forwarded-*` headers when "trust proxy" is configured. Without it,
> the server thinks every request is plain HTTP from the proxy's address.

### Standard Red Notes external host

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
  The web client does not hard-code an API origin - it defaults to its own origin
  and follows the gateway's advertised files URL - so single-origin routing works
  out of the box. n8n is deliberately not part of this path router.

`ENFORCE_HTTPS_FROM_PROXY=true` is defense in depth, not a TLS terminator. The
outer proxy is the public trust boundary: it must overwrite (not append to)
both `X-Forwarded-Proto` and `X-Forwarded-For`, redirect its own public HTTP
listener to HTTPS, and emit HSTS on HTTPS responses. The inner app nginx drops
client-supplied `X-Forwarded-For` by default; it preserves a chain only in this
validated trusted mode. Do not publish `APP_PORT` to untrusted networks; bind it
to loopback or reach the `app` service only over the proxy's private Docker
network. Existing installations must set both the flag and
`APP_BIND_ADDRESS=127.0.0.1` after verifying those conditions; new setup-script
installs do so when you answer that the configured domain is served over HTTPS.

The LXC installer preserves its documented externally reachable HTTP topology
and does not enable this inner forwarded-header gate. Its nginx always replaces
`X-Forwarded-For` with the immediate peer address, so a client cannot spoof
`request.ip`; when an outer proxy is used, the gateway deliberately sees that
proxy address. For LXC, restrict the container port to the proxy and enforce the
308 redirect plus HSTS at that outer proxy; see `deploy/lxc/README.md`.

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
    listen 80;
    server_name notes.example.com;

    # Keep the method and body (important for API clients); never serve the app
    # itself on this public listener.
    return 308 https://notes.example.com$request_uri;
}

server {
    listen 443 ssl http2;
    server_name notes.example.com;

    ssl_certificate     /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;

    client_max_body_size 0;   # allow large file uploads (server enforces its own limit)
    # Start with the apex host only. Add includeSubDomains/preload only after
    # every subdomain is permanently HTTPS-capable.
    add_header Strict-Transport-Security "max-age=31536000" always;

    # Overwrite forwarded transport metadata; never pass a client-supplied value.
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-Host  $host;

    # Realtime websocket - WebSocket Upgrade pass-through is required.
    location /sockets {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        # This location defines proxy_set_header, so nginx no longer inherits
        # any server-level proxy headers. Repeat the complete trusted set.
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $remote_addr;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-Host  $host;
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

    # Everything else (web UI and /v1 API) - the app front door routes by path.
    location / { proxy_pass http://127.0.0.1:3001; }
}
```

Set in `.env`: `ENFORCE_HTTPS_FROM_PROXY=true`,
`APP_BIND_ADDRESS=127.0.0.1`, `COOKIE_SECURE=true`,
`COOKIE_DOMAIN=notes.example.com`,
`PUBLIC_URL=https://notes.example.com`,
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
      - "traefik.http.routers.srn-web.middlewares=srn-hsts"
      - "traefik.http.services.srn-web.loadbalancer.server.port=8080"
      # The public HTTP router never serves the app; it only redirects to TLS.
      - "traefik.http.routers.srn-web-http.rule=Host(`notes.example.com`)"
      - "traefik.http.routers.srn-web-http.entrypoints=web"
      - "traefik.http.routers.srn-web-http.middlewares=srn-https-redirect"
      - "traefik.http.routers.srn-web-http.service=srn-web"
      - "traefik.http.middlewares.srn-https-redirect.redirectscheme.scheme=https"
      - "traefik.http.middlewares.srn-https-redirect.redirectscheme.permanent=true"
      - "traefik.http.middlewares.srn-hsts.headers.stsseconds=31536000"
      - "traefik.http.middlewares.srn-hsts.headers.stsincludesubdomains=false"
      - "traefik.http.middlewares.srn-hsts.headers.stspreload=false"

networks:
  proxy:
    external: true
```

Because the proxy and the stack share the `proxy` Docker network (a private
subnet), the default `TRUST_PROXY` already trusts Traefik - no override needed.
Use the same `.env` values as the nginx example. Keep Traefik's forwarded-header
trust in its safe default or limit `forwardedHeaders.trustedIPs` to known
upstream proxies; never enable insecure forwarding. Confirm the `web` entrypoint
is actually exposed on port 80 and `websecure` on 443 in Traefik's static config.

### Separate n8n hostname

If you enable the `workflows` profile, give n8n a second router such as
`automation.example.net -> n8n:5678`. Do not add an n8n path to the Standard Red
Notes host. Configure n8n's own TLS-facing URL, trusted proxy hops, secure
cookie, owner account, and project/user policy. The Standard Red Notes
`WORKFLOWS_ENABLED` gates reveal only the external link.

See [Workflows with n8n](workflows.md) for complete nginx/Traefik topology,
environment values, URL rejection rules, MCP connection, and revocation.

### Manual verification

- **Public HTTP never serves application content.** A request to the outer
  proxy must preserve the method with a canonical HTTPS redirect:

  ```bash
  curl -si -X POST http://notes.example.com/v1/login | sed -n '1p;/^[Ll]ocation:/p'
  # expect: HTTP/... 308
  # expect: Location: https://notes.example.com/v1/login
  ```

- **HTTPS emits the bounded HSTS policy.** Check both the SPA and the dedicated
  sandbox response; neither policy opts all subdomains into HSTS or preload:

  ```bash
  curl -sSI https://notes.example.com/ | grep -i '^strict-transport-security:'
  curl -sSI https://notes.example.com/sandbox.html | grep -i '^strict-transport-security:'
  # expect: Strict-Transport-Security: max-age=31536000
  ```

- **Inner transport gate fails safely.** From the Docker host only (the app port
  must not be public), verify local health remains HTTP, exact trusted values
  work, and a proxy chain/mixed value is not trusted:

  ```bash
  curl -fsS http://127.0.0.1:3001/health
  curl -sSI -H 'X-Forwarded-Proto: http' http://127.0.0.1:3001/ | sed -n '1p;/^[Ll]ocation:/p'
  curl -sSI -H 'X-Forwarded-Proto: https' http://127.0.0.1:3001/ | grep -i '^strict-transport-security:'
  curl -sSI -H 'X-Forwarded-Proto: https,http' http://127.0.0.1:3001/ | grep -Ei '^(HTTP/|Location:|Strict-Transport-Security:)'
  # exact http => 308 to PUBLIC_URL; exact https => HSTS; mixed => ordinary 200 with neither
  ```

  These inner checks apply only with `ENFORCE_HTTPS_FROM_PROXY=true`. They do not
  replace the public HTTP redirect/HSTS checks above.

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

This source-build path remains the default. `./scripts/setup.sh --up` and
`./scripts/setup.ps1 -Up` still build the checked-out `app` and `server`
Dockerfiles and verify that clean checkout's deployment identity; they do not
silently select registry images.

### Deploy a verified GHCR image pair

Successful trusted-main CI publishes the exact app and server images that
passed the disposable-stack and hardening gates. They are a coordinated pair:

- `ghcr.io/supermarsx/standard-red-notes-app`
- `ghcr.io/supermarsx/standard-red-notes-server`

Both use the same unique, non-floating, retry-stable tag
`sha-<40-character-commit>-run-<run-id>.<producer-attempt>`. No `main` or
`latest` tag is published. The initial container stream is `linux/amd64` only;
do not deploy it as a native arm64 image. Treat the pair as consumable only
after the `publish-containers` job succeeds and its summary lists **both**
digest-qualified references. A failed job can leave one retry-stable tag in
GHCR; that partial tag is not a release or a deployment input.

GHCR packages are private when first created unless the repository owner makes
them public. Public packages can be pulled anonymously. For a private package,
authenticate with a GitHub token that has only the required `read:packages`
access:

```bash
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io \
  --username "$GITHUB_USER" --password-stdin
unset GHCR_TOKEN
```

Start from a configured checkout whose database and application secrets are
already present. Select one tag from one successful workflow summary for
**both** images, pull the complete pair, prove its operating system and
architecture, take the required data snapshot, and then start without invoking
either Dockerfile:

```bash
export SRN_IMAGE_TAG='sha-<40-character-commit>-run-<run-id>.<producer-attempt>'
export APP_IMAGE="ghcr.io/supermarsx/standard-red-notes-app:${SRN_IMAGE_TAG}"
export SERVER_IMAGE="ghcr.io/supermarsx/standard-red-notes-server:${SRN_IMAGE_TAG}"

docker compose pull app server
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$APP_IMAGE")" = linux/amd64
test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$SERVER_IMAGE")" = linux/amd64

# Back up MariaDB, uploads, server-data, and the protected environment first.
docker compose up -d --no-build --pull never --wait --wait-timeout 900
docker compose ps
```

For production, prefer the two digest-qualified references written to the
successful workflow summary. The app and server manifest digests are different;
copy both from the **same** coordinated run:

```bash
export APP_IMAGE='ghcr.io/supermarsx/standard-red-notes-app@sha256:<app-manifest-digest>'
export SERVER_IMAGE='ghcr.io/supermarsx/standard-red-notes-server@sha256:<server-manifest-digest>'
docker compose pull app server
docker compose up -d --no-build --pull never --wait --wait-timeout 900
```

The successful CI job verifies each provenance bundle from GHCR. An operator
can repeat that check for both selected digest references (while authenticated
to a private package):

```bash
gh attestation verify "oci://${APP_IMAGE}" \
  --bundle-from-oci \
  --deny-self-hosted-runners \
  --repo supermarsx/standard-red-notes \
  --source-digest '<40-character-source-commit>' \
  --source-ref refs/heads/main \
  --signer-workflow supermarsx/standard-red-notes/.github/workflows/ci.yml

gh attestation verify "oci://${SERVER_IMAGE}" \
  --bundle-from-oci \
  --deny-self-hosted-runners \
  --repo supermarsx/standard-red-notes \
  --source-digest '<40-character-source-commit>' \
  --source-ref refs/heads/main \
  --signer-workflow supermarsx/standard-red-notes/.github/workflows/ci.yml
```

Verify the exposed `/.well-known/srn-deployment.json` after startup. Its
revision and version must agree with the selected pair. Keep the previous app
and server digest references until the observation window passes.

Rollback uses those two previous digest references with the same `pull` and
`up --no-build --pull never` commands. Do not run `docker compose down -v`:
application rollback must preserve the current volumes, while a database/files
rollback is a separate recovery decision based on schema compatibility and the
pre-upgrade snapshot.

{% include safety-alert.html
  level="danger"
  title="Snapshot before every upgrade"
  body="Back up the database, uploaded files, configuration, and required secrets; record image digests; then test restore and rollback. Never use docker compose down -v as an upgrade step because it deletes named data volumes."
  link_url="/backups-and-recovery.html"
  link_text="Follow the backup and restore checklist"
%}

> `docker compose down` keeps your data (it lives in named volumes).
> `docker compose down -v` **deletes the volumes and all your data** - only use
> it for a clean reset.

## Where your data lives

Data is stored in Docker **named volumes**, so it survives `docker compose down`
and container rebuilds:

| Volume         | Holds                                                          | Notes                                                  |
| -------------- | -------------------------------------------------------------- | ------------------------------------------------------ |
| `mysql-data`   | Legacy MySQL 8.4 database from older Compose releases.         | Migration source only; never mount it into MariaDB.    |
| `mariadb-data` | The MariaDB database - **all accounts, notes, and revisions**. | The one to back up.                                    |
| `redis-data`   | Redis append-only persistence (cache/sessions/pub-sub).        | Safe to lose; rebuilt at runtime.                      |
| `uploads`      | Uploaded file attachments stored by the files service.         | Back this up alongside the DB if you use file uploads. |
| `server-data`  | Gateway admin settings and encrypted subscription pairings.    | Back up with its encryption key stored separately.     |
| `server-logs`  | Server process logs.                                           | Disposable.                                            |
| `mcp-data`     | MCP bridge local state (only with the `mcp` profile).          | Disposable.                                            |
| `n8n-data`     | n8n database/config/credentials (only with `workflows`).       | Back up with the matching `N8N_ENCRYPTION_KEY`.        |

List them with `docker volume ls | grep standard-red-notes`.

## Upgrade from the legacy MySQL volume

Older Compose releases ran `mysql:8.4` on `mysql-data`. Current releases run
MariaDB on a separate `mariadb-data` volume. The `db-volume-preflight` one-shot
service checks both datastores before `db` starts. If it finds an initialized
legacy database and an uninitialized MariaDB database, startup fails instead of
silently presenting an empty installation.

MySQL and MariaDB datadirs are not interchangeable. Do not rename the volume,
copy its files into `mariadb-data`, or point the MariaDB service at
`mysql-data`. Migrate with SQL while the old MySQL service is still available:

```bash
set -eu

# 1. On the old release, stop every application writer but leave MySQL running.
docker compose stop app server

# 2. Export the application database with routines, events, and triggers.
docker compose exec -T db sh -ec \
  'exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --events --triggers --hex-blob --set-gtid-purged=OFF --column-statistics=0 "$MYSQL_DATABASE"' \
  > legacy-mysql.sql
test -s legacy-mysql.sql

# 3. Stop the old stack without deleting either named volume, then update.
docker compose down
git pull

# 4. Initialize only the new MariaDB volume. --no-deps intentionally bypasses
#    the legacy-volume gate for this isolated migration container.
docker compose run --detach --name srn-mariadb-migration --no-deps db
health=starting
for attempt in $(seq 1 90); do
  health=$(docker inspect --format '{{.State.Health.Status}}' srn-mariadb-migration)
  [ "$health" = healthy ] && break
  [ "$(docker inspect --format '{{.State.Running}}' srn-mariadb-migration)" = true ] || {
    docker logs srn-mariadb-migration
    exit 1
  }
  sleep 2
done
[ "$health" = healthy ] || {
  docker logs srn-mariadb-migration
  exit 1
}

# 5. Restore the logical dump, then stop and remove only the one-off container.
docker exec -i srn-mariadb-migration sh -ec \
  'exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
  < legacy-mysql.sql
docker stop --time 60 srn-mariadb-migration
docker rm srn-mariadb-migration

# 6. The normal gate now sees an initialized mariadb-data and permits startup.
docker compose up -d --build
docker compose ps
```

If the preflight already blocks and no logical dump exists, do not remove or
rename either volume. Restore the pre-upgrade Compose manifest in a separate
working directory and use its MySQL 8.4 service against `mysql-data` only long
enough to take the dump, or restore a previously tested logical backup. For a
custom Compose project name, inspect the exact volume names first with
`docker volume inspect`; the default names are
`standard-red-notes_mysql-data` and `standard-red-notes_mariadb-data`.

Before reopening writes, verify representative accounts, note/revision counts,
attachments, authentication, sync, and a fresh database backup. Retain
`legacy-mysql.sql` and the untouched `mysql-data` volume until those checks and
a restore drill pass. Do not run `docker compose down -v` during migration.

## Backup and restore

The critical data is the MariaDB volume, `uploads` if you store attachments,
and `server-data` when you use persisted administrator settings or encrypted
ChatGPT/Codex pairing.

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

**Drill the restore path** without touching the live database:

```bash
node scripts/verify-backup-restore.mjs
```

The drill restores the dump into a temporary `srn_restore_*` database, compares
tables, row counts, and checksums, then drops only that temporary database.

**Back up uploaded files**:

```bash
docker run --rm -v standard-red-notes_uploads:/data -v "$PWD":/backup \
  alpine tar czf /backup/uploads-backup.tar.gz -C /data .
```

Keep your `.env` backed up in a safe place too: if you lose
`AUTH_SERVER_ENCRYPTION_SERVER_KEY` or change the other secrets, existing users
can be locked out and encrypted server-side data becomes unreadable.

For database tuning and restore drills, see [Operations hardening](operations-hardening.md).

## Troubleshooting

**A service is unhealthy / keeps restarting.**
Check `docker compose ps` and `docker compose logs <service>`. `server` has a
long `start_period` (90s) because it boots several processes under supervisord;
give it a minute on first run before assuming failure.

**Realtime updates / the websocket gateway aren't working after a reset.**
The SNS topics and SQS queues are created by the bootstrap script on _every_
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
`.env` and run `docker compose up -d` again.

**The stack exits immediately complaining a variable is "not set".**
Your `.env` is missing a required secret (e.g. `AUTH_JWT_SECRET`,
`VALET_TOKEN_SECRET`, or `AUTH_SERVER_ENCRYPTION_SERVER_KEY`). Restore the
known-good protected environment backup, or compare `.env.example` and fill in
real 64-char hex values. Normal setup reruns deliberately do not regenerate an
existing file.

**Logged in but every request returns 401.**
Cookie settings don't match how you're reaching the app. For plain-http
localhost use empty `COOKIE_DOMAIN` and `COOKIE_SECURE=false`; for an HTTPS
domain set `COOKIE_DOMAIN` to your domain and `COOKIE_SECURE=true`.

**Database connection errors on first boot.**
MariaDB takes a few seconds to initialize a brand-new `mariadb-data` volume. The
server waits on the db healthcheck, but if you changed `MYSQL_*` values after the
volume was already initialized, the credentials will not change inside the
database. Do not use `docker compose down -v`: that deletes the database.

If this started after setup was rerun or `.env` was overwritten, run one command
from the repository checkout on the affected Docker host:

```bash
npm run recover:database
```

The automatic path does not change MariaDB credentials. Setup rotates JWT,
encryption, token, WebSocket, and integration secrets as well as database
passwords, so repairing only MariaDB can silently strand encrypted data and
sessions. Recovery instead:

1. Stops writers and creates an independently verified cold archive of the
   exact MariaDB volume.
2. Checks at most the 20 newest, strictly named `.env.bak.YYYYMMDDHHMMSS`
   siblings, newest first. It accepts only regular, operator-owned, protected
   files with bounded database/user identifiers, validates each through its own
   scoped Compose config, and requires both its root and app credentials to
   authenticate to its declared database. Secrets go to MariaDB over standard
   input; logs contain fingerprints, never values.
3. Protects the overwritten current `.env` in the durable recovery directory,
   then atomically restores the complete authenticated prior environment.
4. Recreates the intended `db`, `server`, and `app` stack, requires database,
   backend, and front-door readiness, and runs a logical backup/restore drill.

The printed recovery directory is outside the repository and OS temporary
folders: `%LOCALAPPDATA%\StandardRedNotes\recovery` on Windows,
`~/Library/Application Support/StandardRedNotes/recovery` on macOS, or
`${XDG_STATE_HOME:-~/.local/state}/standard-red-notes/recovery` on Linux. Backup
archives, checksums, and the displaced environment are operator-only.

Normal setup reruns validate and reuse an existing `.env` without rotating any
configured secret. The one migration exception is an older keyless environment:
setup adds `ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY` only after proving that no
encrypted pairing file exists. `--force-overwrite` / `-ForceOverwrite` is
required for an intentional rotation.

<details>
<summary>Exceptional and intentional rotation controls</summary>

Use `--previous-env-file` to select a specific protected backup, `--backup-dir`
to select another protected durable location, and `--env-file`,
`--compose-file`, or `--project-name` for an isolated deployment. These are
advanced overrides; the normal recovery needs none of them.

An intentional database-only rotation, where every non-database server secret
was deliberately kept stable, uses `--rotate-database-credentials`. That mode
backs up first, bounds every MariaDB account host it will touch, and repairs the
root/app accounts. It never starts `--skip-grant-tables`. If no trusted prior
credential authenticates, it changes no SQL and prints the manual maintenance
boundary.

</details>

For deployment security, continue with [Operations
Hardening](operations-hardening.md). Before mixing original Standard Notes
clients or moving an original vault, use [Standard Notes
Compatibility](standard-notes-compatibility.md).
