import { createHash, randomUUID } from 'node:crypto'

import { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  startCollaborationRedisBridge,
  type CollaborationRedisBridge,
} from '../src/collaborationRedisBridge.js'
import type { Conn, SendableSocket } from '../src/registry.js'
import { COLLABORATION_PROTOCOL_VERSION, CollaborationRoomEpochMismatchError, RoomRegistry } from '../src/rooms.js'

// Behaviour, not source text.
//
// The existing M1 guard in `collaborationRedisBridge.test.ts` reads the Lua the
// bridge hands to EVAL and asserts on its LINES: one `PEXPIRE KEYS[3]`, no
// PEXPIRE within three lines above either `return 'epoch:'`. That pins the
// current phrasing, not the behaviour — a rewrite that re-arms the tombstone by
// some other shape (a `SET ... KEEPTTL` swapped for a plain `SET`, an earlier
// refresh hoisted above the epoch check, a helper function) reads clean and
// still re-arms. The original defect cost a room in daily use its recovery for
// 24 h at a time, so the thing worth pinning is the observable TTL.
//
// Runtime evidence from the Wave-1 probe against a real Redis:
//   before the fix   PTTL 59998 -> 86399997   (a DENIED reserve re-armed 24 h)
//   after the fix    PTTL 59998 ->    59994   (only the clock moved)
//
// This suite reproduces exactly that, through the real bridge against a real
// Redis server. It cannot run on the plain unit-test job, which has no Redis,
// so it is OPT-IN and SKIPPED by default. Nothing in CI runs it today — see
// `docs/validation.md`. To run it:
//
//   docker run --rm -d --name t92-w3e2-redis -p 6396:6379 redis:8-alpine
//   SRN_COLLAB_REDIS_HOST=127.0.0.1 SRN_COLLAB_REDIS_PORT=6396 \
//     yarn workspace @standard-red-notes/websocket-gateway vitest run \
//     test/collaborationTombstone.redis.test.ts
//   docker rm -f t92-w3e2-redis
const REDIS_HOST = process.env.SRN_COLLAB_REDIS_HOST
const REDIS_PORT = Number.parseInt(process.env.SRN_COLLAB_REDIS_PORT ?? '6379', 10)
const ENABLED = typeof REDIS_HOST === 'string' && REDIS_HOST.length > 0 && Number.isSafeInteger(REDIS_PORT)

const ROOM_EPOCH_TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1_000
// The probe's starting point: a tombstone that has already been counting down.
const SHRUNK_TOMBSTONE_MS = 60_000

const ROOM_EPOCH = 'room_epoch_0000000000000001'
const STALE_ROOM_EPOCH = 'room_epoch_0000000000000000'
const SECURITY_EPOCH = 'security_epoch_0000000000000001'

function connection(id: string): Conn<SendableSocket> {
  const send = vi.fn()
  return {
    socket: { send },
    send,
    userUuid: `user-${id}`,
    sessionUuid: `session-${id}`,
    connectionId: `connection-${id}`,
  }
}

async function until(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe.skipIf(!ENABLED)('collaboration tombstone against a real Redis (opt-in: SRN_COLLAB_REDIS_HOST)', () => {
  // A per-run namespace, so the suite can never disturb a real deployment's
  // keys and so teardown is a single prefix sweep.
  const keyPrefix = `t92-w3e2-${randomUUID().replace(/-/g, '')}`
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const rooms = new RoomRegistry<SendableSocket>()
  let bridge: CollaborationRedisBridge<SendableSocket>
  let probe: Redis

  const roomStateKey = (room: string): string =>
    `${keyPrefix}:srn:collaboration:room-state:${createHash('sha256').update(room, 'utf8').digest('hex')}`

  const reserve = (conn: Conn<SendableSocket>, room: string, requestId: string, roomEpoch: string): Promise<unknown> =>
    bridge.reserveEditorLease(
      conn,
      room,
      requestId,
      Date.now() + 60_000,
      COLLABORATION_PROTOCOL_VERSION,
      1,
      roomEpoch,
      SECURITY_EPOCH,
      1_000,
    )

  beforeAll(async () => {
    probe = new Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true, maxRetriesPerRequest: 1 })
    await probe.connect()
    bridge = startCollaborationRedisBridge<SendableSocket>(rooms, {
      host: REDIS_HOST as string,
      port: REDIS_PORT,
      logger,
      keyPrefix,
    })
    await until(() => bridge.isRelayHealthy(), 'the collaboration relay to report healthy')
  }, 30_000)

  afterAll(async () => {
    await bridge?.stop()
    if (probe) {
      const keys = await probe.keys(`${keyPrefix}:*`)
      if (keys.length > 0) {
        await probe.del(...keys)
      }
      await probe.quit()
    }
  })

  it('M1: a DENIED reserve does not extend the room-state tombstone, while a granted one re-arms it', async () => {
    const room = `tombstone-room-${randomUUID()}`
    const stateKey = roomStateKey(room)
    const holder = connection('holder')

    // A granted reserve arms the tombstone for the full 24 h.
    const reservation = (await reserve(holder, room, 'lease-holder', ROOM_EPOCH)) as { bootstrapChallenge?: string }
    await bridge.activateEditorLease(
      holder,
      room,
      'lease-holder',
      Date.now() + 60_000,
      COLLABORATION_PROTOCOL_VERSION,
      1,
      reservation.bootstrapChallenge,
      ROOM_EPOCH,
      SECURITY_EPOCH,
      1_000,
    )
    const armed = await probe.pttl(stateKey)
    expect(armed).toBeGreaterThan(ROOM_EPOCH_TOMBSTONE_TTL_MS - 10_000)
    expect(armed).toBeLessThanOrEqual(ROOM_EPOCH_TOMBSTONE_TTL_MS)

    // Wind it down to a minute, exactly as the probe did: this is a room whose
    // lock-out is nearly over and which must be allowed to recover.
    await probe.pexpire(stateKey, SHRUNK_TOMBSTONE_MS)
    const beforeDenial = await probe.pttl(stateKey)
    expect(beforeDenial).toBeLessThanOrEqual(SHRUNK_TOMBSTONE_MS)
    expect(beforeDenial).toBeGreaterThan(0)

    // A second session dials in with the epoch it discovered BEFORE the
    // rotation. This is the retry a client makes on every reconnect.
    await expect(reserve(connection('stale'), room, 'lease-stale', STALE_ROOM_EPOCH)).rejects.toBeInstanceOf(
      CollaborationRoomEpochMismatchError,
    )

    const afterDenial = await probe.pttl(stateKey)
    // The only movement allowed is the clock. Before the fix this read
    // 86 399 997 and the room never recovered while anyone kept retrying.
    expect(afterDenial).toBeLessThanOrEqual(beforeDenial)
    expect(afterDenial).toBeGreaterThan(0)

    // Repeating the denial is what actually re-armed the lock-out daily, so
    // prove the TTL keeps falling across several stale attempts.
    await expect(reserve(connection('stale-2'), room, 'lease-stale-2', STALE_ROOM_EPOCH)).rejects.toBeInstanceOf(
      CollaborationRoomEpochMismatchError,
    )
    expect(await probe.pttl(stateKey)).toBeLessThanOrEqual(afterDenial)

    // Positive control. Without it this test would still pass if the refresh
    // were deleted outright rather than merely moved off the denial path, and
    // the suite would be pinning "never re-arm" — which is a different bug.
    const joiner = connection('joiner')
    const granted = (await reserve(joiner, room, 'lease-joiner', ROOM_EPOCH)) as { bootstrapChallenge?: string }
    await bridge.activateEditorLease(
      joiner,
      room,
      'lease-joiner',
      Date.now() + 60_000,
      COLLABORATION_PROTOCOL_VERSION,
      1,
      granted.bootstrapChallenge,
      ROOM_EPOCH,
      SECURITY_EPOCH,
      1_000,
    )
    expect(await probe.pttl(stateKey)).toBeGreaterThan(ROOM_EPOCH_TOMBSTONE_TTL_MS - 10_000)
  }, 30_000)
})
