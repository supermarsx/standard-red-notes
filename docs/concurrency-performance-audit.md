---
layout: default
title: Concurrency and performance audit — 16 October 2026
---

# Concurrency and performance audit

Audit baseline: `0f752fd0`. Reviewed Assistant execution and persistence, client transport lifecycle, server collaboration leases, comment observation/conflicts, nested folding, static caching, crypto workers and notification lifecycle. Findings below describe verified code behavior and deterministic regressions. They do not establish an exhaustive absence of defects or a measured Firefox speedup. No live signed-in browser session was available.

## Confirmed findings

| ID  | Priority     | Trigger and impact                                                                                                                                                                                           | Disposition                                                                                                                       |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| F01 | Medium       | Service worker serves cached healthy readiness during an outage. Hashed WASM loads also start unnecessary refreshes and parallel duplicate downloads; cache failures can block otherwise valid static loads. | Fixed: health bypass, immutable WASM single-flight/cache reuse, best-effort cache writes and online cache-error fallback.         |
| F02 | Medium       | Unrelated note saves make mounted private-comment panels reread the whole private-comment preference store.                                                                                                  | Fixed: relevant note/preference/trust observation, including decryption recovery.                                                 |
| F03 | High         | Stop invalidates the same lease predicate needed for the final shared transcript checkpoint, dropping buffered text and terminal activity state.                                                             | Fixed: distinguish continuing work from finalizing under the existing valid lease; late callbacks remain rejected.                |
| F04 | High         | Ownership acquisition/ticket inspection completes after shutdown/bootstrap replacement; delayed renewal failure affects a newer socket.                                                                      | Fixed: attempt/identity fencing and serialized ownership acquisition/cleanup.                                                     |
| F05 | Medium       | Shared-comment hook ignores note removal/insertion; removed note comments remain until an unrelated rerender.                                                                                                | Fixed: scoped add/remove/change/decryption-recovery handling; regression requires removal to clear UI without manual rerender.    |
| F06 | Medium       | Crypto worker postMessage throws synchronously, leaving its timer and failed worker in the pool; retries can reuse it.                                                                                       | Fixed: clear pending state and timeout, retire worker and retry on a fresh entry.                                                 |
| F07 | High         | Concurrent private-comment preference snapshots overwrite additions, discard concurrent comments during purge, or resurrect purged comments.                                                                 | **Open: requires a versioned merge/deletion model and migration.**                                                                |
| F08 | High         | Old Redis lease refresh fails after a replacement editor is admitted and denies/releases the replacement room.                                                                                               | Fixed: deterministic policy failures apply only to the exact still-current lease. Real Redis failures still invalidate the relay. |
| F09 | Medium / Low | Delayed footer usage response crosses an account/key boundary. Separately, local counters use a global last-writer-wins storage key despite a session label.                                                 | Footer response race fixed. **Counter attribution/concurrency remains open.** These counters do not enforce server limits.        |
| F10 | Medium       | Delayed sign-in approval poll creates toasts after teardown/account switch; resolution preceding the initial notification does not suppress stale delivery.                                                  | Fixed: lifecycle/principal fencing, resolution retention, owned-toast teardown and inert stale Review actions.                    |
| F11 | Medium       | Nested fold processing rebuilds descendant arrays for every ancestor on each document edit, yielding quadratic work.                                                                                         | Fixed: iterative traversal with disjoint hidden-subtree collectors and preserved nested collapse state.                           |

## Evidence and regression coverage

- Static cache: actual service-worker execution in `scripts/validate-web-runtime-security.test.mjs`, including stale readiness, concurrent WASM consumers with independent response streams, cache failures and retry.
- Cancellation: `assistantChatRunLease.spec.ts` and `ConversationPanel.sendPreflight.spec.tsx`, using the real lease guard semantics, buffered text, late callbacks and principal boundaries.
- Transport: `SyncTransportWorkerRuntime.spec.ts` deliberately pauses ownership acquisition, ticket ownership inspection and renewal across shutdown/replacement. The initial three races reproduced against the unmodified baseline.
- Server: `server/packages/websocket-gateway/test/collaborationRedisBridge.test.ts` pauses the old Redis refresh across successful replacement admission; tests also preserve denial on simulated Redis transport failure.
- Comments: `usePrivateNoteComments.observation.spec.tsx`, `useNoteComments.security.spec.tsx` and `CommentsSidebar.spec.tsx` cover unrelated saves, authoritative removals, insertions, trust/preferences and newly decrypted items.
- Workers: `DecryptionPool.spec.ts` makes postMessage throw and verifies fresh-worker recovery with no abandoned timeout.
- Usage: `Hooks/useAssistantUsage.spec.tsx` covers deferred old-principal responses and coalesced current-principal refreshes.
- Notifications: `PendingMfaApprovalsNotifier.spec.ts` covers late responses, early resolutions, teardown and stale toast actions.
- Folding: `FoldablePlugin.traversal.spec.ts` counts getChildren calls at nested depths 40 and 80, both expanded and collapsed. Work is bounded by 2D+1; mounted behavior tests preserve a child's collapse state when its parent is reopened.

Final local validation: 1,503 web tests across 123 suites, 979 gateway tests, and 34 runtime-security checks passed. Web and gateway TypeScript checks passed, as did scoped source lint and documentation/compatibility/safe-logging checks. Gateway coverage thresholds remained intact (92.51% statements, 91.61% branches). One opt-in real-Redis tombstone test was skipped because `SRN_COLLAB_REDIS_HOST` was not configured. The three synthetic private-comment probe scenarios reproduced the open bug. No live multi-device acceptance or Firefox timing profile was performed.

## Open private-comment data-loss issue

All private comment threads share one personal UserPrefs field. Local mutation queues serialize only one WebApplication instance. The generic singleton conflict strategy keeps one preference snapshot without a duplicate or per-comment reconciliation. Sockets do not change this conflict policy.

Read-only reproduction using current source and synthetic payloads:

```sh
node scripts/audit-private-comment-concurrency.cjs
```

Success means the probe **confirmed the known bug**, not that comments are healthy. The probe demonstrates concurrent cross-note addition loss, stale-edit resurrection after remote purge, and purge discarding a concurrent addition. It touches no user data and contacts no server.

A safe repair needs stable comment IDs, deterministic operation stamps, retained deletion tombstones, resolve/reopen ordering and purge watermarks. Migration must preserve version-1 data until durable, prevent older clients from silently overwriting the new model, retain personal encryption boundaries and bound tombstone growth without resurrecting offline copies. A naive union is unsafe. Acceptance must include two-device encrypted sync, same/different-note additions, edit/delete/purge races, late offline reconnect, resolve/reopen, account/key changes, invalid/full storage and import/export.

## Other unresolved observations

- Local usage accounting needs a defined scope (session, account lifetime or historical device usage), captured attribution for delayed provider completions, and transactional increments or per-writer records. Historical global totals cannot honestly be assigned to a specific account.
- Notification reconstruction loops over all notes on note changes, although signature verification is cached. Comment-indicator projection can scan blocks for each exact-range anchor. Broad Assistant context previews can re-extract plaintext on unrelated updates. These are source-backed performance leads; their user-visible cost has not been measured, and they were not patched speculatively.
- Browser timing, reverse-proxy behavior under load and real multi-device acceptance remain separate from deterministic unit/regression verification.
