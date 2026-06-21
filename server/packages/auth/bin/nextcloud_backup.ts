import 'reflect-metadata'

import { Logger } from 'winston'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

import { ContainerConfigLoader } from '../src/Bootstrap/Container'
import TYPES from '../src/Bootstrap/Types'
import { Env } from '../src/Bootstrap/Env'
import { TriggerNextcloudBackupForAllUsers } from '../src/Domain/UseCase/TriggerNextcloudBackupForAllUsers/TriggerNextcloudBackupForAllUsers'

// Standard Red Notes: cron entry mirroring bin/backup.ts (email backups). Invoke as
//   yarn node dist/bin/nextcloud_backup.js <daily|weekly|monthly>
// from a scheduler. The trigger is a no-op unless NEXTCLOUD_BACKUPS_ENABLED=true and
// the per-user URL + app password + frequency are configured.
const inputArgs = process.argv.slice(2)
const backupFrequency = inputArgs[0]

const requestBackups = async (triggerNextcloudBackupForAllUsers: TriggerNextcloudBackupForAllUsers): Promise<void> => {
  await triggerNextcloudBackupForAllUsers.execute({ backupFrequency })
}

const container = new ContainerConfigLoader('worker')
void container.load().then((container) => {
  dayjs.extend(utc)

  const env: Env = new Env()
  env.load()

  const logger: Logger = container.get(TYPES.Auth_Logger)

  logger.info(`Starting ${backupFrequency} Nextcloud backup requesting...`)

  const triggerNextcloudBackupForAllUsers: TriggerNextcloudBackupForAllUsers = container.get(
    TYPES.Auth_TriggerNextcloudBackupForAllUsers,
  )

  Promise.resolve(requestBackups(triggerNextcloudBackupForAllUsers))
    .then(() => {
      logger.info(`${backupFrequency} Nextcloud backup requesting complete`)

      process.exit(0)
    })
    .catch((error) => {
      logger.error(`Could not finish ${backupFrequency} Nextcloud backup requesting: ${error.message}`)

      process.exit(1)
    })
})
