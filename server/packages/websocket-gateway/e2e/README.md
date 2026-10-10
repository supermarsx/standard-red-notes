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
| `collab-yjs.e2e.mjs` | encrypted two-editor Yjs convergence, >512 KiB chunked state transfer, offline-edit reconnection, protocol v3 epoch binding, `room-denied` epoch adoption, and that nothing on the wire is note plaintext — the RELAY only, see below; `--self-test` covers its mint diagnosis | inside a MULTI-container `server` container |
| `collab-end-to-end.e2e.mjs` | collaboration on two REAL accounts: a real shared vault, a real invite, `COLLABORATION_AUTHORIZE` answering a PRESENT `authorized: true`, two editors converging with measured latency, read-only refused server-side, removal revoking, and the negative cases | host or container, any proxy configuration |
| `push-roundtrip.e2e.mjs` | the whole cross-device push chain: save → syncing-server → SNS/SQS → gateway worker → the other device's socket | host or container; `--self-test` runs offline |
| `sync-items-oversized.e2e.mjs` | an oversized committed `SYNC_ITEMS` result answers `STATUS COMMITTED code RESULT_TOO_LARGE` with no `result`, and the HTTP replay returns the journaled items | host or container, `SERVICE_PROXY_TYPE=grpc` only |
| `capability-fallback.e2e.mjs` | the socket capability census from `AUTHENTICATED`, each capability exercised over the lane, and each documented HTTP fallback exercised on the same account in the same run; `CONTROL=1` adds a planted break per probe | host or container, any proxy configuration |
| `browser.e2e.mjs`, `feature-access.e2e.mjs`, `account-export-import.e2e.mjs` | browser-driven flows (`yarn e2e:browser`) | host |

## A lane is "working" only on a PRESENT success

`capability-fallback.e2e.mjs` used to settle four of its six lane rows with
`answer !== undefined && !isOperationUnavailable(answer)` — "the lane works
unless it answered this one error code". That is not a gate. It recorded
`FILES_V1 lane: works` against an image on which **every** cookie-session file
operation answered `ERROR FILE_ACCESS_DENIED` (the defect `efa5b985` fixed):
an error, just not the one error the predicate happened to name.

The rule now is a present success, and it is the same rule everywhere:

| leg | green on |
|---|---|
| `SYNC_ITEMS` | a `COMMITTED` answer **and** the note read back over HTTP |
| `API_RPC` | an `RPC_RESPONSE` with `status: 200` |
| `STREAM_ASSISTANT` | an `RPC_*` frame, or an ERROR in `LANE_POLICY_CODES` |
| `AUTHORIZE_COLLABORATION` | a note the account OWNS: epoch discovery answers an epoch pair for that room, the grant leg that consumes its one-use challenge answers a CAPABILITY bound to the room, the epoch pair and the lease, **and** a note that was never created is refused `NOT_AUTHORIZED` / 403 |
| `INVITE_EVENTS` | `INVITE_READY` / `INVITE_BATCH` / `INVITE_RECONCILE`, or an ERROR in `LANE_POLICY_CODES` |
| `FILES_V1` | a whole file round trip: metadata answered, upload OPEN accepted, every chunk ACKed, FINISH completed on the client's digest, download accepted and completed on that digest, bytes byte-identical |
| `LEGACY_PUSH` | the server answered a control **ping** on the live connection |
| any HTTP fallback | a 2xx, or a 4xx the handler itself produced (`httpFallbackReachable`) |

`LANE_POLICY_CODES` is a closed list of codes that mean *the server decided*
(`NOT_AUTHORIZED`, `READ_ONLY`, `CONTENT_LIMIT`, `SHARED_VAULT_FORBIDDEN`,
`LIVE_SYNC_DISABLED`, `CHALLENGE_EXPIRED`). Everything else — `BACKEND_ERROR`,
`BACKEND_TIMEOUT`, `SESSION_STALE`, `SESSION_REVOKED`, `OPERATION_UNAVAILABLE`,
`INVITE_STORE_UNAVAILABLE`, `FILE_ACCESS_DENIED` — is a broken lane. A failure
code added upstream lands outside the list and reads broken, which is the safe
direction.

Two corollaries that cost real debugging time:

- **A 5xx is not reachability.** `status !== 404 && status !== 405` called a 502
  a working HTTP fallback. Reachability is now a closed set of statuses.
- **"No close event yet" is not a live socket.** `ws` resolves `open` on the
  HTTP 101, so the legacy lane is settled by a ping/pong round trip instead.

Proven red on a known break: run against `standard-red-notes/single:t100e2b`
(the last image without the authorizer's cookie channel) the FILES_V1 row
reports `lane: broken`, `stoppedAt: metadata`, `lastError: ERROR:FILE_ACCESS_DENIED`;
against a current single container the same row reports `lane: works`,
`chunks 2/2`, `bytes 3000/3000`, `bytesIdentical: true`.

## Two blind spots these scripts had, and the defect that lived in both

Measured on `d7bd839d`: `COLLABORATION_AUTHORIZE` was denied for **every** note
on **every single-container** deployment — a personal note owned by the caller
included — because `DirectCallServiceProxy.callSyncingServer` declared three
parameters where `ServiceProxyInterface` declares four and silently discarded
`payload`. `CollaborationAuthorizationService` is the only caller whose body
exists ONLY as that argument, so `authorizeCollaboration` read
`request.body.itemUuid`, found `undefined`, and failed closed. Nothing logged;
the only trace was a `collaboration_authorization denied` counter.

Neither script in this directory could see it, for two different reasons, and
both reasons are worth keeping in mind before trusting a green run here:

- **`collab-yjs.e2e.mjs` does not authorize anything.** It mints its own
  connection tokens with `x-internal-secret` and signs its own room
  capabilities with `WEB_SOCKET_CONNECTION_TOKEN_SECRET`, for user uuids that
  need not exist. It therefore never enters `COLLABORATION_AUTHORIZE`, never
  reads `shared_vault_users.permission`, and never touches a shared vault. It
  proves the RELAY converges, which is real and useful — and says nothing about
  whether any user is ALLOWED to collaborate.

- **`capability-fallback.e2e.mjs`'s AUTHORIZE_COLLABORATION row cannot
  distinguish a grant from a refusal.** It probes
  `collabNoteUuid = randomUUID()` — a note it never created — and settles the
  row on "a `COLLABORATION_AUTHORIZED` frame, `authorized` **either way**". For
  a note that does not exist `authorized: false` is the CORRECT answer, so the
  row's success case is unreachable by construction and it reads `works` on a
  stack where every authorization is denied. That is the same shape as the
  FILES_V1 false green this file warns about one section up, arrived at from
  the other direction: not "not this one error code", but a predicate whose
  positive case the probe never sets up.

Both of those are now closed, and the second one is closed in the file above
rather than only in a new file beside it.

**The `AUTHORIZE_COLLABORATION` row takes a note the account OWNS.** The row is
green only on a PRESENT grant in each transport -- epoch discovery answering an
epoch pair for that room, then the grant leg consuming its one-use challenge and
answering a capability whose decoded claims name the same room, the same epoch
pair, the same lease and the same canonical revision -- **and** red unless a
note that was never created is refused by a DECISION in the same run. Both
halves are load-bearing: without the grant the row is the old row, and without
the refusal it would pass on an authorizer that grants everything.

**`collab-yjs.e2e.mjs` is kept, and its scope is now printed.** The claim that
it cannot run against a shipped image is false: `yarn node` resolves `ws`, `yjs`
and `y-protocols` from the PnP store inside the production `server` image, and
the `ci.yml` compose job has been running it there on every push -- measured
green inside `srn-collab/server` at `d7bd839d`. What is true is narrower and
worth knowing:

- it **cannot** run on the single container. `POST /sockets/tokens` is
  registered by the api-gateway **Express app**; `HomeServer` attaches the
  gateway to the `http.Server` it owns and never registers that route, so the
  internal mint is a 404 there by design. It used to report that as
  `token mint returned 404`, which reads like a broken server;
  `diagnoseMintFailure` now names the topology, and names the leg that does work
  there. A 401/403 says whether the placeholder secret was sent or a real one
  mismatched; a 503 names the connection-token floor. `--self-test` proves each
  of those messages, and proves none of them is another's.
- a green run of it is **not** a statement about authorization, so it says so
  itself now, on every run and again after a PASS.

Retiring it was the alternative and would have been wrong: the >512 KiB chunked
encrypted transfer, the offline-edit reconnection, the `room-denied` epoch
adoption and the explicit "no note plaintext on the wire" assertion are not
covered anywhere else, including by `collab-end-to-end.e2e.mjs`. Bypassing the
authorizer is what makes the relay measurable in isolation; the error was never
that the probe exists, it was that `yarn e2e` consisted of it plus `realtime`,
so the only collaboration leg anyone ran was the one that cannot see the
authorizer. That is a SCRIPT WIRING problem and it is fixed as one.

**What now runs.** `yarn e2e` is `realtime` + `collab-yjs` +
`collab-end-to-end`, and there are `e2e:collab-yjs`,
`e2e:collab-yjs:self-test`, `e2e:collab-end-to-end`,
`e2e:collab-end-to-end:self-test` and an `e2e:self-test` that chains all four
stack-free self-tests. `ci.yml`'s compose job gained two steps after the push
round trip, both from the front door: `collab-end-to-end.e2e.mjs`, and
`capability-fallback.e2e.mjs` with `CONTROL=1 EXPECT_SESSION=cookie`. So the
authorization lane and the capability matrix are no longer gates nobody
consumes.

Both claims above are measured, not argued. The same single-container image
with and without the `payload` fix, booted side by side:

| | `capability-fallback` AUTHORIZE_COLLABORATION | `collab-end-to-end` |
|---|---|---|
| image WITHOUT the fix (every authorization denied) | `lane: "works"`, `laneDetail {"type":"ERROR","code":"NOT_AUTHORIZED"}`, `failures: 0` | exit 1, 8 failures |
| image WITH the fix | `lane: "works"`, `laneDetail {"type":"ERROR","code":"NOT_AUTHORIZED"}`, `failures: 0` | exit 0 |

The capability row was **byte-identical** across a defect that denied 100 % of
collaboration. It was not wrong about what it measured — the lane did carry a
frame, and a refusal for a note that does not exist is correct — it simply could
not distinguish a working authorizer from a broken one, because it never created
a note it was entitled to edit.

Re-measured with the row rewritten, on the same two images (`srn-collab/single`
at `collab-probe` and `collab-fixed`, whose compiled
`DirectCallServiceProxy.callSyncingServer.length` really is 3 and 4):

| | `AUTHORIZE_COLLABORATION` row, OLD predicate | `AUTHORIZE_COLLABORATION` row, NEW predicate |
|---|---|---|
| image WITHOUT the fix | `lane: works`, `fallback: reachable`, exit 0, `failures: 0` | `lane: broken`, `fallback: broken`, **exit 1, 4 failures** |
| image WITH the fix | `lane: works`, `fallback: reachable`, exit 0, `failures: 0` | `lane: works`, `fallback: works`, exit 0 |

The old row is identical in both columns. The new row separates them, and the
four failures name the stage: discovery refused `NOT_AUTHORIZED`, the grant leg
never reached, the HTTP discovery 403, the HTTP grant leg never reached.

`collab-end-to-end.e2e.mjs` exists for that gap. It registers two real
accounts, creates a real shared vault, accepts a real invite, and requires a
PRESENT `authorized: true` carrying a capability bound to the room, the epoch
pair and the lease — and requires the refusals to be DECIDED
(`NOT_AUTHORIZED` / 403 `collaboration-not-authorized`), never
`BACKEND_ERROR`, `BACKEND_TIMEOUT` or silence. Its `--self-test` proves each
predicate can fail and needs no stack.

## Session kind matters, and it is chosen at registration

`SessionService.shouldOperateOnCookieBasedSessions` issues a COOKIE session only
when the registration `api` is exactly `20240226` **and** `forceLegacySessions`
(`E2E_TESTING === 'true'`) is off. A script that registers at `20200115` — as
`sync-items-oversized.e2e.mjs` does — gets a LEGACY header session even on a
stack with no `E2E_TESTING` anywhere, so it cannot observe a cookie-session
defect. `capability-fallback.e2e.mjs` registers at `20240226` by default,
asserts the `2:` access-token prefix under `EXPECT_SESSION=cookie`, and under
`CONTROL=1` proves the cookie half is load-bearing by showing the bearer ALONE
is refused 401. Set `REGISTER_API=20200115` to re-take the same matrix on legacy
sessions and diff the two. A run that asks for the cookie api and gets a `1:`
token back now emits an unprompted note saying so, because every row it then
prints is measured on a header session.

Where the flag actually is, measured:

- `server/docker/single/entrypoint.sh` pins `E2E_TESTING false`, so the single
  container issues real cookie sessions. The FILES_V1 defect was reachable
  there, which is why the round trip above can be shown red against
  `single:t100e2b` and green against a current build.
- No compose file sets it, so the multi-container stack issues cookie sessions
  too.
- `server/.github/workflows/e2e-home-server.yml` writes `E2E_TESTING=true` into
  `packages/home-server/.env`. That suite therefore runs in the one
  configuration where a cookie-session defect cannot occur, and a green run of
  it is not evidence about cookie sessions.

So the flag does **not** make this class invisible to the scripts in this
directory, provided they are pointed at a stack that does not set it — but it
does make the home-server workflow structurally blind to it, and that workflow
is the only one of the two that CI runs.

## Not every capability has a configuration lever

Measured live on the multi-container image at `71e055f8`:

- `SYNC_ITEMS` can be withheld (unbind the durable command port).
- The whole lane can be withheld (`WEBSOCKET_SYNC_ENABLED=false`, or a
  `WEB_SOCKET_CONNECTION_TOKEN_SECRET` under 32 bytes), which withholds all six
  at once while the legacy `/sockets` push lane keeps working.
- `API_RPC` and `STREAM_ASSISTANT` are hardcoded in `bin/server.ts` and have no
  lever at all.
- `FILES_V1` has no reachable lever either: compose restores
  `WEBSOCKET_SYNC_FILES_URL` on an empty value and `docker-entrypoint.sh`
  re-fills it when still empty, so the `FILES_INTERNAL_URL` waiver branch cannot
  be reached from an operator env.

`yarn e2e` runs `realtime`, `collab-yjs` and now `collab-end-to-end`, so the
authorization lane is in the script someone runs. The push round trip and the
oversized-result script have their own scripts because they register accounts
and take tens of seconds.

## What CI runs, and what it still does not

`ci.yml`'s compose job runs `collab-yjs` (inside the container), `realtime`
(inside the container, for the two origins), the push round trip, **and now**
`collab-end-to-end.e2e.mjs` and `capability-fallback.e2e.mjs` from the front
door. `session-reauth.e2e.mjs` and `transport-fallback.e2e.mjs` are still
operator-run probes that no workflow calls, and a correct predicate in one of
those is still a gate nobody consumes: it goes red only when a person runs it.
`e2e:self-test` chains the four stack-free self-tests and is the cheap half of
all of this.

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
