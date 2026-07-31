import { SettingName } from '@standardnotes/domain-core'
import { Logger } from 'winston'
import { TimerInterface } from '@standardnotes/time'

import { GetSetting } from '../UseCase/GetSetting/GetSetting'
import { SetSettingValue } from '../UseCase/SetSettingValue/SetSettingValue'
import {
  NextcloudBackupDeliveryState,
  emptyNextcloudBackupDeliveryState,
  isValidNextcloudBackupTimestamp,
  NEXTCLOUD_BACKUP_MAX_RETRY_DELAY_MS,
  parseNextcloudBackupDeliveryState,
} from './NextcloudBackupDeliveryState'

export type NextcloudBackupStateRead<T> = { status: 'available'; value: T } | { status: 'unavailable' }

export class NextcloudBackupStateStore {
  private static readonly MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000

  constructor(
    private getSetting: GetSetting,
    private setSettingValue: SetSettingValue,
    private timer: TimerInterface,
    private logger: Logger,
  ) {}

  async readDeliveryState(userUuid: string): Promise<NextcloudBackupStateRead<NextcloudBackupDeliveryState>> {
    try {
      const result = await this.getSetting.execute({
        userUuid,
        settingName: SettingName.NAMES.NextcloudBackupDeliveryState,
        allowSensitiveRetrieval: true,
        decrypted: true,
      })
      if (result.isFailed()) {
        return result.getError().toLowerCase().includes('not found')
          ? { status: 'available', value: emptyNextcloudBackupDeliveryState() }
          : { status: 'unavailable' }
      }

      const value = result.getValue().decryptedValue
      const state = typeof value === 'string' ? parseNextcloudBackupDeliveryState(value) : null
      if (state === null) {
        this.logger.error('Nextcloud backup delivery state is malformed; dispatch is paused.', {
          codeTag: 'NextcloudBackupStateStore',
          userId: userUuid,
        })

        return { status: 'unavailable' }
      }

      const nowMs = this.nowMs()
      if (
        (state.activeRequest &&
          state.activeRequest.requestedAt > nowMs + NextcloudBackupStateStore.MAX_CLOCK_SKEW_MS) ||
        (state.retryNotBefore !== null &&
          state.retryNotBefore >
            nowMs + NEXTCLOUD_BACKUP_MAX_RETRY_DELAY_MS + NextcloudBackupStateStore.MAX_CLOCK_SKEW_MS) ||
        state.completed.some(
          (completion) => completion.completedAt > nowMs + NextcloudBackupStateStore.MAX_CLOCK_SKEW_MS,
        )
      ) {
        this.logger.error('Nextcloud backup delivery state has implausible timestamps; dispatch is paused.', {
          codeTag: 'NextcloudBackupStateStore',
          userId: userUuid,
        })

        return { status: 'unavailable' }
      }

      return { status: 'available', value: state }
    } catch {
      this.logger.error('Nextcloud backup delivery state could not be read.', {
        codeTag: 'NextcloudBackupStateStore',
        userId: userUuid,
      })

      return { status: 'unavailable' }
    }
  }

  async writeDeliveryState(userUuid: string, state: NextcloudBackupDeliveryState): Promise<boolean> {
    return this.writeServerSetting(
      userUuid,
      SettingName.NAMES.NextcloudBackupDeliveryState,
      JSON.stringify(state),
      'Nextcloud backup delivery state could not be recorded.',
    )
  }

  async readLastSuccessAt(userUuid: string): Promise<NextcloudBackupStateRead<number | null>> {
    try {
      const result = await this.getSetting.execute({
        userUuid,
        settingName: SettingName.NAMES.NextcloudBackupLastRun,
        allowSensitiveRetrieval: false,
        decrypted: true,
      })
      if (result.isFailed()) {
        return result.getError().toLowerCase().includes('not found')
          ? { status: 'available', value: null }
          : { status: 'unavailable' }
      }

      const value = result.getValue().decryptedValue
      if (!value || !/^\d+$/.test(value)) {
        this.logger.error('Nextcloud backup last-success time is malformed; dispatch is paused.', {
          codeTag: 'NextcloudBackupStateStore',
          userId: userUuid,
        })

        return { status: 'unavailable' }
      }

      const parsed = Number(value)

      if (!isValidNextcloudBackupTimestamp(parsed)) {
        this.logger.error('Nextcloud backup last-success time is out of range; dispatch is paused.', {
          codeTag: 'NextcloudBackupStateStore',
          userId: userUuid,
        })

        return { status: 'unavailable' }
      }

      if (parsed > this.nowMs() + NextcloudBackupStateStore.MAX_CLOCK_SKEW_MS) {
        this.logger.error('Nextcloud backup last-success time is in the future; dispatch is paused.', {
          codeTag: 'NextcloudBackupStateStore',
          userId: userUuid,
        })

        return { status: 'unavailable' }
      }

      return { status: 'available', value: parsed }
    } catch {
      this.logger.error('Nextcloud backup last-success time could not be read.', {
        codeTag: 'NextcloudBackupStateStore',
        userId: userUuid,
      })

      return { status: 'unavailable' }
    }
  }

  async writeLastSuccessAt(userUuid: string, timestamp: number): Promise<boolean> {
    if (!isValidNextcloudBackupTimestamp(timestamp)) {
      this.logger.error('Nextcloud backup completion carried an invalid timestamp.', {
        codeTag: 'NextcloudBackupStateStore',
        userId: userUuid,
      })

      return false
    }

    return this.writeServerSetting(
      userUuid,
      SettingName.NAMES.NextcloudBackupLastRun,
      String(timestamp),
      'Nextcloud backup last-success time could not be recorded.',
    )
  }

  private async writeServerSetting(
    userUuid: string,
    settingName: string,
    value: string,
    logMessage: string,
  ): Promise<boolean> {
    try {
      const result = await this.setSettingValue.execute({
        settingName,
        value,
        userUuid,
        checkUserPermissions: false,
      })
      if (result.isFailed()) {
        throw new Error('Setting write was rejected')
      }

      return true
    } catch {
      this.logger.error(logMessage, {
        codeTag: 'NextcloudBackupStateStore',
        userId: userUuid,
      })

      return false
    }
  }

  private nowMs(): number {
    return this.timer.convertMicrosecondsToMilliseconds(this.timer.getTimestampInMicroseconds())
  }
}
