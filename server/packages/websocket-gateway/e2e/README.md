# websocket-gateway end-to-end scripts

These are live scripts, not unit tests. Each one dials a running stack and exits
non-zero when a check fails. They are plain ESM and resolve `ws`, `ioredis`,
`jsonwebtoken` and `yjs` from this package, so run them through Yarn rather than
bare `node`:

```sh
# from server/
yarn workspace @standard-red-notes/websocket-gateway node e2e/<script>.e2e.mjs
```

The workspace is named `@standard-red-notes/websocket-gateway` — the hyphenated
scope, unlike every other server package, which uses `@standardnotes/`. Getting
that wrong produces a Yarn `Usage Error` rather than a missing-script error, and
`yarn workspace <pkg> eslint <files>` is likewise not a script: always check the
exit code explicitly (`cmd; echo "EXIT $?"`, never after a pipe).

Containers and CI run **Node 26**; local development is on Node 24. Behaviour
that depends on the Node version cannot be proven locally — run it in the
container.

## Scripts

| script | what it proves | where it runs |
|---|---|---|
| `realtime.e2e.mjs` | readiness through the front door, the internal mint being refused at the front door and accepted from loopback, the cross-service mint, and Redis push delivery/exclusion | front door for the public legs, inside the container for the loopback mint legs |
| `collab-yjs.e2e.mjs` | encrypted two-editor Yjs convergence, protocol v3 epoch binding, and `room-denied` epoch adoption | inside the container |
| `push-roundtrip.e2e.mjs` | the whole cross-device push chain: save → syncing-server → SNS/SQS → gateway worker → the other device's socket | host or container; `--self-test` runs offline |
| `sync-items-oversized.e2e.mjs` | an oversized committed `SYNC_ITEMS` result answers `STATUS COMMITTED code RESULT_TOO_LARGE` with no `result`, and the HTTP replay returns the journaled items | host or container, `SERVICE_PROXY_TYPE=grpc` only |
| `browser.e2e.mjs`, `feature-access.e2e.mjs`, `account-export-import.e2e.mjs` | browser-driven flows (`yarn e2e:browser`) | host |

`yarn e2e` runs `realtime` then `collab-yjs`. The push round trip and the
oversized-result script have their own scripts because they register accounts
and take tens of seconds.

## Reaching the gateway

Defaults target the **public front door** (the app nginx on `:3001`), which is
the only origin a browser ever uses. Two consequences:

- The legacy lane upgrades on the exact pathname `/sockets` and nothing else.
  Any other path is closed `1008 unknown path`, so URLs are
  `ws://localhost:3001/sockets?authToken=…`.
- `x-internal-secret` mints do **not** work through the front door. nginx blanks
  `X-Internal-Secret` on `/sockets`, and the gateway refuses an internal mint
  whenever `x-forwarded-for` is present or the peer is not loopback. A script
  that needs that leg must reach the gateway from loopback — inside the
  container, or through `docker compose exec`. `realtime.e2e.mjs` asserts the
  front-door refusal and only runs the loopback legs when
  `GATEWAY_INTERNAL_HTTP` is set.

`REQUIRE_GATEWAY=1` turns an unreachable stack into a failure instead of a skip.
CI always sets it, so a stack that never came up cannot pass as "skipped".

## Running from inside the container

```sh
docker compose exec -T \
  -e REQUIRE_GATEWAY=1 \
  -e GATEWAY_HTTP=http://127.0.0.1:3000 \
  -e GATEWAY_WS=ws://127.0.0.1:3000/sockets \
  server yarn node packages/websocket-gateway/e2e/collab-yjs.e2e.mjs
```

### Git Bash / MSYS on Windows

MSYS rewrites any argument that looks like a POSIX path, so
`docker compose exec … /healthcheck/readiness` arrives inside the container as
`C:/Program Files/Git/healthcheck/readiness`. Prefix the command with
`MSYS_NO_PATHCONV=1` whenever an argument starts with `/`:

```sh
MSYS_NO_PATHCONV=1 docker compose exec -T server curl -s http://127.0.0.1:3000/healthcheck/readiness
```

PowerShell and Linux shells are unaffected.

## Offline self-check

`push-roundtrip.e2e.mjs --self-test` needs no stack and no Docker. It runs the
real parsing, accounting and verdict functions against synthetic frames and
drives the real round-trip routine through an in-process stand-in that enforces
the same `/sockets` pin, in both push payload modes:

```sh
yarn workspace @standard-red-notes/websocket-gateway node e2e/push-roundtrip.e2e.mjs --self-test
```

## Push payload modes

`WEBSOCKET_SYNC_PUSH_ENABLED` defaults to **off**, so a push is a bare
`ITEMS_CHANGED_ON_SERVER` notification with no items and the client pulls over
HTTP. Only the exact string `true` inlines `SYNC_ITEMS_PUSHED` payloads, and
`WEBSOCKET_SYNC_PUSH_MAX_BYTES` (200 KiB) falls back to the plain notification
above that size. `push-roundtrip.e2e.mjs` detects the mode from the frames
rather than reading the flag, so it is correct either way.

## Removed scripts

`collab.e2e.mjs` targeted the v2 collaboration protocol and was deleted: the
gateway speaks v3 only, so every run either skipped or failed. `collab-yjs.e2e.mjs`
is its replacement and covers strictly more. The nested
`server/.github/workflows/e2e-self-hosted.yml` and `server/docker-compose.ci.yml`
went with it — they were upstream reference material that no root workflow
called, and they described a stack this monorepo does not build.
