---
layout: default
title: Concurrency and performance audit — 16–17 October 2026
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
| F07 | High         | Concurrent private-comment preference snapshots overwrite additions, discard concurrent comments during purge, or resurrect purged comments.                                                                 | Repaired in the 19 October follow-up below; live multi-device acceptance remains unverified.                                                                |
| F08 | High         | Old Redis lease refresh fails after a replacement editor is admitted and denies/releases the replacement room.                                                                                               | Fixed: deterministic policy failures apply only to the exact still-current lease. Real Redis failures still invalidate the relay. |
| F09 | Medium / Low | Delayed footer usage response crosses an account/key boundary. Separately, local counters use a global last-writer-wins storage key despite a session label.                                                 | Footer response race fixed; account-scoped page counters repaired in the 19 October follow-up. These counters do not enforce server limits.        |
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

## Original private-comment data-loss finding

At the original audit baseline, all private comment threads shared one personal UserPrefs field. Local mutation queues serialize only one WebApplication instance. The generic singleton conflict strategy keeps one preference snapshot without a duplicate or per-comment reconciliation. Sockets do not change this conflict policy.

Read-only reproduction using current source and synthetic payloads:

```sh
node scripts/audit-private-comment-concurrency.cjs
```

The updated probe keeps the original singleton failures as historical controls and
also verifies the repaired operation merge. The probe demonstrates concurrent cross-note addition loss, stale-edit resurrection after remote purge, and purge discarding a concurrent addition. It touches no user data and contacts no server.

A safe repair needs stable comment IDs, deterministic operation stamps, retained deletion tombstones, resolve/reopen ordering and purge watermarks. Migration must preserve version-1 data until durable, prevent older clients from silently overwriting the new model, retain personal encryption boundaries and bound tombstone growth without resurrecting offline copies. A naive union is unsafe. Acceptance must include two-device encrypted sync, same/different-note additions, edit/delete/purge races, late offline reconnect, resolve/reopen, account/key changes, invalid/full storage and import/export.

## Other unresolved observations

- At this baseline, local usage accounting needed a defined scope (session, account lifetime or historical device usage), captured attribution for delayed provider completions, and transactional increments or per-writer records. Historical global totals cannot honestly be assigned to a specific account.
- Notification reconstruction loops over all notes on note changes, although signature verification is cached. Broad Assistant context previews can re-extract plaintext on unrelated updates. These are source-backed performance leads; their user-visible cost has not been measured. The comment-indicator block scan was subsequently reproduced and fixed in F16 below.
- Browser timing, reverse-proxy behavior under load and real multi-device acceptance remain separate from deterministic unit/regression verification.

## Static-analysis follow-up — 17 October

Follow-up baseline: `017cd4b0`. This pass traced asynchronous continuations and repeated full-document work, then used deterministic regressions to distinguish reproducible defects from source-backed leads. It is not a proof that all races or performance problems have been found.

| ID  | Priority | Trigger and impact                                                                                                                                                                                                | Disposition                                                                                                                                                                                                                              |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F12 | High     | A reconnect during socket-command digest preparation creates two journal identities for one active save. Shutdown or revocation during the digest can append a late command record.                               | Fixed: serialize preparation and fence continuations against active request, socket generation and shutdown. A record persisted before disconnect retains its identity and recovers through STATUS rather than creating another command. |
| F13 | Medium   | Idle search indexing treats requestIdleCallback's timeout as a minimum delay. An idle browser immediately repeats full rebuilds; old completions also re-arm after disposal or duplicate a replacement scheduler. | Fixed: explicit five-minute cooldown, separate idle/timer cancellation, scheduler-generation checks and disposal fencing. Default on-change indexing is unaffected.                                                                      |
| F14 | Medium   | Failed external reminder deletion restores an old complete list over reminders added or edited during the request.                                                                                                | Fixed: merge failed originals into the latest authorized note while preserving existing IDs, with account/key/access/deletion checks. Absence still cannot distinguish intentional concurrent deletion without reminder tombstones.      |
| F15 | Medium   | Duplicate imported checklist IDs are rejected when capturing a comment target but silently pick one item when displaying an existing marker or navigating to it.                                                  | Fixed: fail closed for ambiguous task IDs across markers and sidebar targets.                                                                                                                                                            |
| F16 | Medium   | Each exact-range comment scans every block and repeatedly writes the same DOM marker for overlapping ranges.                                                                                                      | Fixed: validate quotes against the current state, merge overlapping intervals and sweep ordered block projections once; mark each DOM element once.                                                                                      |
| F17 | Medium   | Moving a note between vaults leaves the previous vault's mention suggestions visible while the new roster loads or fails.                                                                                         | Fixed: bind results to note/vault/key and session identity, suppress mismatched results immediately and catch failed/empty roster responses.                                                                                             |
| F18 | Medium   | A delayed search-worker snapshot overwrites edits/removals or refills a purged index. Older callbacks can also tear down a replacement worker.                                                                    | Fixed: latest-build ownership, coalesced incremental replay, flush/kill/destroy invalidation and exact-worker fencing. Failed postMessage calls clear pending timers.                                                                    |

For F13, an immediate-idle scheduler produced eleven rebuilds without advancing time where only the initial build was expected. Separate tests reproduced post-disposal rearming and duplicate callbacks after a mode change. The fixed suite also covers queued stale callbacks after stop/restart and environments without requestIdleCallback.

For F14, two regressions demonstrated loss of a concurrent addition and replacement of a concurrent edit. Recovery now preserves both; six additional tests reject restoration after removal, locking, trashing, read-only transition, account change or key/session invalidation. External cleanup still uses its captured client. Full deletion-intent reconciliation remains open.

For F12, six new regressions cover reconnect during digest, shutdown/revocation during digest, receipt recovery using the original persisted command, and shutdown/revocation during an already-started journal write. Revocation waits for that write before quarantine and acknowledgement. Teardown does not wait for an unfinished digest; the existing main-thread forced-shutdown grace remains bounded.

For F16, the baseline fixture measured 32,080 interval-property reads for 400 blocks and 80 matching comments. Tests now bound that work to 1,760 reads, verify one projection and DOM write per target, and preserve quote/signature checks, spread/overlapping anchors and touching ranges around empty blocks. This is an operation-count regression, not a browser timing measurement.

For F17, the same-note vault-move regression failed on the baseline. Four tests cover pending/failed replacement roster, replacement session with the same user UUID and key-system change. For F18, four baseline regressions reproduced stale edit/removal adoption and refill after flush/kill/destroy; four additional cases cover newest-build ordering, old-worker callbacks, fallback replay and configure-post failure.

Additional source-backed storage lead: the concurrent sync outbox reads all lease records and uses repeated owner lookup while finding the oldest pending command. Unclean tab lifecycles can retain expired lease records. This needs a scaled IndexedDB fixture and safe cleanup/claim design before changing recovery semantics; no measured browser impact or fix is claimed.

Additional comment-rendering lead: unchanged shared comments can be signature-verified again when parent renders and observer reads overlap. Any cache must retain trust/principal invalidation and current authorization checks; no global plaintext cache was introduced.

Search-scope follow-up: changing the indexing scope while a rebuild is already running currently skips the runner's additional rebuild request. The controller setter does not itself rebuild. This needs an in-flight scope-change regression and a coalesced latest-scope rebuild; the scheduler and worker-adoption fixes above do not claim to repair that separate path.

Follow-up local validation: 835 distinct web tests across 41 suites passed (the two combined runs contained 647 and 203 tests, with the 15-test scheduler suite in both), plus 34 runtime-security checks. Final web TypeScript, scoped production/test lint, diff, documentation, compatibility and safe-logging checks passed. No server code changed in this follow-up, so the earlier gateway coverage run was not repeated. No live browser performance profile or multi-device acceptance was performed.

## Assistant history and Firefox profile

The subsequent Assistant follow-up reproduced four additional failures: a new synced draft reading obsolete local history; canonical save acknowledgement removing the live streaming flag and tool state; a transient initial checkpoint failure preventing the provider call; and persistent save failure leaving an empty generating bubble under a misleading read-error banner. Fixes separate read/write failures, preserve live message state, retry pre-provider storage once and explicitly report an unsent message if durability still fails. They never replay a provider request or overwrite a known unreadable saved history.

Tab closing now uses current visibility/focus, so batched closes finish at one fresh chat. History supports selection, select-all, confirmed bulk deletion and individual rename/delete. Confirmation and deletion completion are fenced across account/workspace changes, and delayed deletion respects focus and closed-tab choices made while storage was pending.

The user supplied a local Firefox recording after the earlier static pass. Analysis stayed local and did not upload the profile or retain its page contents. The recording spans approximately 40.75 seconds and includes a reload. Its app main thread consumed approximately 18.04 CPU seconds, with approximately 81.13 aggregate CPU seconds across worker records. There are 84 historical worker records, but only 42 observed concurrent DOM workers: old-window workers exit before the replacement pool expands. This is not evidence of 84 simultaneously leaked workers.

CPU-weighted stack attribution estimates approximately 9.03 seconds JavaScript, 2.81 seconds GC/CC, 1.25 seconds DOM, 0.54 seconds layout and 1.05 seconds graphics on the main thread. Profiler overhead itself is substantial, approximately 1.28 seconds. Inclusive `decryptSplit` accounts for approximately 1.94 CPU seconds; its repeated payload lookup callback accounts for approximately 0.75 seconds. Source inspection confirms a linear split search inside the per-result packaging loop, making bulk packaging quadratic. Later overlapping minified React stacks remain significant. These inclusive estimates must not be added together.

The profile strips script URLs/source contents and includes startup, so it does not isolate steady-state Assistant replies or identify the exact component behind every React stack. The streaming-state regression is independently proven by the live checkpoint/hydration unit path, not by an exact component name in this profile. No post-fix Firefox timing improvement is claimed without a new capture.

The profiled payload lookup is now indexed once per encryption/decryption batch. Deterministic 1,000/2,000-item fixtures previously read UUIDs approximately 0.5/2 million times; the new tests bound this to at most four reads per item. They preserve the six split-group priorities, first duplicate wins, missing-original exceptions and failed-decryption ciphertext/metadata. Exported split helpers remain unchanged.

Automatic decryption concurrency now uses at most eight workers per application, leaving browser/editor headroom on high-core devices. Small loads still start with at most two, and explicit positive worker limits retain their existing hardware bound, including forty workers on a forty-logical-core device. This bounds default WASM-runtime startup without removing the user's explicit throughput setting.

Final validation for this Assistant/profile follow-up: 868 web tests across 93 suites and 29 encryption tests across four suites passed. Web/services TypeScript and scoped lint passed, along with documentation, safe-logging, compatibility and diff checks. The history lifecycle regressions include cancellation/account changes during bulk confirmation and focus/closed-tab changes during delayed deletion. The original Firefox capture remains a pre-fix recording; deploy the new build before evaluating the user-visible improvement.

## Collaboration responder recovery

The subsequent `encrypted-yjs-no-responder` and `encrypted-yjs-correlated-state-timeout` investigation reproduced three independent failures. An abandoned editor could retain a pending bootstrap reservation while authorization was unresolved. A retained document accepted after reconnect could be discarded when an optional peer merge received no response. Finally, bootstrap election counted logical editor leases, while relay delivery and responder lookup excluded their entire shared socket, preventing sibling editors from exchanging state.

Pending reservations now cancel on editor invalidation/unmount, including delayed authorization and canonical-sync completion. Accepted retained documents remain ready when optional peer merges exhaust their bounded retries. Gateway routing includes the originating socket only when it has multiple live editor leases; response grants, rate limits and backpressure remain enforced. Comment-only, pending, expired and released leases do not enable that delivery.

Encrypted fan-out required a corresponding replay correction. Each live cipher now consumes a broadcast once through its own receive window, while app-lifetime history fences later remounts, including decrypts already in flight. Failed authentication does not permanently poison pending sequences. The provider ignores its own echoed envelope, including chunked transfers; foreign room epochs and repeated peer frames retain their rejection behavior. These cases are exercised with real encrypted frames, not only an identity transport fixture.

These are source-level reproductions and local regression checks. The supplied console lines alone do not identify which path occurred in the deployment. Both the app and gateway must be deployed before testing shared-socket recovery; a connected account sync lane alone does not prove collaboration state readiness.

A fourth recovery regression covers two empty followers after the original seeder disappears. Keeping both leases active prevented a fresh bootstrap election. A nonbootstrap follower that has already waited a full response window now voluntarily yields its empty lease when another editor requests state, remaining absent for the peer's next timeout before retrying. This does not elect a client locally: the normal server reservation and canonical revision checks still decide who can seed. Retained, seeded and establishing documents never take this path. Fake-time tests recover the pair within 25 seconds and cancel a pending retry on destruction; that is a bounded recovery fixture, not an instantaneous or production timing guarantee.

Validation: 418 collaboration web tests and 982 gateway tests passed, with one optional test skipped in each run. All 34 runtime-security checks passed. Web/gateway TypeScript, scoped lint, documentation, safe-logging and compatibility checks passed. Regression coverage includes encrypted single-frame and chunked state transfer, both-direction edits, awareness, grant enforcement, absent/expired leases, replay/remount races, and cancelled pending reservations. Local validation does not establish the deployed multi-device result.

## Evening Firefox profile

The 17 October 19:53 capture was inspected locally without uploading its contents. Its app main thread consumed approximately 16.44 CPU seconds during a 38.65-second window, with a maximum sampled event delay of 907 ms. Approximate category attribution includes 7.68 seconds JavaScript and 3.79 seconds garbage collection/cycle collection. The recording also contains 27,539 timer callbacks and 35,230 IndexedDB success callbacks. These counts describe the capture, not independent user-visible stalls.

Two source-backed improvements follow from this capture:

- Chat catalog parsing accounts for roughly 0.74 inclusive CPU seconds. Sync acknowledgements reconstruct payload content even when only metadata changes, defeating the existing reference cache. An exact bounded serialized-content comparison now reuses the validated transcript and merged catalog for identical replacement content. Ten replacement acknowledgements perform zero transcript sanitizations in the regression fixture. Different content with unchanged revision counters still invalidates the cache, and authorization is checked before reuse. One serialization comparison remains necessary when content identity changes; retained fingerprints have a 16 MiB aggregate UTF-16 budget per store and are omitted for invalid records. Reads above that optional cache budget still work normally.
- Payload and item constructors each schedule a separate zero-delay timer for deferred deep freezing. The profile contains timer scheduling beneath payload creation/decryption, making this a concrete source of callback overhead during bulk loading. A shared queue now yields after at most 128 roots or a 4 ms budget checked between roots. A 5,000-note fixture drops from 10,000 callbacks to 79, preserving subclass construction, nested immutability and observable errors without stranding subsequent work. One large recursive freeze remains atomic; the budget is not a hard limit on that individual operation.

The renderer consumed a further 12.39 CPU seconds, largely in software rasterization, texture filtering and copying. This is CPU work in the GPU process, not measured GPU execution time. The profile does not reliably identify which app element drives those repaints. An external theme extension is visible but contributes only about 0.24 seconds of direct inclusive main-thread work; this does not establish it as the main cause. Getter names in minified React/encryption stacks do not reliably identify a component hotspot and were not used to justify speculative rewrites.

IndexedDB callback dispatch accounts for approximately 0.74 inclusive CPU seconds, including roughly 0.18 seconds under keyed payload reads. The metadata cursor followed by bounded payload reads explains many callbacks; replacing this with an unbounded full-database read would risk excessive memory usage. No such change was made. Inclusive measurements overlap and must not be added together. Script URLs were recoverable from this profile, but embedded source text was absent and retrieval of the exact deployed bundle returned HTTP 502. These are profile-guided source fixes and deterministic regressions, not a post-deployment browser speedup measurement.

Validation: 892 web tests across 94 Assistant/database-related suites and 341 model tests across 38 suites passed. Another 55 focused web integration tests passed against the rebuilt model package, and all 28 chat-store tests passed after the aggregate cache-budget refinement. The model coverage gate, TypeScript and scoped lint passed; the scheduler received an independent review. Documentation, compatibility, safe-logging and diff checks passed. These operation-count tests do not measure deployed Firefox frame times.

### Chat save failure observability

A subsequent report showed repeated unsent prompts behind a generic encrypted-history save warning, with no diagnostic evidence. The explicit flush caught and discarded the exception, while scheduled shared checkpoints could reject without updating the visible warning. The normal payload/item mutation fixture accepts a new chat and a follow-up prompt; the supplied warning alone does not establish a schema, disk, ownership or sync root cause.

Save failures now carry closed diagnostic codes and stages, with fixed user-facing explanations rather than arbitrary exception messages. The Assistant warning and console expose the same safe classification, and current-tab capability diagnostics include failure/recovery state. No transcript, prompt, title, credential, raw stack or exception message is exported. Recovery must belong to the same conversation; an unrelated successful chat cannot clear another conversation's failure.

A separate readiness race was identified: a shared store becoming unready before the initial checkpoint could make a skipped write look successful. Required sends must fail explicitly in that state. This is a save-safety defect, not proof of the cause of the reported repeated rejection. General account sync returning successfully also does not, by itself, prove remote acknowledgement: manual sync and client-lock paths can return without uploading. No remote-durability guarantee is inferred from that return value.

Validation for chat-save observability: 277 focused tests passed, with the two final report export/privacy regressions rerun separately. Web TypeScript, scoped lint, compatibility, safe-logging and documentation checks passed. Independent review covered account/view isolation, remount recovery, remaining active failures and readiness admission. The deployed rejection still requires its new diagnostic code/stage to establish the underlying cause.

The storage follow-up separates recoverable Trash from permanent deletion. Trashing retains encrypted messages and continues consuming physical storage, but trashed and permanently deleted groups do not consume the active chat allowance. Restoring changes the chat lifecycle without copying its transcript and checks the projected active allowance first. Permanent deletion removes transcript records and keeps a small content-free deletion marker so a late offline checkpoint cannot resurrect the chat. A deletion interrupted after writing its marker must remain retryable: treating the marker as proof that all message records were removed leaves hidden storage behind.

Storage accounting distinguishes active chats, trashed chats, writer records, lifecycle records, deletion markers and rejected records. The active chat budget is measured in serialized UTF-16 code units, not physical disk bytes or the number of notes in the account. Retained totals, Trash and deleted remnants are reported separately. Browser storage quota errors remain a separate failure category. Admission uses the proposed replacement size, allowing space-reducing updates even when an existing active catalog exceeds its limit.

Trash expires after 30 days. Cleanup runs when the authenticated Assistant workspace opens, hourly while it remains mounted, and when it returns to the foreground after the interval. Each pass handles up to 25 chats with one sync; it cannot run while all clients are closed. Automatic deletion requires an acknowledged lifecycle record and uses the later of its client and server timestamps, so an unsynced action or an old client clock cannot prematurely expire fresh Trash. Eligibility is checked again in the serialized purge operation so a locally observed restore or renewed Trash action cancels obsolete cleanup. Active chats never expire. Content-free permanent-deletion markers remain outside the active budget to fence late offline copies.

Default active capacity is now 1,000 chats, 8,192 writer records and 256 Mi serialized UTF-16 code units for the normalized active catalog (previously 100, 512 and 16 Mi respectively). The separate fingerprint cache remains bounded at 16 MiB; per-record and per-chat writer limits are unchanged. These are admission ceilings, not evidence of acceptable browser performance at maximum occupancy. Older clients that predate the Trash lifecycle can still display trashed conversations until refreshed, but their ordinary saves cannot clear the lifecycle state on updated clients. Permanent-deletion markers retain their existing precedence. The provided deployment summary did not contain the failing checkpoint's code or stage, so these fixes do not establish the cause of that particular unsent prompt.

Validation for storage recovery: 1,152 tests across 97 Assistant and diagnostics suites passed, including the increased default limits. Web TypeScript, scoped lint, documentation, compatibility and safe-logging checks passed. Coverage includes interrupted purge retries, stale writer records, restore/purge ordering, projected budget growth and shrinkage, account changes during confirmation, and privacy-safe summary exports. Browser visual and cross-device deployment acceptance remain unverified.

Validation for automatic retention and inactive-budget exemptions: 1,160 tests across 97 Assistant and diagnostics suites passed. Web TypeScript, scoped lint, safe-logging and compatibility checks passed. New coverage includes acknowledged expiry timestamps, queued restore/re-trash races, bounded single-sync maintenance, inactive budget exclusions, restore admission, cached transcript size reuse, and account-safe hourly/foreground maintenance. No deployed browser or cross-device acceptance is claimed.

Editor startup investigation found an avoidable empty first render: NoteGroupView initialized its mirrored controller/view-tab state to empty and filled it only after mount, exposing the grid's border-colour background. Its initial state now comes from the current application snapshot; border backgrounds are reserved for actual split separators. First-note preparation has an explicit loading state, while note switches retain the outgoing editor. Super editor code loading overlaps controller preparation through a shared import promise; failed speculative loads can retry at render. This changes loading order and feedback without bypassing note hydration, authorization or outgoing-save fences. Deployed first-paint timing still requires a browser capture.

Startup validation: 223 tests across 17 controller, note-group, workspace, lazy-load and collaboration-surface suites passed. Web TypeScript and scoped production lint passed. Tests cover initial rendering before subscriptions, pending-open completion/failure, retained editor identity, import deduplication/retry and observer isolation.

The Assistant permissions selector exposed a separate lost-update race: mode and legacy confirmation settings were written concurrently into the same immutable UserPrefs snapshot. Preference mutations now serialize and read the latest preferences before writing, recover after a rejected write, and fence singleton replacement/teardown. The selector shows a pending choice without granting unpersisted permissions, then verifies readback and reports a save failure. Chat-mode explanations use tooltips rather than permanent subtext.

Combined editor/Assistant validation: 1,387 tests across 115 web suites passed, plus 23 preferences-service tests. SNJS production bundle and declarations rebuilt successfully; web TypeScript, scoped lint, formatting, compatibility and documentation checks passed. No deployed Firefox timing or visual acceptance is claimed.

Assistant composer synchronization now carries unsent text, supported attachments, context selection and per-chat tool permissions through the account's encrypted item sync. Conversation mode continues using its existing synced metadata. Anonymous drafts remain local. Current-note context still resolves the current editor at send time; explicit note collections and selected-text excerpts retain their existing authorization boundaries.

Composer fields merge independently. Pending local edits survive incoming snapshots and failed writes; canonical equal-clock winners converge deterministically. Writes debounce for 400 ms with a two-second maximum wait while typing, and flush on send or page suspension. Failed writes show a retry action and retry on reconnect or foregrounding. Account/key changes clear the mounted composer and fence stale hydration. Incoming permission changes cannot relax an active run's policy; queued requests retain their selected context scope. Draft synchronization does not itself submit a prompt or call the AI provider.

Each writer keeps composer state in a separate, stable encrypted record with no transcript entries, so typing does not rewrite the conversation's message payload. This record consumes one additional slot within the existing per-chat writer limit. Tests cover separate-field merges, stable equal-clock tie-breaking, draft clears, lifecycle restrictions, attachment recovery, offline retry, account boundaries and active-run permission isolation. Deployed multi-device acceptance remains unverified.

Composer validation: 154 tests across 13 chat storage, composer lifecycle, Assistant view and conversation integration suites passed. Scoped production lint and formatting checks passed.


## Remaining-issue repairs — 19 October 2026

Baseline: `a66d4fb9`, after the socket reliability repairs. This pass followed the
remaining Assistant, editor/comments, email/queue and deployment findings. It is
not an exhaustive proof that the app has no remaining races.

- **F07 private comments:** immutable account-encrypted operation records replace
  singleton writes. Logical clocks and stable event identities resolve concurrent
  edits; deletion markers defeat stale edits and purge preserves unseen additions.
  Legacy preferences remain a recovery backup and are never cleared by migration.
  Acknowledged compaction preserves the frontier before deleting unchanged source
  records. Read failures surface in the comments panel. Server validation refuses
  shared-vault/key-system associations for this personal content type. Historical
  losses cannot be recovered; older tabs need to refresh. Legacy backup text is not
  securely erased by a new-format purge.
- **F09 usage:** local counters now explicitly mean this page and account. Providers
  capture the account's accumulator, so delayed completions cannot update another
  account's counter. Origin-global historical totals are not falsely attributed or
  migrated. Server rolling windows remain authoritative across devices. Throwing
  subscribers cannot interrupt a successful provider reply.
- **Slow Assistant saves:** periodic checkpoints no longer accumulate an unbounded
  promise chain of full-transcript writes while encrypted persistence is slow.
  One write runs at a time with a coalesced trailing update; explicit flush awaits
  the drain and failed saves remain retryable.
- **Notification work:** initial reconstruction still scans notes; later item events
  project only changed/inserted notes and remove deleted ones. Trust, account,
  protection-session and vault-lock changes invalidate the projection. This avoids
  an account-wide scan on every edit while clearing cached titles when access ends.
- **Last edited badge:** equivalent contact model refreshes no longer force another
  synchronous layout measurement. Actual attribution/name changes still remeasure.
- **Email readiness:** capacity rejection retains the heartbeat so safe capacity
  recovery is recognized. Startup is claimed before awaits, shutdown invalidates
  pending readiness work, and concurrent stops share the drain. Failure logs expose
  a closed stage without leaking exception messages. The shared fleet readiness
  marker intentionally expires within 12 seconds rather than being deleted when
  one instance stops. Missing relay configuration still correctly denies delivery.
- **Queue diagnostics:** an unhandled event can result from unfiltered topic fan-out;
  the warning no longer asserts that the worker necessarily has a wrong queue URL.
  The warning change does not change message handling or bypass delivery durability checks.
- **Deployment:** rolling-web validates candidate health and private reachability
  before interrupting backend services. Backend updates still have downtime; this
  change does not introduce backend replication. Server artifacts receive ownership
  during Docker COPY rather than a recursive rewrite of the entire dependency tree.
  No measured build-time reduction is claimed.

Static review and existing tests confirmed contextual Checklist gating, Review
controls, labeled Insert lists and sidebar resizing/collapse are already present.
External LightsOut theme contrast was not visually verified. No deployed Firefox
speedup or production sleep/resume acceptance is claimed.

Local Docker started successfully, but live email verification could not pull Redis:
Docker's registry lookup failed with `lookup registry-1.docker.io: no such host`.
Compose configuration and simulated rollout checks do not substitute for a live
container deployment. No production deployment was performed.

Validation for this pass: the combined web cohort passed 230 tests across 15 suites.
Final private-comment consumer checks additionally passed 13 Assistant-tool tests
and the editor observer regression; model/server content-type and isolation checks
passed 8 and 34 tests respectively. Email cohorts passed 59 gateway, 81 auth and
11 queue tests. Deployment/cache/hardening contracts passed 93 tests with one
platform-specific skip; 34 web runtime-security checks passed. These cohorts
overlap with focused runs and are not an additive coverage total. Web TypeScript,
scoped lint, model/SDK builds, safe-logging and documentation checks passed.
