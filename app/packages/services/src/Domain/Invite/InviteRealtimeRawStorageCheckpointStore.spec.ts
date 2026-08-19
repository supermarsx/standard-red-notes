import {
  InviteRealtimeRawStorageCheckpointStore,
  InviteRealtimeRawStoragePort,
} from './InviteRealtimeRawStorageCheckpointStore'

class MemoryRawStorage implements InviteRealtimeRawStoragePort {
  readonly values = new Map<string, string>()

  async getRawStorageValue(key: string): Promise<string | undefined> {
    return this.values.get(key)
  }

  async setRawStorageValue(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async removeRawStorageValue(key: string): Promise<void> {
    this.values.delete(key)
  }
}

describe('InviteRealtimeRawStorageCheckpointStore', () => {
  it('persists isolated checkpoints under opaque session-scoped keys', async () => {
    const storage = new MemoryRawStorage()
    const store = new InviteRealtimeRawStorageCheckpointStore(storage, { keyPrefix: 'test:invite:' })

    await store.write('opaque/a', { cursor: 'cursor-a', seenEventIds: ['event-a'] })
    await store.write('opaque/b', { cursor: 'cursor-b', seenEventIds: [] })

    await expect(store.read('opaque/a')).resolves.toEqual({ cursor: 'cursor-a', seenEventIds: ['event-a'] })
    await expect(store.read('opaque/b')).resolves.toEqual({ cursor: 'cursor-b', seenEventIds: [] })
    expect([...storage.values.keys()]).toEqual(['test:invite:opaque%2Fa', 'test:invite:opaque%2Fb'])
    await store.clear('opaque/a')
    await expect(store.read('opaque/a')).resolves.toBeUndefined()
  })

  it('removes malformed or oversized values instead of restoring an unsafe cursor', async () => {
    const storage = new MemoryRawStorage()
    const store = new InviteRealtimeRawStorageCheckpointStore(storage, { keyPrefix: 'test:invite:' })
    storage.values.set('test:invite:opaque', '{malformed')

    await expect(store.read('opaque')).resolves.toBeUndefined()
    expect(storage.values.has('test:invite:opaque')).toBe(false)

    storage.values.set('test:invite:opaque', 'x'.repeat(64 * 1024 + 1))
    await expect(store.read('opaque')).resolves.toBeUndefined()
    expect(storage.values.has('test:invite:opaque')).toBe(false)
  })
})
