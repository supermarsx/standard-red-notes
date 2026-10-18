---
title: Socket reliability audit
---

# Socket reliability audit — 18 October 2026

Reviewed revision: `76460bd88b2f130c35d429e286e23fa570f7dc8d`.
The findings below describe that reviewed revision. The subsequent repair is recorded here; this is not a claim that every socket defect has been found.

## Repair status

The follow-up implementation addresses the reproduced failures:

- A single generation-scoped writer orders command journaling and numbered frames across the socket lanes. Cancelled sends consume no sequence; obsolete queued work cannot act on a replacement socket. Heartbeats use the same writer.
- Journal recovery, execution admission, and checkpoint deletion are serialized. Late checkpoints clear the matching in-memory command, without clearing unrelated pending work. Asynchronous reads recheck ownership before adopting work.
- Undecidable authorization returns HTTP 503 or a retryable socket backend error. Real permission denials remain terminal. Authorization promises are session-fenced, one-use grants are not retained, and the reusable cache expires and is capped at 128 entries.
- Protocol diagnostics now distinguish frame ordering, invalid envelopes, sequence exhaustion, and invalid invitation acknowledgements. Central gateway metrics record protocol closes, and recovery errors retain a closed cause code.
- Reauthentication uses a rolling eight-per-minute budget instead of eight per socket lifetime. Socket connection establishment now has a generation-bound deadline before `onopen`.

The historical reproduction patches below target the audited revision, not the repaired checkout. Their corrected regression tests now live in the normal worker, recovery, authorization, and protocol suites. Production deployment and a live browser acceptance run remain separate from these repository-level checks.

Repair validation: 227 worker/recovery tests, 314 transport/diagnostics tests, 184 collaboration/shared-worker/file-transfer tests, 87 services tests, 210 API authorization tests, and 163 gateway tests passed. Web, services, and API TypeScript checks passed, with the gateway built to verify its exported contract. Scoped lint reported no errors.

## Incident and scope

Reported sequence: `DEGRADED / server-policy`, successful socket negotiation, “Durable sync recovery must complete before a new command can execute”, then repeated `encrypted-yjs-lease-reactivation-failed attempt=0`.

Reviewed client frame dispatch, shared-worker ownership, durable journal/checkpoint recovery, gateway admission and sequence enforcement, authorization and session refresh, encrypted room reactivation, and failure reporting. Three parallel reviews were independently integrated. No live production connection, credentials, origin configuration, or server logs were accessed.

The account sync socket and the collaboration/push socket are separate lifecycles. A READY account socket does not establish that the collaboration room has a valid lease, canonical state, or an available durable saver.

## Findings, in repair order

### P1 — Concurrent sends violate the gateway's frame sequence

**Reproduced.** `SyncTransportWorkerRuntime.ts:4080` reserves a COMMAND sequence before asynchronous outbox writes at 4100 and 4124. Other lanes can allocate and send their next sequence during those writes. The command is finally sent at 4133.

A deterministic worker regression delays the outbox write, starts an RPC, then releases the write. Expected wire order `[1, 2]`; actual order `[2, 1]`. The gateway correctly rejects the first unexpected sequence with `OUT_OF_ORDER` at `server/packages/websocket-gateway/src/syncCommandHandler.ts:1219`, closing with 1008. The client reports this as `server-policy`.

This is a concrete mechanism consistent with the incident, not proof of the deployed incident's exact close code. It does not require a bad origin or excessive traffic.

**Repair:** one ordered dispatch mechanism covering sequence allocation, durable command preparation, and wire send. Include RPC credit/cancellation, invite acknowledgements, reauthentication, collaboration authorization, and file-control frames. Guard queued work by socket generation and cancellation. Serializing only calls to `sendWithBackpressure` after the outbox writes is insufficient: the inversion has already occurred. Its independent polling waits at 4462 are a related overtaking hazard that also needs coverage.

**Acceptance:** delayed journal writes and backpressure cannot reorder numbered frames; reconnect/cancellation cannot send queued frames on another socket; durable journal-before-send semantics remain intact.

### P1 — A late checkpoint leaves a stale in-memory command after recovery

**Reproduced through public runtime messages.** After COMMITTED/RESULT, a 1008 close and failed reconnect force recovery. `requireDurableRecovery` at `SyncTransportWorkerRuntime.ts:5110` clears `active` but retains `outboxRecord`. A delayed `CHECKPOINT_DURABLE` deletes the stored record, but the cleanup at 4536–4554 also requires `active.sessionScope`, so it leaves the in-memory record behind.

The next recovery reports `RECOVERY_EMPTY` because IndexedDB is empty. The following new execute then sends STATUS for the previous, already checkpointed command through 4041–4048. The reproduction asserts that no old STATUS is emitted; it fails because one is emitted.

**Repair:** reconcile checkpoint completion by matching command identity and session, independently of a superseded active request. Do not clear another request's state. Fence concurrent recovery and checkpoint operations so deleted commands cannot be resurrected or reattached.

**Acceptance:** late checkpoint after close, ticket failure, tab detach, and recovery handoff clears only its matching command; a new execute sends its own body; uncertain, uncheckpointed mutations are still reconciled before replay.

### P1 — Temporary authorization outages become terminal edit denials

**Reproduced.** `CollaborationAuthorizationService.ts:350–361` catches an upstream access-check exception. Its denial helper at 290–303 logs that authorization could not be decided but returns the same `{ authorized: false }` used for a real denial. The controller returns HTTP 403 with “requires edit access”. The same controller instance returns 200 on the next healthy access check in the characterization test.

Client consequence: `WebsocketsService.ts:901` converts 403 to `COLLABORATION_NOT_AUTHORIZED`; `CollaborationKeyDerivation.ts:325` marks it terminal; `EncryptedYjsProvider.ts:698–700` enters `fatal`, stopping recovery. A temporary backend problem can therefore leave a room read-only after infrastructure recovers.

**Repair:** distinguish an undecidable/unavailable access check from denied access in the service contract and both HTTP/socket adapters. Keep unavailable access fail-closed, but make it retryable with bounded backoff. Preserve terminal handling for actual permission revocation.

**Acceptance:** one timeout then success recovers the room; an actual denied permission never enables editing or triggers an endless retry loop.

### P2 — A revoked session's pending authorization can repopulate the cache

**Reproduced.** `WebsocketsService.revokeSyncTransportSession` clears authorization maps at 413–414. A previously pending promise can still resolve and cache its capability at 826. A characterization test revokes, changes the transport, resolves the old promise, and observes the next authorization return `old-session-capability` without calling the replacement transport.

This proves stale client state, not successful unauthorized access: the server must still verify the capability. The effect can include rejected room joins and recovery churn. The unconditional `.finally(...delete(key))` also lacks ownership checks against a replacement request.

**Repair:** fence promise results and cleanup with an authorization/session generation; cache keys must not bridge session identities. Only delete a request mapping if it still refers to that promise.

### P2 — Authorization cache grows with consumed lease challenges

**Source-confirmed, not load-tested.** The cache removes an expired entry only when its exact key is queried. `useCollaborationRoomAccess.ts:667` creates a fresh lease request ID on every attempt, and that ID is part of the authorization cache key. Old successful lease grants can remain until revocation or deinitialization.

**Repair:** bound and expire the cache, and avoid retaining one-use challenge-bound grants when reuse is inappropriate. Test long reconnect sequences and expiry without revisiting old keys.

### P2 — Diagnostic aggregation hides the actionable cause

`syncTransportProtocol.ts:925–928` maps `INVALID_ENVELOPE`, `OUT_OF_ORDER`, `SEQUENCE_EXHAUSTED`, and `INVITE_ACK_INVALID` to `server-policy`. The worker sees the precise protocol code but the degradation ledger retains only that broad category. The gateway's OUT_OF_ORDER branch does not increment a corresponding protocol metric, and central `failAndClose` at 2668 does not fill that gap.

Similarly, `CollaborationKeyDerivation.ts:320–353` reduces several authorization/key-preparation failures to “could not establish a secure room”. Typed reporting in `WebsocketsService.ts:832–836` preserves only a small allowlist.

`requireDurableRecovery` also omits the triggering reason from its `RECOVERY_REQUIRED` message. The main thread therefore cannot distinguish those recovery triggers in the error it reports.

**Repair:** retain bounded, closed failure codes and stage names in diagnostics, with close code and attempt/generation correlation. Never log capability tokens, note content, URLs with credentials, or arbitrary server error strings. Count central protocol failures without double-counting existing branch counters.

### Long-session policy to reconsider — lifetime reauthentication cap

`syncCommandHandler.ts:691` permits eight reauthentication attempts for the entire socket lifetime. At 1380–1383 the ninth closes with `REAUTH_REJECTED`; successful refresh does not reset the count. This creates an eventual interruption for sufficiently long-lived connections. It is an explicit policy, not evidence for this incident's `server-policy` classification. Prefer a time-window abuse budget or another bound that allows legitimate long sessions.

## Interpreting the reported messages

- `server-policy` alone cannot identify an origin rejection. The reproduced sequence race is one concrete alternative.
- READY proves handshake/capability negotiation, not journal recovery or room readiness.
- The durable-recovery guard protects uncertain writes. Removing it or blindly replaying over HTTP would risk duplicate or conflicting saves.
- Repeated `attempt=0` does not show the normal retry ladder progressing. The counter resets on transport-connected events (`EncryptedYjsProvider.ts:1005–1018`), successful attach, and provider replacement. Correlated lifecycle telemetry is needed to distinguish these cases.
- Heartbeats and session revalidation exist. This review did not establish missing heartbeat as the cause.

## Reproduction artifacts and checks

Patches under `scripts/audits/` preserve diagnostic tests without installing deliberately failing or bug-affirming tests in the ordinary suite:

- `socket-sequence-race.patch`: one intended-invariant test fails with `[2, 1]` instead of `[1, 2]`.
- `socket-recovery-race.patch`: one intended-invariant test fails because the previous command receives STATUS after checkpoint deletion.
- `socket-authorization-outage.patch`: two server characterization tests and one client cache characterization test pass, demonstrating the current incorrect behavior.

From the repository root, apply a single patch with `git apply scripts/audits/<name>.patch`. Run its test, then reverse that patch with `git apply --reverse scripts/audits/<name>.patch`. Use a clean checkout or check the diff first. These patches are tied to the reviewed revision and should become desired-behavior regression tests when the corresponding repairs land.

From `app/packages/web`, the worker tests use:

```powershell
node ../../node_modules/jest/bin/jest.js --config jest.config.js --runInBand --silent --cacheDirectory F:/tmp/srn-jest-review-controls --transformIgnorePatterns='node_modules|packages[\\/]([^\\]+)[\\/]dist[\\/]' --testPathPatterns=SyncTransportWorkerRuntime.spec.ts --testNamePattern='preserves wire sequence while command journal'
```

For the recovery patch, replace the final two arguments with `--testPathPatterns=SyncTransportWorkerRuntime.recoveryAudit.spec.ts`.

For the authorization patch, from `server`:

```powershell
yarn workspace @standardnotes/api-gateway exec jest --config jest.config.js --runInBand --silent --testPathPatterns=CollaborationController.socketAudit
```

From `app/packages/services`:

```powershell
node ../../node_modules/jest/bin/jest.js --runInBand --silent --testPathPatterns=WebsocketsService.socketAudit
```

Existing shared broker, shared-worker client, protocol mapping, and save-lane suites passed: **64 tests across four suites**. Passing existing tests did not cover the newly reproduced interleavings.

## Limits and next implementation boundary

An additional static concern needs fault-injection verification: the worker starts its AUTH deadline only after socket `onopen`, and pending recovery has no independent deadline. A connection stuck in CONNECTING could hold the ordered queue until the browser reports failure. This was not reproduced and is not counted among the confirmed runtime defects above.

The initial audit made no production source changes; the follow-up repair is summarized above. No assertion is made that the deployed incident is conclusively attributed, or that all race conditions are known. Live acceptance should include multi-tab use, streaming-plus-save, sleep/resume, disconnect-during-checkpoint, and genuine access revocation. Raising limits or suppressing warnings alone does not repair these defects.
