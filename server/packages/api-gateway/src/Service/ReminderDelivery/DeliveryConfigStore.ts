import { promises as fs } from 'fs'
import * as path from 'path'

import { DeliveryConfig, isDeliveryChannel } from './Types'

/**
 * Standard Red Notes: per-user reminder DELIVERY configuration store.
 *
 * Holds, per user, the channel (whatsapp|telegram|email) + destination
 * (phone / chat-id / email) + an enabled flag. Default is unset/disabled: the
 * scheduler skips any user without an enabled config. Same JSON-file + mutex +
 * atomic-write idiom as the published-reminders store, keeping the whole feature
 * self-contained in api-gateway.
 *
 * NOTE: the destination here is plaintext (it has to be — the server needs it to
 * send). Like the published reminders, it exists only because the user opted in.
 */

interface StoreShape {
  // userUuid -> DeliveryConfig
  [userUuid: string]: DeliveryConfig
}

export class DeliveryConfigStore {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  async getForUser(userUuid: string): Promise<DeliveryConfig | null> {
    const data = await this.read()
    const config = data[userUuid]
    if (!config || !isDeliveryChannel(config.channel)) {
      return null
    }
    return config
  }

  async setForUser(userUuid: string, config: DeliveryConfig): Promise<DeliveryConfig> {
    if (!isDeliveryChannel(config.channel)) {
      throw new Error(`Unsupported delivery channel: ${String(config.channel)}`)
    }
    const normalized: DeliveryConfig = {
      channel: config.channel,
      destination: (config.destination ?? '').trim(),
      enabled: Boolean(config.enabled),
    }
    await this.mutate((data) => {
      data[userUuid] = normalized
    })
    return normalized
  }

  private async read(): Promise<StoreShape> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as StoreShape
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}
      }
      throw error
    }
  }

  private async mutate(mutator: (data: StoreShape) => void): Promise<void> {
    const run = this.writeChain.then(async () => {
      const data = await this.read()
      mutator(data)
      await this.atomicWrite(data)
    })
    this.writeChain = run.catch(() => undefined)
    return run
  }

  private async atomicWrite(data: StoreShape): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmp, this.filePath)
  }
}
