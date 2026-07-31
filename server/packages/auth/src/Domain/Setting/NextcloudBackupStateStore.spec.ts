import 'reflect-metadata'

import { Result, SettingName } from '@standardnotes/domain-core'
import { Logger } from 'winston'
import { TimerInterface } from '@standardnotes/time'

import { GetSetting } from '../UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../UseCase/SetSettingValue/SetSettingValue'
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
import { NextcloudBackupStateStore } from './NextcloudBackupStateStore'

describe('NextcloudBackupStateStore', () => {
  const userUuid = '00000000-0000-0000-0000-000000000001'
  let getSetting: jest.Mocked<GetSetting>
  let setSettingValue: jest.Mocked<SetSettingValue>
  let timer: jest.Mocked<TimerInterface>
  let logger: jest.Mocked<Logger>
  const nowMs = 1_700_000_000_000

  const createStore = () => new NextcloudBackupStateStore(getSetting, setSettingValue, timer, logger)

  beforeEach(() => {
    getSetting = {
      execute: jest.fn().mockResolvedValue(Result.fail('not found')),
    } as unknown as jest.Mocked<GetSetting>
    setSettingValue = {
      execute: jest.fn().mockResolvedValue(Result.ok({})),
    } as unknown as jest.Mocked<SetSettingValue>
    timer = {
      getTimestampInMicroseconds: jest.fn().mockReturnValue(nowMs * 1_000),
      convertMicrosecondsToMilliseconds: jest.fn().mockReturnValue(nowMs),
    } as unknown as jest.Mocked<TimerInterface>
    logger = {
      error: jest.fn(),
    } as unknown as jest.Mocked<Logger>
  })

  it('treats an absent delivery-state setting as a legitimate empty initial state', async () => {
    const result = await createStore().readDeliveryState(userUuid)

    expect(result).toEqual({ status: 'available', value: emptyNextcloudBackupDeliveryState() })
  })

  it('fails closed when delivery-state storage is unavailable', async () => {
    getSetting.execute.mockResolvedValue(Result.fail('database unavailable'))

    expect(await createStore().readDeliveryState(userUuid)).toEqual({ status: 'unavailable' })
  })

  it('fails closed when storage or decryption throws', async () => {
    getSetting.execute.mockRejectedValue(new Error('raw database row'))

    expect(await createStore().readDeliveryState(userUuid)).toEqual({ status: 'unavailable' })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('raw database row')
  })

  it('fails closed and logs safely when persisted delivery state is corrupt', async () => {
    const rawState =
      '{"activeRequest":{"requestUuid":"bad"},"nextcloudUrl":"https://secret.example","appPassword":"secret-value"}'
    getSetting.execute.mockResolvedValue(Result.ok({ decryptedValue: rawState }))

    expect(await createStore().readDeliveryState(userUuid)).toEqual({ status: 'unavailable' })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(rawState)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret.example')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-value')
  })

  it('fails closed on implausible future lifecycle timestamps', async () => {
    getSetting.execute.mockResolvedValue(
      Result.ok({
        decryptedValue: JSON.stringify({
          activeRequest: {
            requestUuid: '00000000-0000-0000-0000-000000000002',
            requestedAt: nowMs + 60 * 60 * 1_000,
          },
          consecutiveFailures: 0,
          retryNotBefore: null,
          completed: [],
        }),
      }),
    )

    expect(await createStore().readDeliveryState(userUuid)).toEqual({ status: 'unavailable' })
  })

  it('fails closed when LAST_RUN cannot be read or is malformed', async () => {
    getSetting.execute.mockResolvedValueOnce(Result.fail('database unavailable'))
    expect(await createStore().readLastSuccessAt(userUuid)).toEqual({ status: 'unavailable' })

    getSetting.execute.mockResolvedValueOnce(Result.ok({ decryptedValue: String(nowMs + 60 * 60 * 1_000) }))
    expect(await createStore().readLastSuccessAt(userUuid)).toEqual({ status: 'unavailable' })

    getSetting.execute.mockResolvedValueOnce(Result.ok({ decryptedValue: '123garbage' }))
    expect(await createStore().readLastSuccessAt(userUuid)).toEqual({ status: 'unavailable' })
  })

  it('uses sensitive retrieval for private lifecycle state and ordinary retrieval for LAST_RUN', async () => {
    await createStore().readDeliveryState(userUuid)
    await createStore().readLastSuccessAt(userUuid)

    expect(getSetting.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        settingName: SettingName.NAMES.NextcloudBackupDeliveryState,
        allowSensitiveRetrieval: true,
      }),
    )
    expect(getSetting.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        settingName: SettingName.NAMES.NextcloudBackupLastRun,
        allowSensitiveRetrieval: false,
      }),
    )
  })

  it('never logs setting-write values when persistence is rejected', async () => {
    setSettingValue.execute.mockResolvedValue(Result.fail('contains secret-app-password'))

    expect(await createStore().writeDeliveryState(userUuid, emptyNextcloudBackupDeliveryState())).toBe(false)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-app-password')
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
