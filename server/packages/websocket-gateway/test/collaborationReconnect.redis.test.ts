import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import { describe, expect, it, vi } from 'vitest'
import { CollaborationRedisBridge } from '../src/collaborationRedisBridge.js'
import { CollaborationRoomEpochMismatchError, RoomRegistry } from '../src/rooms.js'
import type { Conn, SendableSocket } from '../src/registry.js'

// Opt in against an isolated Redis. Uses actual Lua, including TTL and marker parsing.
describe.skipIf(!process.env.SRN_REDIS_TEST_URL)('Redis reconnect lineage contract', () => {
  it('detaches authority, preserves lineage across replicas, and rotates on natural expiry', async () => {
    const redis = new Redis(process.env.SRN_REDIS_TEST_URL!)
    const prefix = `reconnect-test-${randomUUID()}:`
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const bridges = [0, 1].map(
      () =>
        new CollaborationRedisBridge(
          new RoomRegistry(),
          new Redis(process.env.SRN_REDIS_TEST_URL!),
          new Redis(process.env.SRN_REDIS_TEST_URL!),
          log,
          randomUUID(),
          { keyPrefix: prefix },
        ),
    )
    const [a, b] = bridges as [CollaborationRedisBridge<SendableSocket>, CollaborationRedisBridge<SendableSocket>]
    const conn = (id: string): Conn<SendableSocket> => ({
      socket: { send: vi.fn() },
      connectionId: id,
      userUuid: id,
      sessionUuid: id,
    })
    const owner = conn('owner')
    const peer = conn('peer')
    const epoch = 'room_epoch_0000000001'
    const security = 'security_epoch_000001'
    const expiresAt = Date.now() + 60_000
    const issuedAt = Date.now()
    const reserve = (
      bridge: typeof a,
      client: Conn<SendableSocket>,
      request: string,
      roomEpoch = epoch,
      authTime = issuedAt,
    ) => bridge.reserveEditorLease(client, 'room', request, expiresAt, 3, 1, roomEpoch, security, authTime)
    try {
      await vi.waitFor(() => expect(bridges.every((bridge) => bridge.isRelayHealthy())).toBe(true))
      const first = await reserve(a, owner, 'first')
      await a.activateEditorLease(
        owner,
        'room',
        'first',
        expiresAt,
        3,
        1,
        first.bootstrapChallenge,
        epoch,
        security,
        issuedAt,
      )
      await a.releaseAll(owner, true)
      const keys = await redis.keys(`${prefix}*`)
      const leaseKey = (await Promise.all(keys.map(async (key) => [key, await redis.type(key)] as const)))
        .filter(([, type]) => type === 'string')
        .map(([key]) => key)
      const detachedKey = (await Promise.all(leaseKey.map(async (key) => [key, await redis.get(key)] as const))).find(
        ([, value]) => value?.endsWith(':detached'),
      )![0]
      expect(await redis.pttl(detachedKey)).toBeGreaterThan(0)
      expect(await redis.pttl(detachedKey)).toBeLessThanOrEqual(30_000)
      await expect(b.hasOtherActivatedEditorLease(peer, 'room')).resolves.toBe(false)
      await expect(reserve(b, peer, 'newcomer', epoch, issuedAt - 1)).resolves.toMatchObject({ shouldBootstrap: false })
      // Older same-generation grants cannot lower the revocation watermark.
      const stateKey = keys.find((key) => key.includes('room-state:'))!
      expect(await redis.get(stateKey)).toBe(`${epoch}:${security}:${issuedAt}:initialized`)
      await b.releaseAll(peer)
      const returned = conn('owner-returned')
      await expect(reserve(b, returned, 'resume')).resolves.toMatchObject({ shouldBootstrap: false })
      await b.releaseAll(returned)
      await redis.pexpire(detachedKey, 1)
      await vi.waitFor(async () => expect(await redis.exists(detachedKey)).toBe(0))
      await expect(reserve(b, peer, 'fresh')).rejects.toBeInstanceOf(CollaborationRoomEpochMismatchError)
      const freshEpoch = await b.currentRoomEpoch('room', security)
      expect(freshEpoch).not.toBe(epoch)
      await expect(reserve(b, peer, 'fresh', freshEpoch!)).resolves.toMatchObject({ shouldBootstrap: true })
    } finally {
      await Promise.all(bridges.map((bridge) => bridge.stop()))
      const keys = await redis.keys(`${prefix}*`)
      if (keys.length) {
        await redis.del(...keys)
      }
      await redis.quit()
    }
  })
})
