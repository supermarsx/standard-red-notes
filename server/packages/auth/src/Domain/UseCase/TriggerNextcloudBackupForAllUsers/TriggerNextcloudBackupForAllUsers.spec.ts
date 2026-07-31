import 'reflect-metadata'

import { Logger } from 'winston'
import { Result, SettingName, Timestamps, Uuid } from '@standardnotes/domain-core'
import { DomainEventService, NextcloudBackupCompletedEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'

import { TriggerNextcloudBackupForAllUsers } from './TriggerNextcloudBackupForAllUsers'
import { TriggerNextcloudBackupForUser } from '../TriggerNextcloudBackupForUser/TriggerNextcloudBackupForUser'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { EncryptionVersion } from '../../Encryption/EncryptionVersion'
import { Setting } from '../../Setting/Setting'
import {
  NEXTCLOUD_BACKUP_IN_FLIGHT_TIMEOUT_MS,
  NEXTCLOUD_BACKUP_INITIAL_RETRY_DELAY_MS,
  NextcloudBackupDeliveryState,
  emptyNextcloudBackupDeliveryState,
} from '../../Setting/NextcloudBackupDeliveryState'
import { NextcloudBackupStateStore } from '../../Setting/NextcloudBackupStateStore'
import { NextcloudBackupCompletedEventHandler } from '../../Handler/NextcloudBackupCompletedEventHandler'

describe('TriggerNextcloudBackupForAllUsers', () => {
  let settingRepository: jest.Mocked<SettingRepositoryInterface>
  let triggerNextcloudBackupForUser: jest.Mocked<TriggerNextcloudBackupForUser>
  let stateStore: jest.Mocked<NextcloudBackupStateStore>
  let timer: jest.Mocked<TimerInterface>
  let logger: jest.Mocked<Logger>
  let deliveryState: NextcloudBackupDeliveryState
  let lastSuccessAt: number | null

  const USER_UUID = '00000000-0000-0000-0000-000000000000'
  const NOW_MICROS = 1_700_000_000_000_000
  const NOW_MS = 1_700_000_000_000

  const frequencySetting = () =>
    Setting.create({
      name: SettingName.NAMES.NextcloudBackupFrequency,
      value: 'daily',
      serverEncryptionVersion: EncryptionVersion.Default,
      userUuid: Uuid.create(USER_UUID).getValue(),
      sensitive: false,
      timestamps: Timestamps.create(123, 123).getValue(),
    }).getValue()

  beforeEach(() => {
    settingRepository = {
      countAllByNameAndValue: jest.fn().mockResolvedValue(0),
      findAllByNameAndValue: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<SettingRepositoryInterface>
    triggerNextcloudBackupForUser = {
      execute: jest.fn().mockResolvedValue(Result.ok()),
    } as unknown as jest.Mocked<TriggerNextcloudBackupForUser>
    deliveryState = emptyNextcloudBackupDeliveryState()
    lastSuccessAt = null
    stateStore = {
      readDeliveryState: jest.fn().mockImplementation(async () => ({ status: 'available', value: deliveryState })),
      readLastSuccessAt: jest.fn().mockImplementation(async () => ({ status: 'available', value: lastSuccessAt })),
      writeDeliveryState: jest.fn().mockImplementation(async (_userUuid, nextState) => {
        deliveryState = nextState
        return true
      }),
      writeLastSuccessAt: jest.fn().mockImplementation(async (_userUuid, timestamp) => {
        lastSuccessAt = timestamp
        return true
      }),
    } as unknown as jest.Mocked<NextcloudBackupStateStore>
    timer = {
      getTimestampInMicroseconds: jest.fn().mockReturnValue(NOW_MICROS),
      convertMicrosecondsToMilliseconds: jest.fn().mockReturnValue(NOW_MS),
    } as unknown as jest.Mocked<TimerInterface>
    logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as jest.Mocked<Logger>
  })

  const makeUseCase = (envEnabled: boolean, override?: () => Promise<boolean | undefined>) =>
    new TriggerNextcloudBackupForAllUsers(
      settingRepository,
      triggerNextcloudBackupForUser,
      stateStore,
      timer,
      logger,
      envEnabled,
      override,
    )

  const makeUserDue = () => {
    settingRepository.countAllByNameAndValue.mockResolvedValue(1)
    settingRepository.findAllByNameAndValue.mockResolvedValue([frequencySetting()])
  }

  it('skips when the env gate is off and no override is persisted', async () => {
    await makeUseCase(false).execute({ backupFrequency: 'daily' })

    expect(settingRepository.countAllByNameAndValue).not.toHaveBeenCalled()
  })

  it('lets a persisted true override win over an env gate of false', async () => {
    await makeUseCase(false, async () => true).execute({ backupFrequency: 'daily' })

    expect(settingRepository.countAllByNameAndValue).toHaveBeenCalled()
  })

  it('lets a persisted false override win over an env gate of true', async () => {
    await makeUseCase(true, async () => false).execute({ backupFrequency: 'daily' })

    expect(settingRepository.countAllByNameAndValue).not.toHaveBeenCalled()
  })

  it('persists an active request before dispatch and does not record LAST_RUN for publication alone', async () => {
    makeUserDue()
    triggerNextcloudBackupForUser.execute.mockImplementation(async ({ requestUuid }) => {
      expect(deliveryState.activeRequest).toEqual({ requestUuid, requestedAt: NOW_MS })
      return Result.ok()
    })

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).toHaveBeenCalledWith({
      userUuid: USER_UUID,
      requestUuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
    })
    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalled()
    expect(lastSuccessAt).toBeNull()
  })

  it('keeps a new-auth request safely retryable while an old syncing service cannot acknowledge it', async () => {
    makeUserDue()

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).toHaveBeenCalledTimes(1)
    expect(deliveryState.activeRequest).toEqual({
      requestUuid: expect.stringMatching(/^[0-9a-f-]{36}$/),
      requestedAt: NOW_MS,
    })
    expect(lastSuccessAt).toBeNull()

    timer.convertMicrosecondsToMilliseconds.mockReturnValue(NOW_MS + NEXTCLOUD_BACKUP_IN_FLIGHT_TIMEOUT_MS)
    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).toHaveBeenCalledTimes(1)
    expect(deliveryState.activeRequest).toBeNull()
    expect(deliveryState.consecutiveFailures).toBe(1)
    expect(deliveryState.retryNotBefore).toBe(
      NOW_MS + NEXTCLOUD_BACKUP_IN_FLIGHT_TIMEOUT_MS + NEXTCLOUD_BACKUP_INITIAL_RETRY_DELAY_MS,
    )
    expect(lastSuccessAt).toBeNull()
  })

  it('supports direct-call nested completion without overwriting the acknowledgement state', async () => {
    makeUserDue()
    const completionHandler = new NextcloudBackupCompletedEventHandler(stateStore, timer, logger)
    triggerNextcloudBackupForUser.execute.mockImplementation(async ({ requestUuid }) => {
      await completionHandler.handle({
        type: 'NEXTCLOUD_BACKUP_COMPLETED',
        createdAt: new Date(NOW_MS),
        meta: {
          correlation: { userIdentifier: USER_UUID, userIdentifierType: 'uuid' },
          origin: DomainEventService.SyncingServer,
          target: DomainEventService.Auth,
        },
        payload: {
          userUuid: USER_UUID,
          requestUuid,
          outcome: 'succeeded',
          completedAt: NOW_MS,
        },
      } as NextcloudBackupCompletedEvent)

      return Result.ok()
    })

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(lastSuccessAt).toBe(NOW_MS)
    expect(deliveryState.activeRequest).toBeNull()
    expect(deliveryState.completed).toHaveLength(1)
    expect(deliveryState.completed[0].outcome).toBe('succeeded')
  })

  it('keeps a failed dispatch retryable without advancing LAST_RUN', async () => {
    makeUserDue()
    triggerNextcloudBackupForUser.execute.mockResolvedValue(Result.fail('secret upstream failure'))

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(lastSuccessAt).toBeNull()
    expect(deliveryState.activeRequest).toBeNull()
    expect(deliveryState.consecutiveFailures).toBe(1)
    expect(deliveryState.retryNotBefore).toBe(NOW_MS + NEXTCLOUD_BACKUP_INITIAL_RETRY_DELAY_MS)
    expect(deliveryState.completed[0].outcome).toBe('failed')
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret upstream failure')
  })

  it('does not publish while a request is still in flight', async () => {
    makeUserDue()
    deliveryState.activeRequest = {
      requestUuid: '00000000-0000-0000-0000-000000000002',
      requestedAt: NOW_MS - NEXTCLOUD_BACKUP_IN_FLIGHT_TIMEOUT_MS + 1,
    }

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).not.toHaveBeenCalled()
  })

  it('expires a lost request into backoff and does not emit another event on repeated cron ticks', async () => {
    makeUserDue()
    deliveryState.activeRequest = {
      requestUuid: '00000000-0000-0000-0000-000000000002',
      requestedAt: NOW_MS - NEXTCLOUD_BACKUP_IN_FLIGHT_TIMEOUT_MS,
    }

    await makeUseCase(true).execute({ backupFrequency: 'daily' })
    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).not.toHaveBeenCalled()
    expect(deliveryState.activeRequest).toBeNull()
    expect(deliveryState.consecutiveFailures).toBe(1)
    expect(deliveryState.retryNotBefore).toBe(NOW_MS + NEXTCLOUD_BACKUP_INITIAL_RETRY_DELAY_MS)
  })

  it('skips a user whose last confirmed success is not due', async () => {
    makeUserDue()
    lastSuccessAt = NOW_MS - 60 * 60 * 1_000

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).not.toHaveBeenCalled()
  })

  it.each(['delivery', 'last-success'])('fails closed when %s state cannot be read', async (unavailableState) => {
    makeUserDue()
    if (unavailableState === 'delivery') {
      stateStore.readDeliveryState.mockResolvedValue({ status: 'unavailable' })
    } else {
      stateStore.readLastSuccessAt.mockResolvedValue({ status: 'unavailable' })
    }

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).not.toHaveBeenCalled()
    expect(stateStore.writeLastSuccessAt).not.toHaveBeenCalled()
  })

  it('fails closed on a persisted far-future success timestamp', async () => {
    makeUserDue()
    lastSuccessAt = NOW_MS + 24 * 60 * 60 * 1_000

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).not.toHaveBeenCalled()
  })
})
