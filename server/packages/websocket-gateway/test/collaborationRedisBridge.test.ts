import { describe, expect, it, vi } from 'vitest'

import {
  COLLABORATION_RELAY_CHANNEL,
  CollaborationRedisBridge,
  MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM,
} from '../src/collaborationRedisBridge.js'
import type { Conn, SendableSocket } from '../src/registry.js'
import {
  COLLABORATION_PROTOCOL_VERSION,
  handleRelayFrame,
  MAX_YJS_TRANSFER_BYTES,
  PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS,
  RoomRegistry,
  type RoomRelayLifecycle,
} from '../src/rooms.js'

type MessageHandler = (channel: string, message: string) => void
type SubscriptionCallback = (error: Error | null | undefined, count?: unknown) => void

class FakeRedisNetwork {
  readonly sets = new Map<string, Set<string>>()
  readonly leases = new Map<string, number>()
  readonly leaseValues = new Map<string, string>()
  readonly published: Array<{ channel: string; message: string }> = []
  readonly subscribers = new Set<MessageHandler>()
  readonly leaseTtls: number[] = []
  readonly subscriberErrorHandlers = new Set<(error: Error) => void>()
  readonly subscriberReadyHandlers = new Set<() => void>()
  readonly subscriberCloseHandlers = new Set<() => void>()
  readonly subscriberReconnectingHandlers = new Set<(delay: number) => void>()
  readonly subscriberEndHandlers = new Set<() => void>()
  readonly commandErrorHandlers = new Set<(error: Error) => void>()
  readonly commandReadyHandlers = new Set<() => void>()
  readonly commandCloseHandlers = new Set<() => void>()
  readonly commandReconnectingHandlers = new Set<(delay: number) => void>()
  readonly commandEndHandlers = new Set<() => void>()
  readonly subscriptionCallbacks: SubscriptionCallback[] = []
  private nextClientRole: 'command' | 'subscriber' = 'command'
  autoCompleteSubscriptions = true
  failEval = false
  failedEvalCalls = 0
  failPublish = false
  readonly forcedLeasePolicyResults = new Map<string, -1 | -2>()

  emitError(error = new Error('redis unavailable')): void {
    for (const handler of this.subscriberErrorHandlers) {
      handler(error)
    }
  }

  emitReady(): void {
    for (const handler of this.subscriberReadyHandlers) {
      handler()
    }
  }

  emitClose(): void {
    for (const handler of this.subscriberCloseHandlers) {
      handler()
    }
  }

  emitReconnecting(delay = 100): void {
    for (const handler of this.subscriberReconnectingHandlers) {
      handler(delay)
    }
  }

  emitEnd(): void {
    for (const handler of this.subscriberEndHandlers) {
      handler()
    }
  }

  emitCommandError(error = new Error('redis command unavailable')): void {
    for (const handler of this.commandErrorHandlers) {
      handler(error)
    }
  }

  emitCommandReady(): void {
    for (const handler of this.commandReadyHandlers) {
      handler()
    }
  }

  emitCommandClose(): void {
    for (const handler of this.commandCloseHandlers) {
      handler()
    }
  }

  emitCommandReconnecting(delay = 100): void {
    for (const handler of this.commandReconnectingHandlers) {
      handler(delay)
    }
  }

  emitCommandEnd(): void {
    for (const handler of this.commandEndHandlers) {
      handler()
    }
  }

  completeSubscription(index: number, error?: Error, count = 1): void {
    const callback = this.subscriptionCallbacks[index]
    if (!callback) {
      throw new Error(`No subscription attempt exists at index ${index}`)
    }
    callback(error, count)
  }

  client() {
    const role = this.nextClientRole
    this.nextClientRole = role === 'command' ? 'subscriber' : 'command'
    let messageHandler: MessageHandler | undefined
    return {
      status: 'ready',
      on: (event: string, handler: (...args: never[]) => void) => {
        if (event === 'message') {
          messageHandler = handler as MessageHandler
          this.subscribers.add(messageHandler)
        } else if (event === 'error') {
          const handlers = role === 'command' ? this.commandErrorHandlers : this.subscriberErrorHandlers
          handlers.add(handler as (error: Error) => void)
        } else if (event === 'ready') {
          const handlers = role === 'command' ? this.commandReadyHandlers : this.subscriberReadyHandlers
          handlers.add(handler as () => void)
        } else if (event === 'close') {
          const handlers = role === 'command' ? this.commandCloseHandlers : this.subscriberCloseHandlers
          handlers.add(handler as () => void)
        } else if (event === 'reconnecting') {
          const handlers = role === 'command' ? this.commandReconnectingHandlers : this.subscriberReconnectingHandlers
          handlers.add(handler as (delay: number) => void)
        } else if (event === 'end') {
          const handlers = role === 'command' ? this.commandEndHandlers : this.subscriberEndHandlers
          handlers.add(handler as () => void)
        }
        return this
      },
      subscribe: (_channel: string, callback: SubscriptionCallback) => {
        this.subscriptionCallbacks.push(callback)
        if (this.autoCompleteSubscriptions) {
          callback(null, 1)
        }
      },
      eval: async (script: string, _keyCount: number, ...args: Array<string | number>) => {
        if (this.failEval) {
          this.failedEvalCalls += 1
          throw new Error('redis eval unavailable')
        }
        const roomSetKey = String(args[0])
        const leaseKey = String(args[1])
        const members = this.sets.get(roomSetKey) ?? new Set<string>()
        if (script.includes("redis.call('SMEMBERS'")) {
          const forcedPolicyResult = this.forcedLeasePolicyResults.get(leaseKey)
          if (forcedPolicyResult !== undefined) {
            this.forcedLeasePolicyResults.delete(leaseKey)
            return forcedPolicyResult
          }
          for (const member of [...members]) {
            if (!this.leases.has(member)) {
              members.delete(member)
            }
          }
          const marker = String(args[4])
          if ([...members].some((member) => !this.leaseValues.get(member)?.startsWith(marker.slice(0, 3)))) {
            return -1
          }
          const active = members.size
          const roomLeaseLimit = Number(args[5])
          if (script.includes('active >= tonumber(ARGV[4])') && active >= roomLeaseLimit && !members.has(leaseKey)) {
            return -2
          }
          const ttl = Number(args[2])
          this.leaseTtls.push(ttl)
          this.leases.set(leaseKey, ttl)
          this.leaseValues.set(leaseKey, marker)
          members.add(leaseKey)
          this.sets.set(roomSetKey, members)
          return active === 0 ? 1 : 0
        }
        if (script.includes("redis.call('SET', KEYS[2]")) {
          const ttl = Number(args[2])
          const marker = String(args[4])
          this.leaseTtls.push(ttl)
          this.leases.set(leaseKey, ttl)
          this.leaseValues.set(leaseKey, marker)
          members.add(leaseKey)
          this.sets.set(roomSetKey, members)
          return 1
        }
        this.leases.delete(leaseKey)
        this.leaseValues.delete(leaseKey)
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
        if (this.failPublish) {
          throw new Error('redis publish unavailable')
        }
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
  it('relays an already-encrypted frame to another replica without echoing it locally', async () => {
    const redis = new FakeRedisNetwork()
    const roomsA = new RoomRegistry<SendableSocket>()
    const roomsB = new RoomRegistry<SendableSocket>()
    const localA = connection('a')
    const localB = connection('b')
    roomsA.join('note-1', localA)
    roomsB.join('note-1', localB)
    const bridgeA = new CollaborationRedisBridge(roomsA, redis.client() as never, redis.client() as never, logger, 'a')
    new CollaborationRedisBridge(roomsB, redis.client() as never, redis.client() as never, logger, 'b')

    await bridgeA.publish({ t: 'yjs', room: 'note-1', payload: 'base64-aes-gcm-ciphertext' })

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

  it('keeps chunk ciphertext opaque while relaying a bounded transfer across replicas', async () => {
    const redis = new FakeRedisNetwork()
    const roomsA = new RoomRegistry<SendableSocket>()
    const roomsB = new RoomRegistry<SendableSocket>()
    const localA = connection('chunk-a')
    const localB = connection('chunk-b')
    roomsA.join('large-note', localA)
    roomsB.join('large-note', localB)
    const bridgeA = new CollaborationRedisBridge(
      roomsA,
      redis.client() as never,
      redis.client() as never,
      logger,
      'chunk-replica-a',
    )
    new CollaborationRedisBridge(roomsB, redis.client() as never, redis.client() as never, logger, 'chunk-replica-b')
    const chunk = {
      t: 'yjs-chunk' as const,
      room: 'large-note',
      transferId: 'transfer-1',
      index: 0,
      count: 2,
      totalBytes: 128 * 1024 + 1,
      payload: 'opaque-aes-gcm-chunk',
    }

    await bridgeA.publish(chunk)

    expect(localA.send).not.toHaveBeenCalled()
    expect(localB.send).toHaveBeenCalledWith(JSON.stringify(chunk))
    expect(JSON.stringify(redis.published)).not.toContain('note plaintext sentinel')
  })

  it('preserves retry requester identity across replicas and rejects malformed retry envelopes', async () => {
    const redis = new FakeRedisNetwork()
    const roomsA = new RoomRegistry<SendableSocket>()
    const roomsB = new RoomRegistry<SendableSocket>()
    const localA = connection('retry-a')
    const localB = connection('retry-b')
    roomsA.join('retry-note', localA)
    roomsB.join('retry-note', localB)
    const bridgeA = new CollaborationRedisBridge(
      roomsA,
      redis.client() as never,
      redis.client() as never,
      logger,
      'retry-replica-a',
    )
    new CollaborationRedisBridge(roomsB, redis.client() as never, redis.client() as never, logger, 'retry-replica-b')
    const retry = {
      t: 'yjs-retry' as const,
      room: 'retry-note',
      requestId: 'retry-request',
      requesterClientId: 4_294_967_295,
    }

    await bridgeA.publish(retry)

    expect(localA.send).not.toHaveBeenCalled()
    expect(localB.send).toHaveBeenCalledWith(JSON.stringify(retry))
    localA.send.mockClear()
    localB.send.mockClear()

    for (const frame of [
      { t: 'yjs-retry', room: 'retry-note', requestId: 'missing-client' },
      { t: 'yjs-retry', room: 'retry-note', requestId: 'fractional-client', requesterClientId: 1.5 },
      { t: 'yjs-retry', room: 'retry-note', requestId: 'oversized-client', requesterClientId: 4_294_967_296 },
    ]) {
      for (const subscriber of redis.subscribers) {
        subscriber(COLLABORATION_RELAY_CHANNEL, JSON.stringify({ v: 1, origin: 'untrusted-replica', frame }))
      }
    }
    expect(localA.send).not.toHaveBeenCalled()
    expect(localB.send).not.toHaveBeenCalled()
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
      bridgeA.reserveEditorLease(a, 'same-room', 'lease-a', expiresAt, COLLABORATION_PROTOCOL_VERSION, 100),
      bridgeB.reserveEditorLease(b, 'same-room', 'lease-b', expiresAt, COLLABORATION_PROTOCOL_VERSION, 100),
    ])

    expect([electionA.shouldBootstrap, electionB.shouldBootstrap].sort()).toEqual([false, true])
    expect(redis.leases.size).toBe(2)
    expect(redis.leaseTtls.every((ttl) => ttl > 0 && ttl <= 75_000)).toBe(true)

    // Reusing the exact logical lease (reservation -> mounted provider) keeps
    // the election result rather than spuriously becoming a second bootstrapper.
    await expect(
      bridgeA.reserveEditorLease(a, 'same-room', 'lease-a', expiresAt, COLLABORATION_PROTOCOL_VERSION, 100),
    ).resolves.toEqual(electionA)

    await bridgeA.releaseAll(a)
    expect(redis.leases.size).toBe(1)
    await bridgeB.releaseAll(b)
    expect(redis.leases.size).toBe(0)
    expect(redis.sets.size).toBe(0)
  })

  it('atomically caps one room across replicas, preserves idempotent refresh, and admits work after stale pruning', async () => {
    const redis = new FakeRedisNetwork()
    const bridgeA = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'cap-a',
    )
    const bridgeB = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'cap-b',
    )
    const bridges = [bridgeA, bridgeB]
    const connections: Array<Conn<SendableSocket>> = []
    const expiresAt = Date.now() + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS

    for (let index = 0; index < MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM; index += 1) {
      const conn = connection(`cap-${index}`)
      connections.push(conn)
      await expect(
        bridges[index % bridges.length].reserveEditorLease(
          conn,
          'globally-capped-room',
          `cap-request-${index}`,
          expiresAt,
          COLLABORATION_PROTOCOL_VERSION,
          1,
        ),
      ).resolves.toMatchObject({ shouldBootstrap: index === 0 })
    }
    expect(redis.leases.size).toBe(MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM)

    await expect(
      bridgeA.reserveEditorLease(
        connections[0],
        'globally-capped-room',
        'cap-request-0',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).resolves.toMatchObject({ shouldBootstrap: true })

    const overflow = connection('cap-overflow')
    await expect(
      bridgeB.reserveEditorLease(
        overflow,
        'globally-capped-room',
        'cap-overflow',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).rejects.toThrow('Collaboration room editor lease limit exceeded')

    // A deterministic capacity result is not a Redis health failure.
    await expect(
      bridgeB.reserveEditorLease(
        connection('other-room'),
        'other-room',
        'other-room-request',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).resolves.toMatchObject({ shouldBootstrap: true })

    // The Lua path prunes dead keys before applying the cap, so a naturally
    // expired replica lease makes room without operator cleanup.
    const roomSet = [...redis.sets.values()].find((set) => set.size === MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM)
    const staleLeaseKey = [...(roomSet ?? [])][0]
    expect(staleLeaseKey).toBeDefined()
    redis.leases.delete(staleLeaseKey)
    redis.leaseValues.delete(staleLeaseKey)
    await expect(
      bridgeB.reserveEditorLease(
        overflow,
        'globally-capped-room',
        'cap-overflow',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).resolves.toMatchObject({ shouldBootstrap: false })
    expect(roomSet?.size).toBe(MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM)

    // Heartbeat repair uses the same gate: the old replica still has this
    // lease locally, but cannot blindly re-add it after the room refilled.
    await bridgeA.refreshLeases()
    expect(roomSet?.size ?? 0).toBeLessThanOrEqual(MAX_DISTRIBUTED_EDITOR_LEASES_PER_ROOM)
  })

  it.each([
    ['distributed room capacity', -2],
    ['incompatible room protocol', -1],
  ] as const)('contains a deterministic %s refresh failure to the affected room', async (_label, policyResult) => {
    const redis = new FakeRedisNetwork()
    const rooms = new RoomRegistry<SendableSocket>()
    const affected = connection(`policy-affected-${policyResult}`)
    const unrelated = connection(`policy-unrelated-${policyResult}`)
    const expiresAt = Date.now() + 60_000
    rooms.join('policy-affected-room', affected, expiresAt, 'affected-request')
    rooms.join('policy-unrelated-room', unrelated, expiresAt, 'unrelated-request')
    const bridge = new CollaborationRedisBridge(
      rooms,
      redis.client() as never,
      redis.client() as never,
      logger,
      `policy-replica-${policyResult}`,
    )
    await bridge.reserveEditorLease(
      affected,
      'policy-affected-room',
      'affected-request',
      expiresAt,
      COLLABORATION_PROTOCOL_VERSION,
      1,
    )
    await bridge.reserveEditorLease(
      unrelated,
      'policy-unrelated-room',
      'unrelated-request',
      expiresAt,
      COLLABORATION_PROTOCOL_VERSION,
      1,
    )
    const affectedLeaseKey = [...redis.leaseValues.keys()][0]
    expect(affectedLeaseKey).toBeDefined()
    if (!affectedLeaseKey) {
      throw new Error('expected an affected lease key')
    }
    redis.forcedLeasePolicyResults.set(affectedLeaseKey, policyResult)

    await bridge.refreshLeases()

    expect(rooms.isMember('policy-affected-room', affected)).toBe(false)
    expect(affected.send).toHaveBeenCalledWith(
      JSON.stringify({ t: 'room-denied', room: 'policy-affected-room', requestId: 'affected-request' }),
    )
    expect(rooms.isMember('policy-unrelated-room', unrelated)).toBe(true)
    expect(unrelated.send).not.toHaveBeenCalledWith(expect.stringContaining('"t":"room-denied"'))
    await expect(
      bridge.publish({ t: 'comment', room: 'policy-unrelated-room', payload: 'still-healthy' }),
    ).resolves.toBeUndefined()
    await expect(
      bridge.reserveEditorLease(
        connection(`policy-survivor-${policyResult}`),
        'policy-survivor-room',
        'survivor-request',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).resolves.toMatchObject({ shouldBootstrap: true })
  })

  it('binds activation to one reservation challenge and rejects replay or revision rollback', async () => {
    const redis = new FakeRedisNetwork()
    const bridge = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'challenge-replica',
    )
    const conn = connection('challenge')
    const activationDeadline = Date.now() + PENDING_EDITOR_RESERVATION_ACTIVATION_TIMEOUT_MS
    const expiresAt = Date.now() + 60_000
    const reservation = await bridge.reserveEditorLease(
      conn,
      'challenge-room',
      'challenge-request',
      activationDeadline,
      COLLABORATION_PROTOCOL_VERSION,
      100,
    )
    expect(reservation).toMatchObject({ shouldBootstrap: true, bootstrapChallenge: expect.any(String) })
    const reservationTtl = redis.leaseTtls.at(-1) ?? 0
    const ttlWritesBeforeActivation = redis.leaseTtls.length

    await expect(
      bridge.activateEditorLease(
        conn,
        'challenge-room',
        'challenge-request',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        99,
        reservation.bootstrapChallenge,
      ),
    ).rejects.toThrow()
    expect(redis.leaseTtls).toHaveLength(ttlWritesBeforeActivation)
    await expect(
      bridge.activateEditorLease(
        conn,
        'challenge-room',
        'challenge-request',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        101,
        'wrong-challenge',
      ),
    ).rejects.toThrow()
    expect(redis.leaseTtls).toHaveLength(ttlWritesBeforeActivation)
    await expect(
      bridge.activateEditorLease(
        conn,
        'challenge-room',
        'challenge-request',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        101,
        reservation.bootstrapChallenge,
      ),
    ).resolves.toEqual({ shouldBootstrap: true })
    expect(redis.leaseTtls.at(-1)).toBeGreaterThan(reservationTtl)
    await expect(
      bridge.activateEditorLease(
        conn,
        'challenge-room',
        'challenge-request',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        101,
        reservation.bootstrapChallenge,
      ),
    ).rejects.toThrow()
  })

  it('rejects a room whose active distributed lease carries an incompatible protocol marker', async () => {
    const redis = new FakeRedisNetwork()
    const bridgeA = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'protocol-a',
    )
    const bridgeB = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'protocol-b',
    )
    const expiresAt = Date.now() + 60_000
    await bridgeA.reserveEditorLease(
      connection('protocol-a'),
      'protocol-room',
      'lease-a',
      expiresAt,
      COLLABORATION_PROTOCOL_VERSION,
      1,
    )
    const activeLeaseKey = [...redis.leaseValues.keys()][0]
    redis.leaseValues.set(activeLeaseKey, 'v1:legacy')

    await expect(
      bridgeB.reserveEditorLease(
        connection('protocol-b'),
        'protocol-room',
        'lease-b',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).rejects.toThrow('Incompatible collaboration protocol')
    await expect(
      bridgeB.reserveEditorLease(
        connection('protocol-b-other-room'),
        'compatible-room',
        'compatible-lease',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).resolves.toMatchObject({ shouldBootstrap: true })
  })

  it('denies every local room immediately when publish, refresh, or subscriber health fails', async () => {
    const redis = new FakeRedisNetwork()
    const rooms = new RoomRegistry<SendableSocket>()
    const member = connection('health')
    rooms.join('health-room', member, Date.now() + 60_000, 'health-lease')
    const bridge = new CollaborationRedisBridge(
      rooms,
      redis.client() as never,
      redis.client() as never,
      logger,
      'health-replica',
    )
    await bridge.reserveEditorLease(
      member,
      'health-room',
      'health-lease',
      Date.now() + 60_000,
      COLLABORATION_PROTOCOL_VERSION,
      1,
    )

    redis.failPublish = true
    await expect(bridge.publish({ t: 'yjs', room: 'health-room', payload: 'opaque' })).rejects.toThrow()
    expect(rooms.roomCount()).toBe(0)
    expect(member.send).toHaveBeenCalledWith(
      JSON.stringify({ t: 'room-denied', room: 'health-room', requestId: 'health-lease' }),
    )

    const refreshRooms = new RoomRegistry<SendableSocket>()
    const refreshMember = connection('refresh')
    refreshRooms.join('refresh-room', refreshMember, Date.now() + 60_000, 'refresh-lease')
    const refreshRedis = new FakeRedisNetwork()
    const refreshBridge = new CollaborationRedisBridge(
      refreshRooms,
      refreshRedis.client() as never,
      refreshRedis.client() as never,
      logger,
      'refresh-replica',
    )
    await refreshBridge.reserveEditorLease(
      refreshMember,
      'refresh-room',
      'refresh-lease',
      Date.now() + 60_000,
      COLLABORATION_PROTOCOL_VERSION,
      1,
    )
    refreshRedis.failEval = true
    await refreshBridge.refreshLeases()
    expect(refreshRooms.roomCount()).toBe(0)

    const subscriberRooms = new RoomRegistry<SendableSocket>()
    const subscriberMember = connection('subscriber')
    subscriberRooms.join('subscriber-room', subscriberMember, Date.now() + 60_000, 'subscriber-lease')
    const subscriberRedis = new FakeRedisNetwork()
    new CollaborationRedisBridge(
      subscriberRooms,
      subscriberRedis.client() as never,
      subscriberRedis.client() as never,
      logger,
      'subscriber-replica',
    )
    subscriberRedis.emitError()
    expect(subscriberRooms.roomCount()).toBe(0)
  })

  it('stays fail-closed until the current connection subscription is acknowledged and ignores stale callbacks', async () => {
    const redis = new FakeRedisNetwork()
    redis.autoCompleteSubscriptions = false
    const rooms = new RoomRegistry<SendableSocket>()
    const member = connection('subscription-order')
    const bridge = new CollaborationRedisBridge(
      rooms,
      redis.client() as never,
      redis.client() as never,
      logger,
      'subscription-order-replica',
    )
    const expiresAt = Date.now() + 60_000

    expect(redis.subscriptionCallbacks).toHaveLength(1)
    rooms.join('subscription-room', member, expiresAt, 'initial-request')
    for (const subscriber of redis.subscribers) {
      subscriber(
        COLLABORATION_RELAY_CHANNEL,
        JSON.stringify({
          v: 1,
          origin: 'remote-replica',
          frame: { t: 'yjs', room: 'subscription-room', payload: 'must-not-pass-before-subscribe-ack' },
        }),
      )
    }
    expect(member.send).not.toHaveBeenCalled()
    await expect(
      bridge.reserveEditorLease(
        member,
        'subscription-room',
        'initial-request',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).rejects.toThrow('Redis collaboration relay is not healthy')

    redis.completeSubscription(0)
    await bridge.reserveEditorLease(
      member,
      'subscription-room',
      'initial-request',
      expiresAt,
      COLLABORATION_PROTOCOL_VERSION,
      1,
    )

    redis.emitClose()
    redis.emitReconnecting()
    expect(rooms.roomCount()).toBe(0)
    redis.emitReady()
    expect(redis.subscriptionCallbacks).toHaveLength(2)

    // This attempt belongs to a connection that closes before Redis confirms
    // the SUBSCRIBE command. Its later success must never reopen the relay.
    redis.emitClose()
    redis.completeSubscription(1)
    await expect(
      bridge.reserveEditorLease(
        member,
        'subscription-room',
        'stale-request',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).rejects.toThrow('Redis collaboration relay is not healthy')

    redis.emitReconnecting()
    redis.emitReady()
    expect(redis.subscriptionCallbacks).toHaveLength(3)
    redis.completeSubscription(2)
    await expect(
      bridge.reserveEditorLease(
        member,
        'subscription-room',
        'current-request',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).resolves.toMatchObject({ shouldBootstrap: true })
  })

  it('rejects failed or empty subscription acknowledgements and recovers only after a valid retry', async () => {
    const redis = new FakeRedisNetwork()
    redis.autoCompleteSubscriptions = false
    const bridge = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'subscription-failure-replica',
    )
    const member = connection('subscription-failure')
    const expiresAt = Date.now() + 60_000

    redis.completeSubscription(0, new Error('subscribe denied'))
    redis.emitReady()
    redis.completeSubscription(1, undefined, 0)
    await expect(
      bridge.reserveEditorLease(
        member,
        'subscription-failure-room',
        'invalid-subscription',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).rejects.toThrow('Redis collaboration relay is not healthy')

    redis.emitReady()
    redis.completeSubscription(2)
    await expect(
      bridge.reserveEditorLease(
        member,
        'subscription-failure-room',
        'valid-subscription',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).resolves.toMatchObject({ shouldBootstrap: true })
  })

  it.each([
    ['close', (redis: FakeRedisNetwork) => redis.emitClose()],
    ['reconnecting', (redis: FakeRedisNetwork) => redis.emitReconnecting()],
    ['end', (redis: FakeRedisNetwork) => redis.emitEnd()],
  ])('immediately denies active rooms on subscriber %s', async (_event, disconnect) => {
    const redis = new FakeRedisNetwork()
    const rooms = new RoomRegistry<SendableSocket>()
    const member = connection(`lifecycle-${_event}`)
    const expiresAt = Date.now() + 60_000
    rooms.join('lifecycle-room', member, expiresAt, 'lifecycle-request')
    const bridge = new CollaborationRedisBridge(
      rooms,
      redis.client() as never,
      redis.client() as never,
      logger,
      `lifecycle-${_event}-replica`,
    )
    await bridge.reserveEditorLease(
      member,
      'lifecycle-room',
      'lifecycle-request',
      expiresAt,
      COLLABORATION_PROTOCOL_VERSION,
      1,
    )
    member.send.mockClear()

    disconnect(redis)

    expect(rooms.roomCount()).toBe(0)
    expect(member.send).toHaveBeenCalledWith(
      JSON.stringify({ t: 'room-denied', room: 'lifecycle-room', requestId: 'lifecycle-request' }),
    )
    await expect(
      bridge.reserveEditorLease(
        member,
        'lifecycle-room',
        'after-disconnect',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).rejects.toThrow('Redis collaboration relay is not healthy')
  })

  it('requires command recovery as well as a current subscriber acknowledgement before reopening', async () => {
    const redis = new FakeRedisNetwork()
    redis.autoCompleteSubscriptions = false
    const bridge = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'dual-health-replica',
    )
    const member = connection('dual-health')
    const expiresAt = Date.now() + 60_000

    redis.emitCommandClose()
    redis.completeSubscription(0)
    await expect(
      bridge.reserveEditorLease(
        member,
        'dual-health-room',
        'command-still-down',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).rejects.toThrow('Redis collaboration relay is not healthy')

    redis.emitCommandReady()
    await expect(
      bridge.reserveEditorLease(
        member,
        'dual-health-room',
        'both-recovered',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).resolves.toMatchObject({ shouldBootstrap: true })
  })

  it('removes leases denied during command downtime before accepting recovered reservations', async () => {
    const redis = new FakeRedisNetwork()
    const bridge = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'deferred-cleanup-replica',
    )
    const member = connection('deferred-cleanup')
    const expiresAt = Date.now() + 60_000
    await bridge.reserveEditorLease(
      member,
      'deferred-cleanup-room',
      'old-request',
      expiresAt,
      COLLABORATION_PROTOCOL_VERSION,
      1,
    )
    expect(redis.leases.size).toBe(1)

    redis.emitCommandClose()
    expect(redis.leases.size).toBe(1)
    redis.emitCommandReady()

    await vi.waitFor(() => expect(redis.leases.size).toBe(0))
    await vi.waitFor(async () => {
      await expect(
        bridge.reserveEditorLease(
          member,
          'deferred-cleanup-room',
          'recovered-request',
          expiresAt,
          COLLABORATION_PROTOCOL_VERSION,
          1,
        ),
      ).resolves.toMatchObject({ shouldBootstrap: true })
    })
  })

  it('keeps command recovery closed while deferred lease cleanup fails and retries with bounded backoff', async () => {
    const redis = new FakeRedisNetwork()
    const bridge = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'cleanup-retry-replica',
    )
    const member = connection('cleanup-retry')
    const expiresAt = Date.now() + 60_000
    await bridge.reserveEditorLease(
      member,
      'cleanup-retry-room',
      'old-request',
      expiresAt,
      COLLABORATION_PROTOCOL_VERSION,
      1,
    )

    redis.emitCommandClose()
    redis.failEval = true
    redis.emitCommandReady()
    await vi.waitFor(() => expect(redis.failedEvalCalls).toBeGreaterThan(0))
    await expect(
      bridge.reserveEditorLease(
        member,
        'cleanup-retry-room',
        'cleanup-failed',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).rejects.toThrow('Redis collaboration relay is not healthy')

    redis.failEval = false
    await vi.waitFor(async () => {
      await expect(
        bridge.reserveEditorLease(
          member,
          'cleanup-retry-room',
          'cleanup-recovered',
          expiresAt,
          COLLABORATION_PROTOCOL_VERSION,
          1,
        ),
      ).resolves.toMatchObject({ shouldBootstrap: true })
    })
  })

  it.each(['releaseLease', 'releaseAll'] as const)(
    'retains a failed %s cleanup, blocks only that room, and retries automatically',
    async (operation) => {
      const redis = new FakeRedisNetwork()
      const bridge = new CollaborationRedisBridge(
        new RoomRegistry(),
        redis.client() as never,
        redis.client() as never,
        logger,
        `normal-${operation}-retry-replica`,
      )
      const member = connection(`normal-${operation}-retry`)
      const expiresAt = Date.now() + 60_000
      await bridge.reserveEditorLease(
        member,
        'normal-release-room',
        'old-request',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      )

      redis.failEval = true
      if (operation === 'releaseLease') {
        await bridge.releaseLease(member, 'normal-release-room', 'old-request')
      } else {
        await bridge.releaseAll(member)
      }
      redis.failEval = false

      await expect(
        bridge.reserveEditorLease(
          member,
          'normal-release-room',
          'blocked-until-clean',
          expiresAt,
          COLLABORATION_PROTOCOL_VERSION,
          1,
        ),
      ).rejects.toThrow('cleanup is pending for this room')
      await expect(
        bridge.reserveEditorLease(
          member,
          'unrelated-room',
          'unrelated-request',
          expiresAt,
          COLLABORATION_PROTOCOL_VERSION,
          1,
        ),
      ).resolves.toMatchObject({ shouldBootstrap: true })

      await vi.waitFor(async () => {
        await expect(
          bridge.reserveEditorLease(
            member,
            'normal-release-room',
            'recovered-request',
            expiresAt,
            COLLABORATION_PROTOCOL_VERSION,
            1,
          ),
        ).resolves.toMatchObject({ shouldBootstrap: true })
      })
    },
  )

  it('ignores late command and subscriber ready events after shutdown', async () => {
    const redis = new FakeRedisNetwork()
    const bridge = new CollaborationRedisBridge(
      new RoomRegistry(),
      redis.client() as never,
      redis.client() as never,
      logger,
      'stopped-replica',
    )
    const initialSubscriptionAttempts = redis.subscriptionCallbacks.length

    await bridge.stop()
    redis.emitCommandReady()
    redis.emitReady()

    expect(redis.subscriptionCallbacks).toHaveLength(initialSubscriptionAttempts)
  })

  it.each([
    ['error', (redis: FakeRedisNetwork) => redis.emitCommandError()],
    ['close', (redis: FakeRedisNetwork) => redis.emitCommandClose()],
    ['reconnecting', (redis: FakeRedisNetwork) => redis.emitCommandReconnecting()],
    ['end', (redis: FakeRedisNetwork) => redis.emitCommandEnd()],
  ])('immediately denies active rooms on command client %s', async (_event, disconnect) => {
    const redis = new FakeRedisNetwork()
    const rooms = new RoomRegistry<SendableSocket>()
    const member = connection(`command-lifecycle-${_event}`)
    const expiresAt = Date.now() + 60_000
    rooms.join('command-lifecycle-room', member, expiresAt, 'command-lifecycle-request')
    const bridge = new CollaborationRedisBridge(
      rooms,
      redis.client() as never,
      redis.client() as never,
      logger,
      `command-lifecycle-${_event}-replica`,
    )
    await bridge.reserveEditorLease(
      member,
      'command-lifecycle-room',
      'command-lifecycle-request',
      expiresAt,
      COLLABORATION_PROTOCOL_VERSION,
      1,
    )
    member.send.mockClear()

    disconnect(redis)

    expect(rooms.roomCount()).toBe(0)
    expect(member.send).toHaveBeenCalledWith(
      JSON.stringify({
        t: 'room-denied',
        room: 'command-lifecycle-room',
        requestId: 'command-lifecycle-request',
      }),
    )
    await expect(
      bridge.reserveEditorLease(
        member,
        'command-lifecycle-room',
        'after-command-disconnect',
        expiresAt,
        COLLABORATION_PROTOCOL_VERSION,
        1,
      ),
    ).rejects.toThrow('Redis collaboration relay is not healthy')
  })

  it('publishes only frames from an authorized live room member', async () => {
    const rooms = new RoomRegistry<SendableSocket>()
    const member = connection('member')
    const outsider = connection('outsider')
    const lifecycle: RoomRelayLifecycle<SendableSocket> = {
      reserveEditorLease: vi.fn().mockResolvedValue({ shouldBootstrap: false }),
      activateEditorLease: vi.fn().mockResolvedValue({ shouldBootstrap: false }),
      releaseLease: vi.fn().mockResolvedValue(undefined),
      publish: vi.fn().mockResolvedValue(undefined),
    }
    const authorize = () => ({
      authorized: true as const,
      expiresAt: Date.now() + 60_000,
      serverUpdatedAtTimestamp: 1,
      collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      leaseRequestId: 'lease-1',
    })

    await handleRelayFrame(
      rooms,
      member,
      {
        t: 'room-reserve',
        room: 'note-1',
        requestId: 'lease-1',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      },
      authorize,
      undefined,
      lifecycle,
    )
    await handleRelayFrame(
      rooms,
      member,
      {
        t: 'room-join',
        room: 'note-1',
        requestId: 'lease-1',
        role: 'editor',
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      },
      authorize,
      undefined,
      lifecycle,
    )
    expect(member.send).toHaveBeenCalledWith(
      JSON.stringify({
        t: 'room-joined',
        room: 'note-1',
        requestId: 'lease-1',
        bootstrap: false,
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      }),
    )
    expect(lifecycle.publish).not.toHaveBeenCalled()

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
