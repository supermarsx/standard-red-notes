import 'reflect-metadata'

import { Logger } from 'winston'
import { TimerInterface } from '@standardnotes/time'

import { TriggerNextcloudBackupForAllUsers } from './TriggerNextcloudBackupForAllUsers'
import { TriggerNextcloudBackupForUser } from '../TriggerNextcloudBackupForUser/TriggerNextcloudBackupForUser'
import { SettingRepositoryInterface } from '../../Setting/SettingRepositoryInterface'
import { GetSetting } from '../GetSetting/GetSetting'
import { SetSettingValue } from '../SetSettingValue/SetSettingValue'

/**
 * Standard Red Notes: the master-gate precedence of the scheduled Nextcloud
 * backup pass — the admin-persisted server-settings override (read through the
 * shared SERVER_SETTINGS_PATH overlay) WINS over the boot-time env boolean;
 * `undefined` (no override persisted) falls back to env.
 */
describe('TriggerNextcloudBackupForAllUsers master gate', () => {
  let settingRepository: jest.Mocked<SettingRepositoryInterface>
  let logger: jest.Mocked<Logger>

  beforeEach(() => {
    settingRepository = {
      countAllByNameAndValue: jest.fn().mockResolvedValue(0),
      findAllByNameAndValue: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<SettingRepositoryInterface>
    logger = { info: jest.fn(), error: jest.fn() } as unknown as jest.Mocked<Logger>
  })

  const makeUseCase = (envEnabled: boolean, override?: () => Promise<boolean | undefined>) =>
    new TriggerNextcloudBackupForAllUsers(
      settingRepository,
      {} as jest.Mocked<TriggerNextcloudBackupForUser>,
      {} as jest.Mocked<GetSetting>,
      {} as jest.Mocked<SetSettingValue>,
      {
        getTimestampInMicroseconds: jest.fn().mockReturnValue(0),
        convertMicrosecondsToMilliseconds: jest.fn().mockReturnValue(0),
      } as unknown as jest.Mocked<TimerInterface>,
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
})
