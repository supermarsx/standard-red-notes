import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
  PublishedRemindersStore,
  PublishedRemindersStoreOptions,
  ReminderDeliveryClaim,
} from './PublishedRemindersStore'

const NOW = Date.parse('2026-06-25T12:00:00.000Z')
const DUE = '2026-06-25T11:00:00.000Z'
const OWNER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('PublishedRemindersStore', () => {
  let dir: string
  let filePath: string
  let claimSequence: number

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'srn-reminders-'))
    filePath = path.join(dir, 'published-reminders.json')
    claimSequence = 0
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const randomClaimId = (): string => `00000000-0000-4000-8000-${String(++claimSequence).padStart(12, '0')}`

  const makeStore = (options: PublishedRemindersStoreOptions = {}): PublishedRemindersStore =>
    new PublishedRemindersStore(filePath, {
      clock: () => NOW,
      randomId: randomClaimId,
      claimLeaseMs: 1_000,
      retryBaseMs: 100,
      retryMaxMs: 400,
      ...options,
    })

  const publish = (store: PublishedRemindersStore, userUuid = 'u1', id = 'r1'): Promise<unknown> =>
    store.publish(userUuid, { id, message: `message-${id}`, dueAtUtc: DUE })

  it('returns an empty list for a user with no published reminders (missing file)', async () => {
    const store = makeStore()
    expect(await store.listForUser('u1')).toEqual([])
    expect(await store.listAllUnsent()).toEqual([])
    expect(await store.claimDue(OWNER_A)).toEqual([])
  })

  it('publishes, normalizes timestamps, and reads back', async () => {
    const store = makeStore()
    const stored = await store.publish('u1', { id: 'r1', message: 'hi', dueAtUtc: DUE })
    expect(stored).toEqual(
      expect.objectContaining({
        id: 'r1',
        message: 'hi',
        deliveryRevision: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        ),
        sent: false,
        createdAt: NOW,
        updatedAt: NOW,
      }),
    )
    expect(await store.getForUser('u1', 'r1')).toEqual(stored)
  })

  it('loads the legacy JSON shape before optional attempt and claim fields existed', async () => {
    await fs.writeFile(
      filePath,
      JSON.stringify({
        u1: {
          r1: {
            id: 'r1',
            message: 'legacy',
            dueAtUtc: DUE,
            sent: false,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      }),
      'utf8',
    )

    const store = makeStore()
    const [legacy] = await store.listForUser('u1')
    expect(legacy).toEqual(expect.objectContaining({ id: 'r1', message: 'legacy' }))
    expect(legacy).not.toHaveProperty('attemptCount')
    const [claimed] = await store.claimDue(OWNER_A)
    expect(claimed.reminder).toEqual(expect.objectContaining({ id: 'r1', attemptCount: 1, lastAttemptAt: NOW }))
  })

  it('does not lose concurrent publishes from separate store instances', async () => {
    const first = makeStore()
    const second = makeStore()

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).publish(`user-${index}`, {
          id: `reminder-${index}`,
          message: `message-${index}`,
          dueAtUtc: DUE,
        }),
      ),
    )

    const all = await first.listAllUnsent()
    expect(all).toHaveLength(20)
    expect(new Set(all.map(({ userUuid }) => userUuid)).size).toBe(20)
  })

  it('atomically grants at most one live claim across store instances and keeps claim internals private', async () => {
    const first = makeStore()
    const second = makeStore()
    await publish(first)

    const claims = await Promise.all([first.claimDue(OWNER_A, NOW), second.claimDue(OWNER_B, NOW)])
    expect(claims.flat()).toHaveLength(1)
    expect(claims.flat()[0].claim).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        owner: expect.stringMatching(new RegExp(`^(${OWNER_A}|${OWNER_B})$`)),
        claimedAt: NOW,
        leaseExpiresAt: NOW + 1_000,
      }),
    )
    expect(claims.flat()[0].reminder).not.toHaveProperty('deliveryClaim')
    expect((await first.listForUser('u1'))[0]).not.toHaveProperty('deliveryClaim')
  })

  it('claims only due, retry-eligible reminders and bounds each batch', async () => {
    const store = makeStore({ claimBatchSize: 2 })
    await Promise.all([publish(store, 'u1', 'r1'), publish(store, 'u1', 'r2'), publish(store, 'u1', 'r3')])
    await store.publish('u1', {
      id: 'future',
      message: 'later',
      dueAtUtc: '2026-06-25T12:30:00.000Z',
    })

    const firstBatch = await store.claimDue(OWNER_A, NOW)
    expect(firstBatch.map(({ reminder }) => reminder.id)).toEqual(['r1', 'r2'])
    expect(await store.claimDue(OWNER_B, NOW)).toEqual([
      expect.objectContaining({ reminder: expect.objectContaining({ id: 'r3' }) }),
    ])
  })

  it('allows only the matching live claim to complete, and an expired claim cannot alter its successor', async () => {
    const store = makeStore()
    await publish(store)
    const [first] = await store.claimDue(OWNER_A, NOW)

    expect(await store.markClaimSucceeded('u1', 'r1', { ...first.claim, owner: OWNER_B }, NOW)).toBe(false)
    const [second] = await store.claimDue(OWNER_B, NOW + 1_000)
    expect(second.claim.owner).toBe(OWNER_B)
    expect(second.reminder.attemptCount).toBe(2)

    expect(await store.markClaimSucceeded('u1', 'r1', first.claim, NOW + 1_000)).toBe(false)
    expect(await store.scheduleClaimRetry('u1', 'r1', first.claim, 'stale failure', NOW + 1_000)).toBe(false)
    expect(await store.markClaimSucceeded('u1', 'r1', second.claim, NOW + 1_000)).toBe(true)

    const stored = await store.getForUser('u1', 'r1')
    expect(stored).toEqual(expect.objectContaining({ sent: true, sentAt: NOW + 1_000, attemptCount: 2 }))
    expect(stored).not.toHaveProperty('error')
  })

  it('persists bounded exponential retry backoff and truncates provider errors', async () => {
    const store = makeStore()
    await publish(store)

    const [first] = await store.claimDue(OWNER_A, NOW)
    expect(await store.scheduleClaimRetry('u1', 'r1', first.claim, 'x'.repeat(20_000), NOW)).toBe(true)
    expect(await store.getForUser('u1', 'r1')).toEqual(
      expect.objectContaining({
        sent: false,
        attemptCount: 1,
        lastAttemptAt: NOW,
        nextAttemptAt: NOW + 100,
        error: 'x'.repeat(16_384),
      }),
    )
    expect(await store.claimDue(OWNER_B, NOW + 99)).toEqual([])

    const [second] = await store.claimDue(OWNER_B, NOW + 100)
    expect(second.reminder.attemptCount).toBe(2)
    expect(await store.scheduleClaimRetry('u1', 'r1', second.claim, 'again', NOW + 100)).toBe(true)
    expect((await store.getForUser('u1', 'r1'))?.nextAttemptAt).toBe(NOW + 300)

    const [third] = await store.claimDue(OWNER_A, NOW + 300)
    expect(await store.scheduleClaimRetry('u1', 'r1', third.claim, 'again', NOW + 300)).toBe(true)
    expect((await store.getForUser('u1', 'r1'))?.nextAttemptAt).toBe(NOW + 700)

    const [fourth] = await store.claimDue(OWNER_B, NOW + 700)
    expect(await store.scheduleClaimRetry('u1', 'r1', fourth.claim, 'again', NOW + 700)).toBe(true)
    expect((await store.getForUser('u1', 'r1'))?.nextAttemptAt).toBe(NOW + 1_100)
  })

  it('documents crash-after-send recovery as at-least-once: no duplicate while live, but retry after expiry can duplicate', async () => {
    const store = makeStore()
    await publish(store)
    let providerSideEffects = 0

    const [first] = await store.claimDue(OWNER_A, NOW)
    providerSideEffects++
    // Simulate a process crash after the provider accepted the send but before
    // markClaimSucceeded persisted the result.
    expect(await store.claimDue(OWNER_B, NOW + 999)).toEqual([])

    const [recovered] = await store.claimDue(OWNER_B, NOW + 1_000)
    providerSideEffects++
    expect(recovered.reminder.attemptCount).toBe(2)
    expect(providerSideEffects).toBe(2)
    expect(await store.markClaimSucceeded('u1', 'r1', recovered.claim, NOW + 1_000)).toBe(true)
    expect(await store.markClaimSucceeded('u1', 'r1', first.claim, NOW + 1_000)).toBe(false)
  })

  it('preserves delivery state only when the complete delivery payload is unchanged', async () => {
    const store = makeStore()
    await publish(store)
    const [claim] = await store.claimDue(OWNER_A, NOW)
    await store.markClaimSucceeded('u1', 'r1', claim.claim, NOW)

    const same = await store.publish('u1', { id: 'r1', message: 'message-r1', dueAtUtc: DUE })
    expect(same).toEqual(expect.objectContaining({ sent: true, sentAt: NOW, attemptCount: 1 }))
  })

  it('rotates a publication revision across delivery edits and after explicit removal', async () => {
    const store = makeStore()
    const first = await store.publish('u1', { id: 'r1', message: 'first', dueAtUtc: DUE })
    const edited = await store.publish('u1', { id: 'r1', message: 'edited', dueAtUtc: DUE })
    expect(edited.deliveryRevision).not.toBe(first.deliveryRevision)

    await store.unpublish('u1', 'r1')
    const republished = await store.publish('u1', { id: 'r1', message: 'edited', dueAtUtc: DUE })
    expect(republished.deliveryRevision).not.toBe(edited.deliveryRevision)
  })

  it.each([
    ['message', { message: 'edited text' }],
    ['dueAtUtc', { dueAtUtc: '2026-06-26T11:00:00.000Z' }],
    ['channel', { channel: 'email' as const }],
    ['destination', { destination: 'new@example.test' }],
  ])('re-arms a sent occurrence when its %s changes', async (_field, change) => {
    const store = makeStore()
    const original = {
      id: 'r1',
      message: 'message-r1',
      dueAtUtc: DUE,
      channel: 'telegram' as const,
      destination: 'chat-1',
    }
    await store.publish('u1', original)
    const [claim] = await store.claimDue(OWNER_A, NOW)
    await store.markClaimSucceeded('u1', 'r1', claim.claim, NOW)

    const rearmed = await store.publish('u1', { ...original, ...change })
    expect(rearmed.sent).toBe(false)
    expect(rearmed).not.toHaveProperty('sentAt')
    expect(rearmed).not.toHaveProperty('attemptCount')
    expect(rearmed).not.toHaveProperty('lastAttemptAt')
    expect(rearmed).not.toHaveProperty('nextAttemptAt')
  })

  it('rejects an active-claim edit unless a durable cancellation fence permits invalidation', async () => {
    const store = makeStore()
    await store.publish('u1', {
      id: 'r1',
      message: 'original',
      dueAtUtc: DUE,
      channel: 'telegram',
      destination: 'chat-1',
    })
    const [stale] = await store.claimDue(OWNER_A, NOW)

    const replacement = {
      id: 'r1',
      message: 'edited',
      dueAtUtc: DUE,
      channel: 'telegram' as const,
      destination: 'chat-2',
    }
    await expect(store.publish('u1', replacement)).rejects.toThrow('already in flight')
    const edited = await store.publish('u1', replacement, { allowClaimInvalidation: true })
    expect(edited.sent).toBe(false)
    expect(edited).not.toHaveProperty('attemptCount')
    expect(await store.markClaimSucceeded('u1', 'r1', stale.claim, NOW)).toBe(false)
    expect(await store.scheduleClaimRetry('u1', 'r1', stale.claim, 'stale', NOW)).toBe(false)

    const [replacementClaim] = await store.claimDue(OWNER_B, NOW)
    expect(replacementClaim.reminder).toEqual(
      expect.objectContaining({ message: 'edited', destination: 'chat-2', attemptCount: 1 }),
    )
    expect(await store.markClaimSucceeded('u1', 'r1', replacementClaim.claim, NOW)).toBe(true)
  })

  it('unpublish removes the reminder and reports whether anything was removed', async () => {
    const store = makeStore()
    await publish(store)

    expect(await store.unpublish('u1', 'missing')).toBe(false)
    expect(await store.unpublish('u1', 'r1')).toBe(true)
    expect(await store.listForUser('u1')).toEqual([])
    expect(await store.unpublish('u1', 'r1')).toBe(false)
  })

  it('atomically refuses unsafe removals while allowing a durably fenced claim', async () => {
    const store = makeStore()
    await publish(store)
    await store.publish('u1', { id: 'r2', message: 'second', dueAtUtc: DUE })
    await store.claimDue(OWNER_A, NOW, 2)

    expect(await store.unpublishSafely('u1', 'r1')).toBe('in-flight')
    expect(await store.unpublishManySafely('u1', ['r1', 'r2'], ['r1'])).toBe('in-flight')
    expect(await store.clearForUserSafely('u1', ['r1'])).toBe('in-flight')
    expect(await store.clearForUserSafely('u1', ['r1', 'r2'])).toBe('removed')
    expect(await store.listForUser('u1')).toEqual([])
  })

  it('rejects malformed claim identities before they can mutate persisted state', async () => {
    const store = makeStore()
    await publish(store)
    const malformed = { id: 'not-a-uuid', owner: OWNER_A } as Pick<ReminderDeliveryClaim, 'id' | 'owner'>

    await expect(store.claimDue('not-a-uuid')).rejects.toThrow('claim owners must be UUIDs')
    expect(await store.markClaimSucceeded('u1', 'r1', malformed, NOW)).toBe(false)
    expect(await store.scheduleClaimRetry('u1', 'r1', malformed, 'bad', NOW)).toBe(false)
  })
})
