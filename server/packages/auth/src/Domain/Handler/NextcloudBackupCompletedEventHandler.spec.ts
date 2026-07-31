import 'reflect-metadata'

import { DomainEventService, NextcloudBackupCompletedEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'
import { Logger } from 'winston'

import {
  NEXTCLOUD_BACKUP_INITIAL_RETRY_DELAY_MS,
  NextcloudBackupDeliveryState,
  emptyNextcloudBackupDeliveryState,
} from '../Setting/NextcloudBackupDeliveryState'
import { NextcloudBackupStateStore } from '../Setting/NextcloudBackupStateStore'
import { NextcloudBackupCompletedEventHandler } from './NextcloudBackupCompletedEventHandler'

describe('NextcloudBackupCompletedEventHandler', () => {
  const userUuid = '00000000-0000-0000-0000-000000000001'
  const requestUuid = '00000000-0000-0000-0000-000000000002'
  const nowMs = 1_700_000_000_000
  const completedAt = nowMs - 1_000

  let stateStore: jest.Mocked<NextcloudBackupStateStore>
  let timer: jest.Mocked<TimerInterface>
  let logger: jest.Mocked<Logger>
  let state: NextcloudBackupDeliveryState
  let lastSuccessAt: number | null

  const createHandler = () => new NextcloudBackupCompletedEventHandler(stateStore, timer, logger)
  const event = (overrides: Partial<NextcloudBackupCompletedEvent['payload']> = {}): NextcloudBackupCompletedEvent =>
    ({
      type: 'NEXTCLOUD_BACKUP_COMPLETED',
      createdAt: new Date(completedAt),
      meta: {
        correlation: { userIdentifier: userUuid, userIdentifierType: 'uuid' },
        origin: DomainEventService.SyncingServer,
        target: DomainEventService.Auth,
      },
      payload: {
        userUuid,
        requestUuid,
        outcome: 'succeeded',
        completedAt,
        ...overrides,
      },
    }) as NextcloudBackupCompletedEvent

  beforeEach(() => {
    state = {
      ...emptyNextcloudBackupDeliveryState(),
      activeRequest: { requestUuid, requestedAt: nowMs - 2_000 },
    }
    lastSuccessAt = null
    stateStore = {
      runExclusive: jest.fn().mockImplementation(async (_userUuid, transition) => {
        const mutation = transition({ deliveryState: state, lastSuccessAt })
        if (mutation.deliveryState !== undefined) {
          state = mutation.deliveryState
        }
        if (mutation.lastSuccessAt !== undefined) {
          lastSuccessAt = mutation.lastSuccessAt
        }
        return { status: 'available', value: mutation.result }
      }),
    } as unknown as jest.Mocked<NextcloudBackupStateStore>
    timer = {
      getTimestampInMicroseconds: jest.fn().mockReturnValue(nowMs * 1_000),
      convertMicrosecondsToMilliseconds: jest.fn().mockReturnValue(nowMs),
    } as unknown as jest.Mocked<TimerInterface>
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<Logger>
  })

  it('atomically advances LAST_RUN to the confirmed upload time and clears the matching request', async () => {
    await createHandler().handle(event())

    expect(lastSuccessAt).toBe(completedAt)
    expect(state).toEqual(
      expect.objectContaining({
        activeRequest: null,
        consecutiveFailures: 0,
        retryNotBefore: null,
        completed: [{ requestUuid, outcome: 'succeeded', completedAt }],
      }),
    )
    expect(stateStore.runExclusive).toHaveBeenCalledTimes(1)
  })

  it('does not make a late old success look fresh at acknowledgement time', async () => {
    const lateCompletion = nowMs - 14 * 24 * 60 * 60 * 1_000
    state.activeRequest = null

    await createHandler().handle(event({ completedAt: lateCompletion }))

    expect(lastSuccessAt).toBe(lateCompletion)
  })

  it('merges concurrent out-of-order successes without regressing cadence or clobbering unrelated active work', async () => {
    const olderRequest = '00000000-0000-0000-0000-000000000010'
    const newerRequest = '00000000-0000-0000-0000-000000000011'
    const unrelatedActive = '00000000-0000-0000-0000-000000000012'
    state.activeRequest = { requestUuid: unrelatedActive, requestedAt: completedAt - 10_000 }

    await Promise.all([
      createHandler().handle(event({ requestUuid: newerRequest, completedAt: completedAt + 500 })),
      createHandler().handle(event({ requestUuid: olderRequest, completedAt })),
    ])

    expect(lastSuccessAt).toBe(completedAt + 500)
    expect(state.activeRequest).toEqual({ requestUuid: unrelatedActive, requestedAt: completedAt - 10_000 })
    expect(state.completed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestUuid: olderRequest, outcome: 'succeeded' }),
        expect.objectContaining({ requestUuid: newerRequest, outcome: 'succeeded' }),
      ]),
    )
  })

  it('leaves LAST_RUN unchanged on failure and schedules bounded retry from auth time', async () => {
    await createHandler().handle(event({ outcome: 'failed' }))

    expect(lastSuccessAt).toBeNull()
    expect(state).toEqual(
      expect.objectContaining({
        activeRequest: null,
        consecutiveFailures: 1,
        retryNotBefore: nowMs + NEXTCLOUD_BACKUP_INITIAL_RETRY_DELAY_MS,
        completed: [{ requestUuid, outcome: 'failed', completedAt }],
      }),
    )
  })

  it('does not apply the same completion twice', async () => {
    state.completed = [{ requestUuid, outcome: 'succeeded', completedAt }]
    const before = structuredClone(state)

    await createHandler().handle(event())

    expect(state).toEqual(before)
    expect(lastSuccessAt).toBeNull()
  })

  it('upgrades a failed receipt to success for an overlapping delivery of the same request', async () => {
    await createHandler().handle(event({ outcome: 'failed' }))
    expect(state.completed).toEqual([{ requestUuid, outcome: 'failed', completedAt }])

    await createHandler().handle(event({ outcome: 'succeeded', completedAt: completedAt + 500 }))

    expect(state.completed).toEqual([{ requestUuid, outcome: 'succeeded', completedAt: completedAt + 500 }])
    expect(lastSuccessAt).toBe(completedAt + 500)
    expect(state.retryNotBefore).toBeNull()
  })

  it('never lets a later failed receipt downgrade an existing success', async () => {
    await createHandler().handle(event({ outcome: 'succeeded' }))
    const successfulState = structuredClone(state)

    await createHandler().handle(event({ outcome: 'failed', completedAt: completedAt + 500 }))

    expect(state).toEqual(successfulState)
    expect(lastSuccessAt).toBe(completedAt)
  })

  it.each([
    ['failure then success', ['failed', 'succeeded']],
    ['success then failure', ['succeeded', 'failed']],
  ] as const)('converges overlapping %s deliveries to success', async (_description, outcomes) => {
    await Promise.all(
      outcomes.map((outcome, index) => createHandler().handle(event({ outcome, completedAt: completedAt + index }))),
    )

    expect(state.completed).toHaveLength(1)
    expect(state.completed[0]).toEqual(expect.objectContaining({ requestUuid, outcome: 'succeeded' }))
    expect(lastSuccessAt).not.toBeNull()
  })

  it('rejects a structurally valid far-future completion without opening a transaction', async () => {
    await createHandler().handle(event({ completedAt: nowMs + 60 * 60 * 1_000 }))

    expect(stateStore.runExclusive).not.toHaveBeenCalled()
  })

  it.each([
    {
      description: 'wrong origin',
      origin: DomainEventService.Auth,
      target: DomainEventService.Auth,
    },
    {
      description: 'wrong target',
      origin: DomainEventService.SyncingServer,
      target: DomainEventService.SyncingServer,
    },
  ])('rejects a completion with $description provenance', async ({ origin, target }) => {
    const mismatchedEvent = event()
    mismatchedEvent.meta.origin = origin
    mismatchedEvent.meta.target = target

    await createHandler().handle(mismatchedEvent)

    expect(stateStore.runExclusive).not.toHaveBeenCalled()
  })

  it('rejects a completion whose UUID correlation does not match its payload user', async () => {
    const mismatchedEvent = event()
    mismatchedEvent.meta.correlation.userIdentifier = '00000000-0000-0000-0000-000000000099'

    await createHandler().handle(mismatchedEvent)

    expect(stateStore.runExclusive).not.toHaveBeenCalled()
  })

  it('rejects a completion with missing provenance metadata', async () => {
    const malformedEvent = event()
    delete (malformedEvent as Partial<NextcloudBackupCompletedEvent>).meta

    await createHandler().handle(malformedEvent)

    expect(stateStore.runExclusive).not.toHaveBeenCalled()
  })

  it('rejects a completion timestamp earlier than its matching active request', async () => {
    const before = structuredClone(state)
    await createHandler().handle(
      event({ completedAt: (state.activeRequest as { requestedAt: number }).requestedAt - 1 }),
    )

    expect(state).toEqual(before)
    expect(lastSuccessAt).toBeNull()
  })

  it('retries when the lifecycle transaction is unavailable', async () => {
    stateStore.runExclusive.mockResolvedValue({ status: 'unavailable' })

    await expect(createHandler().handle(event())).rejects.toThrow('completion state is unavailable')
  })

  it('drops a completion for a deleted user without causing queue redelivery', async () => {
    stateStore.runExclusive.mockResolvedValue({ status: 'user-not-found' })

    await expect(createHandler().handle(event())).resolves.toBeUndefined()
    expect(logger.info).toHaveBeenCalledWith(
      'Dropped a Nextcloud backup completion for a deleted user.',
      expect.objectContaining({ userId: userUuid, requestId: requestUuid }),
    )
  })

  it('never logs payload extras that could contain destination credentials', async () => {
    const unsafeEvent = event() as NextcloudBackupCompletedEvent & {
      payload: NextcloudBackupCompletedEvent['payload'] & { nextcloudAppPassword: string; nextcloudUrl: string }
    }
    unsafeEvent.payload.nextcloudAppPassword = 'secret-app-password'
    unsafeEvent.payload.nextcloudUrl = 'https://private-nextcloud.example'

    await createHandler().handle(unsafeEvent)

    const logs = JSON.stringify([
      ...(logger.debug.mock.calls ?? []),
      ...(logger.info.mock.calls ?? []),
      ...(logger.warn.mock.calls ?? []),
      ...(logger.error.mock.calls ?? []),
    ])
    expect(logs).not.toContain('secret-app-password')
    expect(logs).not.toContain('private-nextcloud.example')
  })
})
