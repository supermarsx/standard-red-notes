import {
  getInviteRealtimeRevisionIdentity,
  InviteRealtimeEvent,
  isCanonicalRevision,
  isInviteRealtimeBatch,
  isOpaqueCursor,
} from './InviteRealtimeEvent'

const DEFAULT_MAX_SEEN_EVENT_IDS = 512
const MAX_RESOURCE_REVISIONS = 512
const REVISION_UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const MEMBERSHIP_REVISION_KEY_PATTERN = new RegExp(`^membership:${REVISION_UUID_PATTERN}$`, 'iu')
const APPLICATION_REVISION_KEYS = new Set([
  'application:items',
  'application:shared-vaults',
  'application:shared-vault-members',
  'application:files-metadata',
  'application:preferences',
  'application:account',
  'application:subscriptions',
])

export type InviteRealtimeResourceRevision = {
  key: string
  revision: string
}

export type InviteRealtimeCheckpoint = {
  cursor: string
  seenEventIds: string[]
  resourceRevisions?: InviteRealtimeResourceRevision[]
}

export interface InviteRealtimeCheckpointStore {
  read(sessionScope: string): Promise<InviteRealtimeCheckpoint | undefined>
  write(sessionScope: string, checkpoint: InviteRealtimeCheckpoint): Promise<void>
  clear(sessionScope: string): Promise<void>
}

export type InviteRealtimeHandlerContext = {
  readonly sessionScope: string
  readonly sessionEpoch: number
  readonly signal: AbortSignal
  isCurrent(): boolean
  assertCurrent(): void
}

export type InviteRealtimeConsumeResult =
  | { status: 'applied'; ackCursor: string; applied: number; duplicates: number; hasMore: boolean }
  | {
      status: 'reconcile'
      reason:
        'invalid-batch' | 'cursor-gap' | 'revision-gap' | 'handler-failed' | 'session-changed' | 'checkpoint-failed'
    }

export type InviteRealtimeRecoveryAction = 'snapshot' | 'retry' | 'disconnect' | 'discard'

/** HTTP snapshots are reserved for bootstrap and proven cursor/revision gaps. */
export function getInviteRealtimeRecoveryAction(
  result: Extract<InviteRealtimeConsumeResult, { status: 'reconcile' }>,
): InviteRealtimeRecoveryAction {
  switch (result.reason) {
    case 'cursor-gap':
    case 'revision-gap':
      return 'snapshot'
    case 'handler-failed':
    case 'checkpoint-failed':
      return 'retry'
    case 'invalid-batch':
      return 'disconnect'
    case 'session-changed':
      return 'discard'
  }
}

/**
 * Applies ordered invite invalidations and persists their cursor as one
 * checkpoint. Account scope is captured independently from the transport so a
 * late batch from a signed-out or replaced session cannot affect the new one.
 */
export class InviteRealtimeEventConsumer {
  private sessionScope?: string
  private sessionEpoch = 0
  private sessionAbortController?: AbortController
  private checkpoint?: InviteRealtimeCheckpoint
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly store: InviteRealtimeCheckpointStore,
    private readonly handler: (
      events: readonly InviteRealtimeEvent[],
      context: InviteRealtimeHandlerContext,
    ) => void | Promise<void>,
    private readonly maxSeenEventIds = DEFAULT_MAX_SEEN_EVENT_IDS,
  ) {
    if (!Number.isSafeInteger(maxSeenEventIds) || maxSeenEventIds < 1) {
      throw new Error('Invite realtime deduplication limit must be a positive safe integer.')
    }
  }

  async beginSession(sessionScope: string): Promise<InviteRealtimeCheckpoint | undefined> {
    assertSessionScope(sessionScope)
    this.sessionAbortController?.abort()
    const abortController = new AbortController()
    const epoch = ++this.sessionEpoch
    this.sessionScope = sessionScope
    this.sessionAbortController = abortController
    this.checkpoint = undefined

    const checkpoint = await this.store.read(sessionScope)
    if (this.sessionScope !== sessionScope || this.sessionEpoch !== epoch || abortController.signal.aborted) {
      return undefined
    }
    if (checkpoint && !isValidCheckpoint(checkpoint, this.maxSeenEventIds)) {
      await this.store.clear(sessionScope)
      return undefined
    }
    this.checkpoint = checkpoint
    return checkpoint ? cloneCheckpoint(checkpoint) : undefined
  }

  endSession(): void {
    this.sessionAbortController?.abort()
    this.sessionEpoch += 1
    this.sessionScope = undefined
    this.sessionAbortController = undefined
    this.checkpoint = undefined
  }

  getCursor(sessionScope: string): string | undefined {
    return this.sessionScope === sessionScope ? this.checkpoint?.cursor : undefined
  }

  /** Persist the server tail after first connect or an authoritative reload. */
  async resetAfterReconciliation(
    sessionScope: string,
    cursor: string,
    resourceRevisions: InviteRealtimeResourceRevision[] = [],
  ): Promise<void> {
    assertSessionScope(sessionScope)
    if (!isOpaqueCursor(cursor) || this.sessionScope !== sessionScope) {
      throw new Error('Invite realtime reconciliation belongs to a different or invalid session.')
    }
    const epoch = this.sessionEpoch
    if (!isValidResourceRevisions(resourceRevisions)) {
      throw new Error('Invite realtime reconciliation revisions are invalid.')
    }
    const checkpoint: InviteRealtimeCheckpoint = {
      cursor,
      seenEventIds: [],
      ...(resourceRevisions.length > 0 ? { resourceRevisions: cloneRevisions(resourceRevisions) } : {}),
    }
    await this.store.write(sessionScope, checkpoint)
    if (this.sessionScope !== sessionScope || this.sessionEpoch !== epoch) {
      return
    }
    this.checkpoint = checkpoint
  }

  consume(sessionScope: string, value: unknown): Promise<InviteRealtimeConsumeResult> {
    const operation = this.queue.then(() => this.consumeSerially(sessionScope, value))
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    )
    return operation
  }

  private async consumeSerially(sessionScope: string, value: unknown): Promise<InviteRealtimeConsumeResult> {
    if (this.sessionScope !== sessionScope) {
      return { status: 'reconcile', reason: 'session-changed' }
    }
    if (!isInviteRealtimeBatch(value)) {
      return { status: 'reconcile', reason: 'invalid-batch' }
    }

    const epoch = this.sessionEpoch
    const abortController = this.sessionAbortController
    if (!abortController) {
      return { status: 'reconcile', reason: 'session-changed' }
    }
    const context: InviteRealtimeHandlerContext = {
      sessionScope,
      sessionEpoch: epoch,
      signal: abortController.signal,
      isCurrent: () =>
        this.sessionScope === sessionScope &&
        this.sessionEpoch === epoch &&
        this.sessionAbortController === abortController &&
        !abortController.signal.aborted,
      assertCurrent: () => {
        if (
          this.sessionScope !== sessionScope ||
          this.sessionEpoch !== epoch ||
          this.sessionAbortController !== abortController ||
          abortController.signal.aborted
        ) {
          throw new InviteRealtimeSessionChangedError()
        }
      },
    }
    const current = this.checkpoint
    if (!current || value.previousCursor !== current.cursor) {
      if (current && isExactPreviouslyAppliedReplay(value, current)) {
        return {
          status: 'applied',
          ackCursor: current.cursor,
          applied: 0,
          duplicates: value.events.length,
          hasMore: value.hasMore,
        }
      }
      return { status: 'reconcile', reason: 'cursor-gap' }
    }

    const seen = new Set(current.seenEventIds)
    const revisions = new Map((current.resourceRevisions ?? []).map(({ key, revision }) => [key, revision]))
    const pending: InviteRealtimeEvent[] = []
    let duplicates = 0
    for (const event of value.events) {
      if (seen.has(event.eventId)) {
        duplicates += 1
        continue
      }
      seen.add(event.eventId)

      const revisionIdentity = getInviteRealtimeRevisionIdentity(event)
      if (revisionIdentity) {
        const priorRevision = revisions.get(revisionIdentity.key)
        if (priorRevision !== undefined) {
          const comparison = compareRevisions(revisionIdentity.revision, priorRevision)
          if (comparison <= 0) {
            duplicates += 1
            continue
          }
          if (BigInt(revisionIdentity.revision) !== BigInt(priorRevision) + BigInt(1)) {
            return { status: 'reconcile', reason: 'revision-gap' }
          }
        }
        revisions.delete(revisionIdentity.key)
        revisions.set(revisionIdentity.key, revisionIdentity.revision)
      }
      pending.push(event)
    }
    const applied = pending.length
    try {
      if (pending.length > 0) {
        context.assertCurrent()
        await this.handler(pending, context)
        context.assertCurrent()
      }
    } catch (error) {
      if (error instanceof InviteRealtimeSessionChangedError || !context.isCurrent()) {
        return { status: 'reconcile', reason: 'session-changed' }
      }
      return { status: 'reconcile', reason: 'handler-failed' }
    }

    if (this.sessionScope !== sessionScope || this.sessionEpoch !== epoch) {
      return { status: 'reconcile', reason: 'session-changed' }
    }

    const next: InviteRealtimeCheckpoint = {
      cursor: value.nextCursor,
      seenEventIds: [...seen].slice(-this.maxSeenEventIds),
      ...(revisions.size > 0
        ? {
            resourceRevisions: [...revisions]
              .slice(-MAX_RESOURCE_REVISIONS)
              .map(([key, revision]) => ({ key, revision })),
          }
        : {}),
    }
    try {
      await this.store.write(sessionScope, next)
    } catch {
      return { status: 'reconcile', reason: 'checkpoint-failed' }
    }
    if (this.sessionScope !== sessionScope || this.sessionEpoch !== epoch) {
      return { status: 'reconcile', reason: 'session-changed' }
    }

    this.checkpoint = next
    return { status: 'applied', ackCursor: next.cursor, applied, duplicates, hasMore: value.hasMore }
  }
}

class InviteRealtimeSessionChangedError extends Error {
  constructor() {
    super('Invite realtime session changed during event application.')
    this.name = 'InviteRealtimeSessionChangedError'
  }
}

function assertSessionScope(value: string): void {
  if (value.length === 0 || value.length > 512) {
    throw new Error('Invite realtime session scope is invalid.')
  }
}

function isValidCheckpoint(value: InviteRealtimeCheckpoint, maxSeenEventIds: number): boolean {
  return (
    isOpaqueCursor(value.cursor) &&
    Array.isArray(value.seenEventIds) &&
    value.seenEventIds.length <= maxSeenEventIds &&
    value.seenEventIds.every((eventId) => typeof eventId === 'string' && eventId.length <= 128) &&
    new Set(value.seenEventIds).size === value.seenEventIds.length &&
    (value.resourceRevisions === undefined || isValidResourceRevisions(value.resourceRevisions))
  )
}

function cloneCheckpoint(value: InviteRealtimeCheckpoint): InviteRealtimeCheckpoint {
  return {
    cursor: value.cursor,
    seenEventIds: [...value.seenEventIds],
    ...(value.resourceRevisions ? { resourceRevisions: cloneRevisions(value.resourceRevisions) } : {}),
  }
}

function isValidResourceRevisions(value: InviteRealtimeResourceRevision[]): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_RESOURCE_REVISIONS &&
    value.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof entry.key === 'string' &&
        (MEMBERSHIP_REVISION_KEY_PATTERN.test(entry.key) || APPLICATION_REVISION_KEYS.has(entry.key)) &&
        isCanonicalRevision(entry.revision),
    ) &&
    new Set(value.map((entry) => entry.key)).size === value.length
  )
}

function cloneRevisions(value: InviteRealtimeResourceRevision[]): InviteRealtimeResourceRevision[] {
  return value.map(({ key, revision }) => ({ key, revision }))
}

function compareRevisions(left: string, right: string): number {
  const leftValue = BigInt(left)
  const rightValue = BigInt(right)
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0
}

/**
 * A socket can reconnect after the authoritative handler and checkpoint have
 * completed but before the ACK reaches the gateway. In that narrow window the
 * server correctly replays the outstanding batch from its previous cursor.
 * Accept only the exact immediately-checkpointed batch: every event identity
 * must still be in the bounded deduplication window and its next cursor must be
 * the durable cursor. Older or partially-overlapping replays remain gaps.
 */
function isExactPreviouslyAppliedReplay(
  batch: {
    events: readonly InviteRealtimeEvent[]
    nextCursor: string
  },
  checkpoint: InviteRealtimeCheckpoint,
): boolean {
  if (batch.events.length === 0 || batch.nextCursor !== checkpoint.cursor) {
    return false
  }
  const seen = new Set(checkpoint.seenEventIds)
  return batch.events.every((event) => seen.has(event.eventId))
}
