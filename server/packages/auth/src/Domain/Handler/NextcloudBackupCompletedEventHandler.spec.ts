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
    stateStore = {
      readDeliveryState: jest.fn().mockResolvedValue({ status: 'available', value: state }),
      readLastSuccessAt: jest.fn().mockResolvedValue({ status: 'available', value: null }),
      writeDeliveryState: jest.fn().mockResolvedValue(true),
      writeLastSuccessAt: jest.fn().mockResolvedValue(true),
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

  it('advances LAST_RUN only to the confirmed upload time and clears the matching request', async () => {
    await createHandler().handle(event())

    expect(stateStore.writeLastSuccessAt).toHaveBeenCalledWith(userUuid, completedAt)
    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalledWith(userUuid, nowMs)
    expect(stateStore.writeDeliveryState).toHaveBeenCalledWith(
      userUuid,
      expect.objectContaining({
        activeRequest: null,
        consecutiveFailures: 0,
        retryNotBefore: null,
        completed: [{ requestUuid, outcome: 'succeeded', completedAt }],
      }),
    )
  })

  it('does not make a late old success look fresh at acknowledgement time', async () => {
    const lateCompletion = nowMs - 14 * 24 * 60 * 60 * 1_000
    state.activeRequest = null

    await createHandler().handle(event({ completedAt: lateCompletion }))

    expect(stateStore.writeLastSuccessAt).toHaveBeenCalledWith(userUuid, lateCompletion)
    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalledWith(userUuid, nowMs)
  })

  it('updates LAST_RUN monotonically when an older success arrives out of order', async () => {
    const existingSuccess = completedAt + 500
    state.activeRequest = null
    stateStore.readLastSuccessAt.mockResolvedValue({ status: 'available', value: existingSuccess })

    await createHandler().handle(event())

    expect(stateStore.writeLastSuccessAt).toHaveBeenCalledWith(userUuid, existingSuccess)
  })

  it('leaves LAST_RUN unchanged on failure and schedules bounded retry from auth time', async () => {
    await createHandler().handle(event({ outcome: 'failed' }))

    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalled()
    expect(stateStore.writeDeliveryState).toHaveBeenCalledWith(
      userUuid,
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

    await createHandler().handle(event())

    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalled()
    expect(stateStore.writeDeliveryState).not.toHaveBeenCalled()
  })

  it('rejects a structurally valid far-future completion without mutating state', async () => {
    await createHandler().handle(event({ completedAt: nowMs + 60 * 60 * 1_000 }))

    expect(stateStore.readDeliveryState).not.toHaveBeenCalled()
    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalled()
    expect(stateStore.writeDeliveryState).not.toHaveBeenCalled()
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

    expect(stateStore.readDeliveryState).not.toHaveBeenCalled()
    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalled()
    expect(stateStore.writeDeliveryState).not.toHaveBeenCalled()
  })

  it('rejects a completion whose UUID correlation does not match its payload user', async () => {
    const mismatchedEvent = event()
    mismatchedEvent.meta.correlation.userIdentifier = '00000000-0000-0000-0000-000000000099'

    await createHandler().handle(mismatchedEvent)

    expect(stateStore.readDeliveryState).not.toHaveBeenCalled()
    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalled()
    expect(stateStore.writeDeliveryState).not.toHaveBeenCalled()
  })

  it('rejects a completion with missing provenance metadata', async () => {
    const malformedEvent = event()
    delete (malformedEvent as Partial<NextcloudBackupCompletedEvent>).meta

    await createHandler().handle(malformedEvent)

    expect(stateStore.readDeliveryState).not.toHaveBeenCalled()
    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalled()
    expect(stateStore.writeDeliveryState).not.toHaveBeenCalled()
  })

  it('rejects a completion timestamp earlier than its matching active request', async () => {
    await createHandler().handle(
      event({ completedAt: (state.activeRequest as { requestedAt: number }).requestedAt - 1 }),
    )

    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalled()
    expect(stateStore.writeDeliveryState).not.toHaveBeenCalled()
  })

  it.each(['delivery', 'last-success'])('retries when %s state cannot be read', async (unavailableState) => {
    if (unavailableState === 'delivery') {
      stateStore.readDeliveryState.mockResolvedValue({ status: 'unavailable' })
    } else {
      stateStore.readLastSuccessAt.mockResolvedValue({ status: 'unavailable' })
    }

    await expect(createHandler().handle(event())).rejects.toThrow('completion state is unavailable')
    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalled()
    expect(stateStore.writeDeliveryState).not.toHaveBeenCalled()
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
