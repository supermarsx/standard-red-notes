import {
  hasOnlyKeys,
  isBoundedString,
  isJsonObject,
  isSafeRecordKey,
  SecureJsonFileStore,
} from '../../Infra/SecureJsonFileStore'
import { DeliveryConfig, isDeliveryChannel } from './Types'

/**
 * Standard Red Notes: per-user reminder DELIVERY configuration store.
 *
 * Holds, per user, the channel (whatsapp|telegram|email) + destination
 * (phone / chat-id / email) + an enabled flag. Default is unset/disabled: the
 * scheduler skips any user without an enabled config. It uses the same bounded,
 * validated, cross-instance locked, durable JSON primitive as the
 * published-reminders store.
 *
 * NOTE: the destination here is plaintext (it has to be — the server needs it to
 * send). Like the published reminders, it exists only because the user opted in.
 */

interface StoreShape {
  // userUuid -> DeliveryConfig
  [userUuid: string]: DeliveryConfig
}

const MAX_USERS = 10_000
const MAX_DESTINATION_LENGTH = 8_192

function isStoreShape(value: unknown): value is StoreShape {
  if (!isJsonObject(value)) {
    return false
  }
  const entries = Object.entries(value)
  return (
    entries.length <= MAX_USERS &&
    entries.every(
      ([userUuid, config]) =>
        isSafeRecordKey(userUuid) &&
        hasOnlyKeys(config, ['channel', 'destination', 'enabled']) &&
        isDeliveryChannel(config.channel) &&
        isBoundedString(config.destination, 0, MAX_DESTINATION_LENGTH) &&
        typeof config.enabled === 'boolean',
    )
  )
}

export class DeliveryConfigStore {
  private readonly store: SecureJsonFileStore<StoreShape>

  constructor(filePath: string) {
    this.store = new SecureJsonFileStore({
      filePath,
      validate: isStoreShape,
    })
  }

  async getForUser(userUuid: string): Promise<DeliveryConfig | null> {
    if (!isSafeRecordKey(userUuid)) {
      return null
    }
    const data = await this.read()
    const config = data[userUuid]
    if (!config || !isDeliveryChannel(config.channel)) {
      return null
    }
    return config
  }

  async setForUser(userUuid: string, config: DeliveryConfig): Promise<DeliveryConfig> {
    if (!isSafeRecordKey(userUuid)) {
      throw new Error('A valid user identifier is required to configure reminder delivery.')
    }
    if (!isDeliveryChannel(config.channel)) {
      throw new Error(`Unsupported delivery channel: ${String(config.channel)}`)
    }
    const normalized: DeliveryConfig = {
      channel: config.channel,
      destination: (config.destination ?? '').trim(),
      enabled: Boolean(config.enabled),
    }
    if (!isBoundedString(normalized.destination, 0, MAX_DESTINATION_LENGTH)) {
      throw new Error(`Reminder delivery destinations may not exceed ${MAX_DESTINATION_LENGTH} characters.`)
    }
    await this.mutate((data) => {
      data[userUuid] = normalized
    })
    return normalized
  }

  /** Remove the plaintext destination after an authoritative account opt-out. */
  async deleteForUser(userUuid: string): Promise<boolean> {
    if (!isSafeRecordKey(userUuid)) {
      return false
    }
    let removed = false
    await this.mutate((data) => {
      if (data[userUuid]) {
        delete data[userUuid]
        removed = true
      }
    })
    return removed
  }

  private async read(): Promise<StoreShape> {
    return (await this.store.read()) ?? {}
  }

  private async mutate(mutator: (data: StoreShape) => void): Promise<void> {
    await this.store.update((current) => {
      const data = current ?? {}
      mutator(data)
      return data
    })
  }
}
