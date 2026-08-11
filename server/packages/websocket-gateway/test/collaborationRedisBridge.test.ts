import { describe, expect, it, vi } from 'vitest'

import { COLLABORATION_RELAY_CHANNEL, CollaborationRedisBridge } from '../src/collaborationRedisBridge.js'
import type { Conn, SendableSocket } from '../src/registry.js'
import { handleRelayFrame, RoomRegistry, type RoomRelayLifecycle } from '../src/rooms.js'

type MessageHandler = (channel: string, message: string) => void

class FakeRedisNetwork {
  readonly sets = new Map<string, Set<string>>()
  readonly leases = new Map<string, number>()
  readonly published: Array<{ channel: string; message: string }> = []
  readonly subscribers = new Set<MessageHandler>()
  readonly leaseTtls: number[] = []

  client() {
    let messageHandler: MessageHandler | undefined
    return {
      on: (event: string, handler: (...args: never[]) => void) => {
        if (event === 'message') {
          messageHandler = handler as MessageHandler
          this.subscribers.add(messageHandler)
        }
        return this
      },
      subscribe: (_channel: string, callback: (error: null, count: number) => void) => callback(null, 1),
      eval: async (script: string, _keyCount: number, ...args: Array<string | number>) => {
        const roomSetKey = String(args[0])
        const leaseKey = String(args[1])
        const members = this.sets.get(roomSetKey) ?? new Set<string>()
        if (script.includes("redis.call('SMEMBERS'")) {
          for (const member of [...members]) {
            if (!this.leases.has(member)) {
              members.delete(member)
            }
          }
          const active = members.size
          const ttl = Number(args[2])
          this.leaseTtls.push(ttl)
          this.leases.set(leaseKey, ttl)
          members.add(leaseKey)
          this.sets.set(roomSetKey, members)
          return active === 0 ? 1 : 0
        }
        if (script.includes("redis.call('SET', KEYS[2]")) {
          const ttl = Number(args[2])
          this.leaseTtls.push(ttl)
          this.leases.set(leaseKey, ttl)
          members.add(leaseKey)
          this.sets.set(roomSetKey, members)
          return 1
        }
        this.leases.delete(leaseKey)
        members.delete(leaseKey)
        if (members.size === 0) {
          this.sets.delete(roomSetKey)
        }
        return 1
      },
      pexpire: async (key: string, milliseconds: number) => {
        if (!this.leases.has(key)) {
          return 0
        }
        this.leaseTtls.push(milliseconds)
        this.leases.set(key, milliseconds)
        return 1
      },
      publish: async (channel: string, message: string) => {
        this.published.push({ channel, message })
        for (const subscriber of this.subscribers) {
          subscriber(channel, message)
        }
        return this.subscribers.size
      },
      quit: async () => undefined,
      disconnect: () => {
        if (messageHandler) {
          this.subscribers.delete(messageHandler)
        }
      },
    }
  }
}

function connection(id: string): Conn<SendableSocket> & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  return {
    socket: { send },
    send,
    userUuid: `user-${id}`,
    sessionUuid: `session-${id}`,
    connectionId: `connection-${id}`,
  }
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe('CollaborationRedisBridge multi-replica relay', () => {
  it('relays an already-encrypted frame to another replica without echoing it locally', () => {
    const redis = new FakeRedisNetwork()
    const roomsA = new RoomRegistry<SendableSocket>()
    const roomsB = new RoomRegistry<SendableSocket>()
    const localA = connection('a')
    const localB = connection('b')
    roomsA.join('note-1', localA)
    roomsB.join('note-1', localB)
    const bridgeA = new CollaborationRedisBridge(roomsA, redis.client() as never, redis.client() as never, logger, 'a')
    new CollaborationRedisBridge(roomsB, redis.client() as never, redis.client() as never, logger, 'b')

    bridgeA.publish({ t: 'yjs', room: 'note-1', payload: 'base64-aes-gcm-ciphertext' })

    expect(localA.send).not.toHaveBeenCalled()
    expect(localB.send).toHaveBeenCalledWith(
      JSON.stringify({ t: 'yjs', room: 'note-1', payload: 'base64-aes-gcm-ciphertext' }),
    )
    expect(redis.published).toHaveLength(1)
    expect(redis.published[0].channel).toBe(COLLABORATION_RELAY_CHANNEL)
    expect(JSON.parse(redis.published[0].message)).toEqual({
      v: 1,
      origin: 'a',
      frame: { t: 'yjs', room: 'note-1', payload: 'base64-aes-gcm-ciphertext' },
    })
  })

  it('atomically elects one bootstrapper and removes bounded leases on disconnect', async () => {
    const redis = new FakeRedisNetwork()
    const bridgeA = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'a',
    )
    const bridgeB = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'b',
    )
    const a = connection('a')
    const b = connection('b')
    const expiresAt = Date.now() + 5 * 60_000

    const [electionA, electionB] = await Promise.all([
      bridgeA.reserveEditorLease(a, 'same-room', 'lease-a', expiresAt),
      bridgeB.reserveEditorLease(b, 'same-room', 'lease-b', expiresAt),
    ])

    expect([electionA.shouldBootstrap, electionB.shouldBootstrap].sort()).toEqual([false, true])
    expect(redis.leases.size).toBe(2)
    expect(redis.leaseTtls.every((ttl) => ttl > 0 && ttl <= 75_000)).toBe(true)

    // Reusing the exact logical lease (reservation -> mounted provider) keeps
    // the election result rather than spuriously becoming a second bootstrapper.
    await expect(bridgeA.reserveEditorLease(a, 'same-room', 'lease-a', expiresAt)).resolves.toEqual(electionA)

    await bridgeA.releaseAll(a)
    expect(redis.leases.size).toBe(1)
    await bridgeB.releaseAll(b)
    expect(redis.leases.size).toBe(0)
    expect(redis.sets.size).toBe(0)
  })

  it('publishes only frames from an authorized live room member', async () => {
    const rooms = new RoomRegistry<SendableSocket>()
    const member = connection('member')
    const outsider = connection('outsider')
    const lifecycle: RoomRelayLifecycle<SendableSocket> = {
      reserveEditorLease: vi.fn().mockResolvedValue({ shouldBootstrap: false }),
      releaseLease: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn(),
    }
    const authorize = () => ({ authorized: true as const, expiresAt: Date.now() + 60_000 })

    await handleRelayFrame(
      rooms,
      member,
      { t: 'room-join', room: 'note-1', requestId: 'lease-1', role: 'editor' },
      authorize,
      undefined,
      lifecycle,
    )
    expect(member.send).toHaveBeenCalledWith(
      JSON.stringify({ t: 'room-joined', room: 'note-1', requestId: 'lease-1', bootstrap: false }),
    )
    expect(lifecycle.publish).toHaveBeenCalledWith({ t: 'room-sync', room: 'note-1' })

    vi.mocked(lifecycle.publish).mockClear()
    const encryptedFrame = { t: 'yjs' as const, room: 'note-1', payload: 'client-aes-gcm-ciphertext' }
    await handleRelayFrame(rooms, member, encryptedFrame, authorize, undefined, lifecycle)
    expect(lifecycle.publish).toHaveBeenCalledWith(encryptedFrame)

    vi.mocked(lifecycle.publish).mockClear()
    await handleRelayFrame(rooms, outsider, encryptedFrame, authorize, undefined, lifecycle)
    expect(lifecycle.publish).not.toHaveBeenCalled()

    await handleRelayFrame(
      rooms,
      member,
      { t: 'room-leave', room: 'note-1', requestId: 'lease-1' },
      authorize,
      undefined,
      lifecycle,
    )
    expect(lifecycle.releaseLease).toHaveBeenCalledWith(member, 'note-1', 'lease-1')
  })
})
