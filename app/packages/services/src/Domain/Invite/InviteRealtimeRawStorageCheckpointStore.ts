import { InviteRealtimeCheckpoint, InviteRealtimeCheckpointStore } from './InviteRealtimeEventConsumer'

const DEFAULT_KEY_PREFIX = 'standard-red-notes:invite-realtime:v1:'
const MAX_CHECKPOINT_BYTES = 64 * 1024

export interface InviteRealtimeRawStoragePort {
  getRawStorageValue(key: string): Promise<string | undefined>
  setRawStorageValue(key: string, value: string): Promise<void>
  removeRawStorageValue(key: string): Promise<void>
}

/** Device-backed checkpoint persistence scoped only by the already-opaque session digest. */
export class InviteRealtimeRawStorageCheckpointStore implements InviteRealtimeCheckpointStore {
  private readonly keyPrefix: string

  constructor(
    private readonly storage: InviteRealtimeRawStoragePort,
    options: { keyPrefix?: string } = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX
    if (this.keyPrefix.length === 0 || this.keyPrefix.length > 256) {
      throw new Error('Invite realtime checkpoint key prefix is invalid.')
    }
  }

  async read(sessionScope: string): Promise<InviteRealtimeCheckpoint | undefined> {
    const key = this.key(sessionScope)
    const serialized = await this.storage.getRawStorageValue(key)
    if (serialized === undefined) {
      return undefined
    }
    if (byteLength(serialized) > MAX_CHECKPOINT_BYTES) {
      await this.storage.removeRawStorageValue(key)
      return undefined
    }
    try {
      const parsed: unknown = JSON.parse(serialized)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as InviteRealtimeCheckpoint)
        : undefined
    } catch {
      await this.storage.removeRawStorageValue(key)
      return undefined
    }
  }

  async write(sessionScope: string, checkpoint: InviteRealtimeCheckpoint): Promise<void> {
    const serialized = JSON.stringify(checkpoint)
    if (byteLength(serialized) > MAX_CHECKPOINT_BYTES) {
      throw new Error('Invite realtime checkpoint exceeds its durable storage limit.')
    }
    await this.storage.setRawStorageValue(this.key(sessionScope), serialized)
  }

  async clear(sessionScope: string): Promise<void> {
    await this.storage.removeRawStorageValue(this.key(sessionScope))
  }

  private key(sessionScope: string): string {
    if (sessionScope.length === 0 || sessionScope.length > 512) {
      throw new Error('Invite realtime checkpoint session scope is invalid.')
    }
    return `${this.keyPrefix}${encodeURIComponent(sessionScope)}`
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}
