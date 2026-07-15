---
title: Operations Hardening
description: Database resilience, operation limits, and Docker hardening guidance.
---

# Operations Hardening

This page is the operator-facing checklist for the production Docker stack. It
covers the parts that protect availability and blast radius: MariaDB durability,
connection limits, Redis/cache ceilings, request limits, signup controls, and
container hardening.

## Database Resilience

The multi-container stack stores primary state in the `mariadb-data` named
volume. The database is internal-only: it publishes no host port and is reachable
only on the Compose network.

The MariaDB service now starts with explicit safety defaults:

| Control | Default | Why it exists |
| --- | ---: | --- |
| `DB_MAX_CONNECTIONS` | `150` | Keeps a runaway client pool from exhausting the server. |
| `DB_CONNECTION_LIMIT` | `20` per Node process | Bounds each TypeORM pool. Keep the DB max above the sum of active pools. |
| `DB_MAX_QUERY_EXECUTION_TIME` | `45000` ms | Logs slow queries for diagnosis. |
| `DB_INNODB_BUFFER_POOL_SIZE` | `512M` | Gives InnoDB a bounded cache within the default `DB_MEM_LIMIT=1g`. |
| `DB_MAX_ALLOWED_PACKET` | `128M` | Allows large encrypted payloads without leaving the packet size unbounded. |
| `DB_INNODB_FLUSH_LOG_AT_TRX_COMMIT` | `1` | Favors crash durability by flushing transaction logs at commit. |
| `local_infile` | disabled | Removes an unnecessary file-loading surface. |

The `db` healthcheck runs a real `SELECT 1` against the configured application
database instead of only checking that the MariaDB process is alive.

### Connection Budget

The server container runs several Node services under supervisord. Each
MySQL-backed package uses `DB_CONNECTION_LIMIT`; the current default is 20.
For a single server container, `DB_MAX_CONNECTIONS=150` leaves headroom for auth,
syncing, revisions, websocket/legacy packages, migration/admin tasks, and a
short overlap during restarts.

If you scale out more server containers, increase `DB_MAX_CONNECTIONS` and
`DB_MEM_LIMIT` together. A practical starting formula is:

```text
DB_MAX_CONNECTIONS >= (server replicas * DB-using processes per replica * DB_CONNECTION_LIMIT) + admin headroom
```

Do not raise the per-process pool first. Raise it only when live metrics show
connection wait time is the bottleneck.

### Backup And Restore

Take logical database backups while the stack is running:

```bash
docker compose exec db sh -c \
  'exec mariadb-dump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines "$MYSQL_DATABASE"' \
  > backup.sql
```

Restore into a running stack:

```bash
docker compose exec -T db sh -c \
  'exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
  < backup.sql
```

Run the non-destructive restore drill before trusting a backup procedure:

```bash
node scripts/verify-backup-restore.mjs
```

The drill dumps the live MariaDB database, restores it into a temporary
`srn_restore_*` database, compares the restored table list, row counts, and
table checksums, then drops only the temporary database. Run it when the system
is idle so live writes do not change the source database while the comparison is
in progress. Use `--keep-backup` or `--output backup.sql` when you want to keep
the generated dump for inspection.

Back up the `uploads` volume with the database if you use file attachments.
Keep `.env` backed up separately. Losing server secrets can invalidate sessions
or make server-side encrypted settings unreadable.

### Restart Safety

The admin UI can restart Redis and MariaDB only when the optional `ops` profile
is running and the server has `SERVICE_CONTROL_DOCKER_ENABLED=true`. The server
never receives the raw Docker socket. It talks to `docker-socket-proxy`, which is
configured to permit only container restart endpoints.

Database restarts are intentionally visible operations. Use them for controlled
maintenance, not routine remediation. Back up before risky changes such as
database image upgrades, memory reductions, or major version moves.

## Operation Limits

The stack has several independent limits. They are intentionally layered because
each protects a different failure mode.

| Surface | Default | Control |
| --- | ---: | --- |
| Gateway JSON/body payload | `50 MB` | `HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES` |
| File upload chunk | `100,000,000` bytes | `MAX_CHUNK_BYTES` |
| Absolute attachment size | `5 GiB` | `MAX_ATTACHMENT_BYTE_SIZE` |
| Login/recovery attempts | `10/min/IP` | `RATE_LIMIT_LOGIN_MAX`, `RATE_LIMIT_WINDOW_SECONDS` |
| Registration and magic-link-sensitive calls | `5/min/IP` | `RATE_LIMIT_REGISTRATION_MAX` |
| Authenticated expensive endpoints | off | `RATE_LIMIT_USER_MAX`, `RATE_LIMIT_USER_WINDOW_SECONDS` |
| AI daily request cap | off | `ASSISTANT_DAILY_REQUEST_LIMIT` |
| AI token windows | off | `ASSISTANT_5H_TOKEN_LIMIT`, `ASSISTANT_WEEKLY_TOKEN_LIMIT` |
| Server-side OCR | off | `OCR_SERVER_ENABLED`, `OCR_SERVER_MAX_PAGES`, `OCR_SERVER_MAX_IMAGE_BYTES` |
| Revision retention | unlimited | `REVISIONS_RETENTION_DAYS`, `REVISIONS_MAX_COUNT_PER_ITEM` |

Unauthenticated rate limits are Redis-backed and fail open if Redis is down, so a
cache outage cannot lock legitimate users out of their notes. The tradeoff is
that IP blocks and rate limits temporarily degrade during a Redis outage.

For public instances, consider setting:

```dotenv
REGISTRATION_INVITE_ONLY=true
REGISTRATION_APPROVAL_REQUIRED=true
REGISTRATION_SIGNUPS_PER_IP_MAX=5
REGISTRATION_SIGNUPS_PER_IP_WINDOW_HOURS=24
REGISTRATION_MAX_TOTAL_ACCOUNTS=<your planned capacity>
```

For expensive authenticated operations, consider:

```dotenv
RATE_LIMIT_USER_MAX=30
RATE_LIMIT_USER_WINDOW_SECONDS=60
ASSISTANT_DAILY_REQUEST_LIMIT=100
ASSISTANT_5H_TOKEN_LIMIT=200000
ASSISTANT_WEEKLY_TOKEN_LIMIT=1000000
```

Tune these to your hardware and user count. A small personal instance can keep
most authenticated limits off; a public instance should set them deliberately.

## Redis Limits

Redis is used for cache, rate-limit counters, transient operation state, and
event plumbing. It is persisted with append-only files, but it is not the source
of truth for notes.

The Compose service now sets:

```dotenv
CACHE_MEM_LIMIT=256m
CACHE_MAXMEMORY=192mb
CACHE_MAXMEMORY_POLICY=noeviction
```

`CACHE_MAXMEMORY` is below the container memory limit so Redis returns controlled
write errors instead of being OOM-killed. `noeviction` avoids silently discarding
keys that may represent rate-limit or transient operation state. If you operate
a high-churn instance and accept eviction semantics, choose a policy explicitly.

## Docker Image And Runtime Hardening

The stack is designed so the app front door is the only published service. The
server, database, cache, queue emulator, MCP bridge, n8n, and docker socket proxy
remain internal-only unless you explicitly change Compose.

Runtime hardening currently includes:

| Service | Hardening |
| --- | --- |
| `app` | Unprivileged nginx image, `no-new-privileges`, all capabilities dropped, memory/PID limits, tmpfs scratch paths. |
| `server` | Unprivileged `srn` user, no compiler toolchain in runtime stage, `no-new-privileges`, all capabilities dropped, memory/PID limits, internal-only ports. |
| `db` | Internal-only MariaDB, least capabilities for official entrypoint ownership drop, memory/PID/no-file limits, graceful stop period. |
| `cache` | Internal-only Redis, least capabilities for user drop, memory/PID/no-file limits, explicit Redis maxmemory. |
| `floci` | Internal-only SNS/SQS emulator, `no-new-privileges`, all capabilities dropped, memory/PID limits. |
| `docker-socket-proxy` | Optional profile, raw socket mounted only here, all Docker API surfaces denied except restart endpoints. |
| single-container profile | Unprivileged `srn` user, capability drop, `no-new-privileges`, memory/PID limits, tmpfs `/tmp`, one published port. |

`read_only` is not globally enabled because several containers intentionally
rewrite runtime config, write supervisor logs, write sqlite/uploads, or maintain
database/cache state. Writable paths are constrained with named volumes and tmpfs
where the current images support it safely.

### Image Pinning

Compose supports image override variables for production pinning:

```dotenv
MARIADB_IMAGE=mariadb:lts
REDIS_IMAGE=redis:8-alpine
FLOCI_IMAGE=floci/floci:1.5.29-compat
N8N_IMAGE=n8nio/n8n:latest
DOCKER_SOCKET_PROXY_IMAGE=tecnativa/docker-socket-proxy:0.3.0
```

For reproducible production pulls, replace mutable tags with exact tags or
`repo@sha256:<digest>` values after your own image update review. This is
especially important for optional services that otherwise track moving upstream
tags, such as n8n.

## Verification Commands

Check the rendered Compose model:

```bash
docker compose config
docker compose -f docker-compose.single.yml config
```

Check service health:

```bash
docker compose ps
docker compose exec db sh -c \
  'mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "SELECT 1"'
```

Check key MariaDB variables:

```bash
docker compose exec db sh -c \
  'mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" -e "SHOW VARIABLES WHERE Variable_name IN (\"max_connections\", \"max_allowed_packet\", \"innodb_buffer_pool_size\", \"innodb_flush_log_at_trx_commit\", \"local_infile\")"'
```

Check Redis memory policy:

```bash
docker compose exec cache redis-cli CONFIG GET maxmemory
docker compose exec cache redis-cli CONFIG GET maxmemory-policy
```

Run the e2e safety gates after hardening changes:

```powershell
$env:APP_URL = "http://localhost:3001"
npm --prefix e2e test -- app-opens.spec.ts --project=chromium
npm --prefix e2e test -- encryption-data-safety.spec.ts --project=chromium
npm --prefix e2e run test:ops-load
node scripts/verify-backup-restore.mjs
```

The ops load gate can be scaled without editing code:

```powershell
$env:OPS_LOAD_NOTES = "250"
$env:OPS_LOAD_CLIENTS = "4"
$env:OPS_REDIS_WORKERS = "4"
$env:OPS_REDIS_OPS_PER_WORKER = "500"
npm --prefix e2e run test:ops-load
```

It registers a real account, pushes encrypted notes to the server, signs in
parallel clients, verifies pulled note integrity, runs concurrent Redis
SET/GET/INCR churn, checks Redis throughput, and confirms MariaDB persisted the
expected note rows.
