import 'reflect-metadata'

import { Logger } from 'winston'
import { Result, SettingName, Timestamps, Uuid } from '@standardnotes/domain-core'
import { TimerInterface } from '@standardnotes/time'

import { TriggerNextcloudBackupForAllUsers } from './TriggerNextcloudBackupForAllUsers'
import { TriggerNextcloudBackupForUser } from '../TriggerNextcloudBackupForUser/TriggerNextcloudBackupForUser'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { GetSetting } from '../GetSetting/GetSetting'
import { SetSettingValue } from '../SetSettingValue/SetSettingValue'
import { EncryptionVersion } from '../../Encryption/EncryptionVersion'
import { Setting } from '../../Setting/Setting'

/**
 * Standard Red Notes: the master-gate precedence of the scheduled Nextcloud
 * backup pass — the admin-persisted server-settings override (read through the
 * shared SERVER_SETTINGS_PATH overlay) WINS over the boot-time env boolean;
 * `undefined` (no override persisted) falls back to env.
 */
describe('TriggerNextcloudBackupForAllUsers master gate', () => {
  let settingRepository: jest.Mocked<SettingRepositoryInterface>
  let triggerNextcloudBackupForUser: jest.Mocked<TriggerNextcloudBackupForUser>
  let getSetting: jest.Mocked<GetSetting>
  let setSettingValue: jest.Mocked<SetSettingValue>
  let timer: jest.Mocked<TimerInterface>
  let logger: jest.Mocked<Logger>

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
    getSetting = {
      execute: jest.fn().mockResolvedValue(Result.fail('not found')),
    } as unknown as jest.Mocked<GetSetting>
    setSettingValue = {
      execute: jest.fn().mockResolvedValue(Result.ok({} as Setting)),
    } as unknown as jest.Mocked<SetSettingValue>
    timer = {
      getTimestampInMicroseconds: jest.fn().mockReturnValue(NOW_MICROS),
      convertMicrosecondsToMilliseconds: jest.fn().mockReturnValue(NOW_MS),
    } as unknown as jest.Mocked<TimerInterface>
    logger = { info: jest.fn(), error: jest.fn() } as unknown as jest.Mocked<Logger>
  })

  const makeUseCase = (envEnabled: boolean, override?: () => Promise<boolean | undefined>) =>
    new TriggerNextcloudBackupForAllUsers(
      settingRepository,
      triggerNextcloudBackupForUser,
      getSetting,
      setSettingValue,
      timer,
      logger,
      envEnabled,
      override,
    )

  it('skips when the env gate is off and no override is persisted', async () => {
    const result = await makeUseCase(false).execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBe(false)
    expect(settingRepository.countAllByNameAndValue).not.toHaveBeenCalled()
  })

  it('a persisted override of true WINS over an env gate of false (runtime enable, no restart)', async () => {
    const result = await makeUseCase(false, async () => true).execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBe(false)
    expect(settingRepository.countAllByNameAndValue).toHaveBeenCalled()
  })

  it('a persisted override of false WINS over an env gate of true (runtime kill switch)', async () => {
    const result = await makeUseCase(true, async () => false).execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBe(false)
    expect(settingRepository.countAllByNameAndValue).not.toHaveBeenCalled()
  })

  it('an undefined override (nothing persisted / no shared file) falls back to the env gate', async () => {
    const result = await makeUseCase(true, async () => undefined).execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBe(false)
    expect(settingRepository.countAllByNameAndValue).toHaveBeenCalled()
  })

  it('triggers a due backup and records the successful run timestamp', async () => {
    settingRepository.countAllByNameAndValue.mockResolvedValue(1)
    settingRepository.findAllByNameAndValue.mockResolvedValue([frequencySetting()])

    const result = await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBe(false)
    expect(triggerNextcloudBackupForUser.execute).toHaveBeenCalledWith({ userUuid: USER_UUID })
    expect(setSettingValue.execute).toHaveBeenCalledWith({
      settingName: SettingName.NAMES.NextcloudBackupLastRun,
      value: String(NOW_MS),
      userUuid: USER_UUID,
      checkUserPermissions: false,
    })
  })

  it('skips a user whose last successful backup is not yet due', async () => {
    settingRepository.countAllByNameAndValue.mockResolvedValue(1)
    settingRepository.findAllByNameAndValue.mockResolvedValue([frequencySetting()])
    getSetting.execute.mockResolvedValue(
      Result.ok({
        setting: frequencySetting(),
        decryptedValue: String(NOW_MS - 60 * 60 * 1000),
      }),
    )

    const result = await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBe(false)
    expect(triggerNextcloudBackupForUser.execute).not.toHaveBeenCalled()
    expect(setSettingValue.execute).not.toHaveBeenCalled()
  })

  it.each([
    ['an empty', ''],
    ['a malformed', 'not-a-timestamp'],
  ])('treats %s last-run value as never run', async (_description, decryptedValue) => {
    settingRepository.countAllByNameAndValue.mockResolvedValue(1)
    settingRepository.findAllByNameAndValue.mockResolvedValue([frequencySetting()])
    getSetting.execute.mockResolvedValue(Result.ok({ setting: frequencySetting(), decryptedValue }))

    const result = await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBe(false)
    expect(triggerNextcloudBackupForUser.execute).toHaveBeenCalledWith({ userUuid: USER_UUID })
  })

  it('continues the scheduler pass when a user backup fails', async () => {
    settingRepository.countAllByNameAndValue.mockResolvedValue(1)
    settingRepository.findAllByNameAndValue.mockResolvedValue([frequencySetting()])
    triggerNextcloudBackupForUser.execute.mockResolvedValue(Result.fail('Nextcloud unavailable'))

    const result = await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBe(false)
    expect(setSettingValue.execute).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('Failed to trigger a Nextcloud backup for a user.', {
      userId: USER_UUID,
    })
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('Nextcloud unavailable')
    expect(logger.error).toHaveBeenCalledWith('Failed to trigger Nextcloud backup for 1 users')
  })

  it('reports a last-run persistence failure without failing the completed backup', async () => {
    settingRepository.countAllByNameAndValue.mockResolvedValue(1)
    settingRepository.findAllByNameAndValue.mockResolvedValue([frequencySetting()])
    setSettingValue.execute.mockResolvedValue(Result.fail('database unavailable'))

    const result = await makeUseCase(true).execute({ backupFrequency: 'daily' })

    expect(result.isFailed()).toBe(false)
    expect(logger.error).toHaveBeenCalledWith('Failed to record the Nextcloud backup last-run time.', {
      userId: USER_UUID,
    })
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('database unavailable')
  })
})
