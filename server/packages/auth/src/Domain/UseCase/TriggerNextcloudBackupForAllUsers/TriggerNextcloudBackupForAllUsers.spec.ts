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
      runExclusive: jest.fn().mockImplementation(async (_userUuid, transition) => {
        const mutation = transition({ deliveryState, lastSuccessAt })
        if (mutation.deliveryState !== undefined) {
          deliveryState = mutation.deliveryState
        }
        if (mutation.lastSuccessAt !== undefined) {
          lastSuccessAt = mutation.lastSuccessAt
        }
        return { status: 'available', value: mutation.result }
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
    expect(lastSuccessAt).toBeNull()
  })

  it('allows only one dispatch when two scheduler passes overlap for the same user', async () => {
    makeUserDue()
    let releasePublish!: () => void
    let signalPublishEntered!: () => void
    const publishBlocked = new Promise<void>((resolve) => {
      releasePublish = resolve
    })
    const publishEntered = new Promise<void>((resolve) => {
      signalPublishEntered = resolve
    })
    triggerNextcloudBackupForUser.execute.mockImplementation(async () => {
      signalPublishEntered()
      await publishBlocked
      return Result.ok()
    })

    const firstPass = makeUseCase(true).execute({ backupFrequency: 'daily' })
    await publishEntered
    const secondPass = makeUseCase(true).execute({ backupFrequency: 'daily' })
    await secondPass

    expect(triggerNextcloudBackupForUser.execute).toHaveBeenCalledTimes(1)
    releasePublish()
    await firstPass
    expect(triggerNextcloudBackupForUser.execute).toHaveBeenCalledTimes(1)
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
    // A publish error is ambiguous: the broker may have accepted the event.
    // Do not mark it terminal so a later success acknowledgement can win.
    expect(deliveryState.completed).toHaveLength(0)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret upstream failure')
  })

  it('turns a thrown dispatch into the same bounded retry state without leaking the error', async () => {
    makeUserDue()
    triggerNextcloudBackupForUser.execute.mockRejectedValue(new Error('secret thrown failure'))

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(deliveryState.activeRequest).toBeNull()
    expect(deliveryState.consecutiveFailures).toBe(1)
    expect(deliveryState.retryNotBefore).toBe(NOW_MS + NEXTCLOUD_BACKUP_INITIAL_RETRY_DELAY_MS)
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret thrown failure')
  })

  it('does not overwrite a completed request when dispatch reports an ambiguous failure', async () => {
    makeUserDue()
    triggerNextcloudBackupForUser.execute.mockImplementation(async ({ requestUuid }) => {
      deliveryState.completed = [{ requestUuid, outcome: 'succeeded', completedAt: NOW_MS }]
      return Result.fail('publish returned after completion')
    })

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(deliveryState.activeRequest).toEqual({
      requestUuid: deliveryState.completed[0].requestUuid,
      requestedAt: NOW_MS,
    })
    expect(deliveryState.completed).toEqual([expect.objectContaining({ outcome: 'succeeded', completedAt: NOW_MS })])
    expect(deliveryState.retryNotBefore).toBeNull()
  })

  it('lets a delayed success acknowledgement override an ambiguous publish failure', async () => {
    makeUserDue()
    let publishedRequestUuid = ''
    triggerNextcloudBackupForUser.execute.mockImplementation(async ({ requestUuid }) => {
      publishedRequestUuid = requestUuid
      return Result.fail('publish timed out after broker acceptance')
    })

    await makeUseCase(true).execute({ backupFrequency: 'daily' })
    expect(deliveryState.completed).toHaveLength(0)
    expect(deliveryState.retryNotBefore).not.toBeNull()

    const completionHandler = new NextcloudBackupCompletedEventHandler(stateStore, timer, logger)
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
        requestUuid: publishedRequestUuid,
        outcome: 'succeeded',
        completedAt: NOW_MS,
      },
    } as NextcloudBackupCompletedEvent)

    expect(lastSuccessAt).toBe(NOW_MS)
    expect(deliveryState.retryNotBefore).toBeNull()
    expect(deliveryState.completed).toEqual([
      expect.objectContaining({ requestUuid: publishedRequestUuid, outcome: 'succeeded' }),
    ])
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

  it('heals a legacy active request already covered by a confirmed success', async () => {
    makeUserDue()
    deliveryState.activeRequest = {
      requestUuid: '00000000-0000-0000-0000-000000000002',
      requestedAt: NOW_MS - 2 * 60 * 60 * 1_000,
    }
    deliveryState.consecutiveFailures = 3
    deliveryState.retryNotBefore = NOW_MS + NEXTCLOUD_BACKUP_INITIAL_RETRY_DELAY_MS
    lastSuccessAt = NOW_MS - 60 * 60 * 1_000

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).not.toHaveBeenCalled()
    expect(deliveryState.activeRequest).toBeNull()
    expect(deliveryState.consecutiveFailures).toBe(0)
    expect(deliveryState.retryNotBefore).toBeNull()
  })

  it('fails closed when the lifecycle transaction is unavailable', async () => {
    makeUserDue()
    stateStore.runExclusive.mockResolvedValue({ status: 'unavailable' })

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).not.toHaveBeenCalled()
  })

  it('skips a setting whose user was deleted before the lifecycle claim', async () => {
    makeUserDue()
    stateStore.runExclusive.mockResolvedValue({ status: 'user-not-found' })

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith('Skipped a Nextcloud backup for a deleted user.', {
      userId: USER_UUID,
    })
  })

  it('fails closed on a persisted far-future success timestamp', async () => {
    makeUserDue()
    lastSuccessAt = NOW_MS + 24 * 60 * 60 * 1_000

    await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(triggerNextcloudBackupForUser.execute).not.toHaveBeenCalled()
  })
})
