import 'reflect-metadata'

import { Logger } from 'winston'
import { TimerInterface } from '@standardnotes/time'

import {
  NEXTCLOUD_BACKUP_MAX_COMPLETED_HISTORY,
  NEXTCLOUD_BACKUP_MAX_CONSECUTIVE_FAILURES,
  NEXTCLOUD_BACKUP_MAX_RETRY_DELAY_MS,
  NEXTCLOUD_BACKUP_MAX_STATE_BYTES,
  emptyNextcloudBackupDeliveryState,
  nextFailureCount,
  nextNextcloudBackupRetryDelayMs,
  parseNextcloudBackupDeliveryState,
} from './NextcloudBackupDeliveryState'
import {
  NextcloudBackupStateRepositoryInterface,
  PersistedNextcloudBackupState,
} from './NextcloudBackupStateRepositoryInterface'
import { NextcloudBackupStateStore } from './NextcloudBackupStateStore'

describe('NextcloudBackupStateStore', () => {
  const userUuid = '00000000-0000-0000-0000-000000000001'
  const nowMs = 1_700_000_000_000
  let persisted: PersistedNextcloudBackupState
  let repository: jest.Mocked<NextcloudBackupStateRepositoryInterface>
  let timer: jest.Mocked<TimerInterface>
  let logger: jest.Mocked<Logger>

  const createStore = () => new NextcloudBackupStateStore(repository, timer, logger)

  beforeEach(() => {
    persisted = {
      deliveryState: { exists: false, value: null },
      lastSuccessAt: { exists: false, value: null },
    }
    repository = {
      runExclusive: jest.fn().mockImplementation(async (_userUuid, transition) => {
        const mutation = transition(persisted)
        if (mutation.deliveryStateValue !== undefined) {
          persisted.deliveryState = { exists: true, value: mutation.deliveryStateValue }
        }
        if (mutation.lastSuccessAtValue !== undefined) {
          persisted.lastSuccessAt = { exists: true, value: mutation.lastSuccessAtValue }
        }
        return { status: 'available', value: mutation.result }
      }),
    } as jest.Mocked<NextcloudBackupStateRepositoryInterface>
    timer = {
      getTimestampInMicroseconds: jest.fn().mockReturnValue(nowMs * 1_000),
      convertMicrosecondsToMilliseconds: jest.fn().mockReturnValue(nowMs),
    } as unknown as jest.Mocked<TimerInterface>
    logger = {
      error: jest.fn(),
    } as unknown as jest.Mocked<Logger>
  })

  it('treats absent settings as a legitimate empty initial lifecycle', async () => {
    const store = createStore()

    expect(await store.readDeliveryState(userUuid)).toEqual({
      status: 'available',
      value: emptyNextcloudBackupDeliveryState(),
    })
    expect(await store.readLastSuccessAt(userUuid)).toEqual({ status: 'available', value: null })
  })

  it('fails closed when the lock, read, write, or commit rejects', async () => {
    repository.runExclusive.mockRejectedValue(new Error('database unavailable'))

    expect(await createStore().readDeliveryState(userUuid)).toEqual({ status: 'unavailable' })
  })

  it('does not log storage errors or corrupt values that could contain credentials', async () => {
    const rawState =
      '{"activeRequest":{"requestUuid":"bad"},"nextcloudUrl":"https://secret.example","appPassword":"secret-value"}'
    persisted.deliveryState = { exists: true, value: rawState }

    expect(await createStore().readDeliveryState(userUuid)).toEqual({ status: 'unavailable' })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(rawState)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret.example')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-value')

    repository.runExclusive.mockRejectedValue(new Error('secret-app-password'))
    await createStore().writeDeliveryState(userUuid, emptyNextcloudBackupDeliveryState())
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-app-password')
  })

  it('fails closed on implausible future lifecycle timestamps', async () => {
    persisted.deliveryState = {
      exists: true,
      value: JSON.stringify({
        activeRequest: {
          requestUuid: '00000000-0000-0000-0000-000000000002',
          requestedAt: nowMs + 60 * 60 * 1_000,
        },
        consecutiveFailures: 0,
        retryNotBefore: null,
        completed: [],
      }),
    }

    expect(await createStore().readDeliveryState(userUuid)).toEqual({ status: 'unavailable' })
  })

  it('fails closed when LAST_RUN is malformed or in the future', async () => {
    persisted.lastSuccessAt = { exists: true, value: '123garbage' }
    expect(await createStore().readLastSuccessAt(userUuid)).toEqual({ status: 'unavailable' })

    persisted.lastSuccessAt = { exists: true, value: String(nowMs + 60 * 60 * 1_000) }
    expect(await createStore().readLastSuccessAt(userUuid)).toEqual({ status: 'unavailable' })
  })

  it('writes delivery state and LAST_RUN in one repository transaction', async () => {
    const state = {
      ...emptyNextcloudBackupDeliveryState(),
      completed: [
        {
          requestUuid: '00000000-0000-0000-0000-000000000002',
          outcome: 'succeeded' as const,
          completedAt: nowMs,
        },
      ],
    }

    const result = await createStore().runExclusive(userUuid, () => ({
      result: 'committed',
      deliveryState: state,
      lastSuccessAt: nowMs,
    }))

    expect(result).toEqual({ status: 'available', value: 'committed' })
    expect(repository.runExclusive).toHaveBeenCalledTimes(1)
    expect(persisted.deliveryState.value).toBe(JSON.stringify(state))
    expect(persisted.lastSuccessAt.value).toBe(String(nowMs))
  })
})

describe('Nextcloud backup state validation', () => {
  const requestUuid = '00000000-0000-0000-0000-000000000002'

  it('rejects partially malformed scheduling timestamps instead of resetting to idle', () => {
    expect(parseNextcloudBackupDeliveryState('{}')).toBeNull()
    expect(
      parseNextcloudBackupDeliveryState(
        JSON.stringify({
          activeRequest: { requestUuid, requestedAt: Number.MAX_SAFE_INTEGER },
          consecutiveFailures: 0,
          retryNotBefore: null,
          completed: [],
        }),
      ),
    ).toBeNull()
    expect(
      parseNextcloudBackupDeliveryState(
        JSON.stringify({ activeRequest: null, consecutiveFailures: -1, retryNotBefore: null, completed: [] }),
      ),
    ).toBeNull()
  })

  it('rejects oversized persisted state before parsing it', () => {
    expect(parseNextcloudBackupDeliveryState(' '.repeat(NEXTCLOUD_BACKUP_MAX_STATE_BYTES + 1))).toBeNull()
  })

  it('deduplicates and bounds completion history', () => {
    const completed = Array.from({ length: NEXTCLOUD_BACKUP_MAX_COMPLETED_HISTORY + 4 }, (_, index) => ({
      requestUuid: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`,
      outcome: 'succeeded',
      completedAt: index,
    }))
    completed.push(completed.at(-1) as (typeof completed)[number])

    const state = parseNextcloudBackupDeliveryState(
      JSON.stringify({ activeRequest: null, consecutiveFailures: 0, retryNotBefore: null, completed }),
    )

    expect(state?.completed).toHaveLength(NEXTCLOUD_BACKUP_MAX_COMPLETED_HISTORY)
    expect(new Set(state?.completed.map((entry) => entry.requestUuid)).size).toBe(
      NEXTCLOUD_BACKUP_MAX_COMPLETED_HISTORY,
    )
  })

  it('caps exponential retry delay at six hours', () => {
    expect(nextNextcloudBackupRetryDelayMs(1)).toBe(15 * 60 * 1_000)
    expect(nextNextcloudBackupRetryDelayMs(32)).toBe(NEXTCLOUD_BACKUP_MAX_RETRY_DELAY_MS)
  })

  it('bounds consecutive failure increments even for invalid internal input', () => {
    expect(nextFailureCount(NEXTCLOUD_BACKUP_MAX_CONSECUTIVE_FAILURES)).toBe(NEXTCLOUD_BACKUP_MAX_CONSECUTIVE_FAILURES)
    expect(nextFailureCount(Number.NaN)).toBe(1)
  })
})
