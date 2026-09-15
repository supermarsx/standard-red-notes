import { describe, expect, it, vi } from 'vitest'

import {
  InProcessCollaborationLifecycle,
  IN_PROCESS_ROOM_EPOCH_TOMBSTONE_TTL_MS,
} from '../src/inProcessCollaborationLifecycle.js'
import { CollaborationRoomSecurityRevokedError, YJS_RESPONSE_CLAIM_TTL_MS } from '../src/collaborationRedisBridge.js'
import { CollaborationRoomEpochMismatchError, RoomRegistry, type RoomRelayLifecycle } from '../src/rooms.js'
import type { Conn, SendableSocket } from '../src/registry.js'

const ROOM = 'note-uuid-1'
const EPOCH = 'room_epoch_00000001'
const OTHER_EPOCH = 'room_epoch_00000002'
const SECURITY_EPOCH = 'security_epoch_0001'
const NEXT_SECURITY_EPOCH = 'security_epoch_0002'
const HOUR_MS = 60 * 60 * 1_000

type FakeSocket = SendableSocket & { sent: string[] }

function socket(): FakeSocket {
  const sent: string[] = []
  return { sent, send: (data: string) => sent.push(data) }
}

function connection(id: string): Conn<FakeSocket> {
  return { socket: socket(), userUuid: `user-${id}`, sessionUuid: `session-${id}`, connectionId: id }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function setup(startAt = 1_700_000_000_000) {
  let current = startAt
  const now = (): number => current
  const advance = (milliseconds: number): void => {
    current += milliseconds
  }
  const rooms = new RoomRegistry<FakeSocket>(now)
  const logger = makeLogger()
  const lifecycle = new InProcessCollaborationLifecycle<FakeSocket>(rooms, logger, { now })
  return { lifecycle, rooms, logger, now, advance }
}

/** The normal, successful entry into a room: reserve then activate. */
async function enterRoom(
  lifecycle: InProcessCollaborationLifecycle<FakeSocket>,
  conn: Conn<FakeSocket>,
  now: () => number,
  requestId: string,
  roomEpoch = EPOCH,
  room = ROOM,
): Promise<{ shouldBootstrap: boolean }> {
  const reservation = await lifecycle.reserveEditorLease(
    conn,
    room,
    requestId,
    now() + 60_000,
    3,
    1,
    roomEpoch,
    SECURITY_EPOCH,
    now(),
  )
  return lifecycle.activateEditorLease(
    conn,
    room,
    requestId,
    now() + 60_000,
    3,
    1,
    reservation.bootstrapChallenge,
    roomEpoch,
    SECURITY_EPOCH,
    now(),
  )
}

describe('InProcessCollaborationLifecycle', () => {
  it('satisfies the RoomRelayLifecycle contract the relay handler drives', () => {
    const { lifecycle } = setup()
    const asLifecycle: RoomRelayLifecycle<FakeSocket> = lifecycle

    expect(typeof asLifecycle.reserveEditorLease).toBe('function')
    expect(typeof asLifecycle.activateEditorLease).toBe('function')
    expect(typeof asLifecycle.releaseLease).toBe('function')
    expect(typeof asLifecycle.claimYjsResponse).toBe('function')
    expect(typeof asLifecycle.publish).toBe('function')
    expect(lifecycle.isRelayHealthy()).toBe(true)
  })

  it('elects exactly one bootstrapper per room and rejects a replay under another epoch', async () => {
    const { lifecycle, now } = setup()
    const first = connection('conn-1')
    const second = connection('conn-2')

    const firstReservation = await lifecycle.reserveEditorLease(
      first,
      ROOM,
      'lease-1',
      now() + 60_000,
      3,
      1,
      EPOCH,
      SECURITY_EPOCH,
      now(),
    )
    expect(firstReservation.shouldBootstrap).toBe(true)
    expect(firstReservation.bootstrapChallenge).toEqual(expect.any(String))

    const secondReservation = await lifecycle.reserveEditorLease(
      second,
      ROOM,
      'lease-2',
      now() + 60_000,
      3,
      1,
      EPOCH,
      SECURITY_EPOCH,
      now(),
    )
    expect(secondReservation.shouldBootstrap).toBe(false)
    expect(secondReservation.bootstrapChallenge).toBeUndefined()

    // A replay of the same logical lease is idempotent...
    await expect(
      lifecycle.reserveEditorLease(first, ROOM, 'lease-1', now() + 60_000, 3, 1, EPOCH, SECURITY_EPOCH, now()),
    ).resolves.toMatchObject({ shouldBootstrap: true })
    // ...but the same lease under a different epoch is a mismatch, not a grant.
    await expect(
      lifecycle.reserveEditorLease(first, ROOM, 'lease-1', now() + 60_000, 3, 1, OTHER_EPOCH, SECURITY_EPOCH, now()),
    ).rejects.toBeInstanceOf(CollaborationRoomEpochMismatchError)
  })

  it('activates only against the exact bootstrap challenge', async () => {
    const { lifecycle, now } = setup()
    const conn = connection('conn-1')
    const reservation = await lifecycle.reserveEditorLease(
      conn,
      ROOM,
      'lease-1',
      now() + 60_000,
      3,
      1,
      EPOCH,
      SECURITY_EPOCH,
      now(),
    )

    await expect(
      lifecycle.activateEditorLease(
        conn,
        ROOM,
        'lease-1',
        now() + 60_000,
        3,
        1,
        'not-the-challenge',
        EPOCH,
        SECURITY_EPOCH,
        now(),
      ),
    ).rejects.toMatchObject({ code: 'incompatible-protocol' })

    await expect(
      lifecycle.activateEditorLease(
        conn,
        ROOM,
        'lease-1',
        now() + 60_000,
        3,
        1,
        reservation.bootstrapChallenge,
        EPOCH,
        SECURITY_EPOCH,
        now(),
      ),
    ).resolves.toEqual({ shouldBootstrap: true })
  })

  it('rotates the epoch when the last editor releases and answers discovery with it (C4)', async () => {
    const { lifecycle, now } = setup()
    const first = connection('conn-1')
    const second = connection('conn-2')

    await enterRoom(lifecycle, first, now, 'lease-1')
    await enterRoom(lifecycle, second, now, 'lease-2')

    // While another editor still holds the room, nothing rotates.
    await lifecycle.releaseLease(first, ROOM, 'lease-1', 'clean-leave')
    await expect(lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)).resolves.toBe(EPOCH)

    await lifecycle.releaseLease(second, ROOM, 'lease-2', 'clean-leave')
    const rotated = await lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)
    expect(rotated).toEqual(expect.any(String))
    expect(rotated).not.toBe(EPOCH)

    // A grant bound to the old epoch is refused, and the refusal carries the
    // current one so sync-lane discovery can substitute it.
    await expect(
      lifecycle.reserveEditorLease(first, ROOM, 'lease-3', now() + 60_000, 3, 1, EPOCH, SECURITY_EPOCH, now()),
    ).rejects.toMatchObject({ code: 'epoch-mismatch', currentRoomEpoch: rotated })

    // The rotated epoch re-opens the room, and its holder bootstraps again.
    await expect(
      lifecycle.reserveEditorLease(first, ROOM, 'lease-4', now() + 60_000, 3, 1, rotated!, SECURITY_EPOCH, now()),
    ).resolves.toMatchObject({ shouldBootstrap: true })

    // Another security generation does not read this one's epoch.
    await expect(lifecycle.currentRoomEpoch(ROOM, NEXT_SECURITY_EPOCH)).resolves.toBeUndefined()
    await expect(lifecycle.currentRoomEpoch('', SECURITY_EPOCH)).resolves.toBeUndefined()
    await expect(lifecycle.currentRoomEpoch(ROOM, 'short')).resolves.toBeUndefined()
  })

  it('M1: a denied reserve does not extend the room-epoch tombstone (epoch mismatch)', async () => {
    const { lifecycle, now, advance } = setup()
    const conn = connection('conn-1')

    await enterRoom(lifecycle, conn, now, 'lease-1')
    await lifecycle.releaseLease(conn, ROOM, 'lease-1', 'clean-leave')
    const rotated = await lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)
    expect(rotated).not.toBe(EPOCH)

    // A client that still holds the old grant retries for most of the day.
    // Every one of these is denied; NONE of them may re-arm the tombstone.
    let elapsed = 0
    for (const hour of [1, 6, 12, 23]) {
      advance(hour * HOUR_MS - elapsed)
      elapsed = hour * HOUR_MS
      await expect(
        lifecycle.reserveEditorLease(conn, ROOM, `retry-${hour}`, now() + 60_000, 3, 1, EPOCH, SECURITY_EPOCH, now()),
      ).rejects.toMatchObject({ code: 'epoch-mismatch' })
    }

    // Just before the tombstone elapses it is still in force...
    advance(IN_PROCESS_ROOM_EPOCH_TOMBSTONE_TTL_MS - elapsed - 1)
    await expect(lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)).resolves.toBe(rotated)

    // ...and one millisecond later the room is free again, 24 h after the
    // RELEASE rather than 24 h after the last denial.
    advance(2)
    await expect(lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)).resolves.toBeUndefined()
    await expect(
      lifecycle.reserveEditorLease(conn, ROOM, 'lease-after', now() + 60_000, 3, 1, EPOCH, SECURITY_EPOCH, now()),
    ).resolves.toMatchObject({ shouldBootstrap: true })
  })

  /**
   * The SECOND denial return, which the epoch-mismatch test above cannot reach.
   * A reserve carrying another security generation with an authorization no
   * NEWER than the room's is refused rather than allowed to rotate the room --
   * and that refusal, like the other one, must leave the tombstone's expiry
   * exactly where the release put it. Without this case the security branch is
   * unguarded: the code is right, but a future edit could re-arm the tombstone
   * there and every other test would stay green.
   */
  it('M1: a denied reserve does not extend the room-epoch tombstone (stale security generation)', async () => {
    const { lifecycle, now, advance } = setup()
    const conn = connection('conn-1')
    const authorizedAt = now()

    await enterRoom(lifecycle, conn, now, 'lease-1')
    await lifecycle.releaseLease(conn, ROOM, 'lease-1', 'clean-leave')
    const rotated = await lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)
    expect(rotated).not.toBe(EPOCH)

    // A client holding a grant from ANOTHER security generation, issued no
    // later than the one the room recorded, retries for most of the day. Every
    // one of these is refused without rotating; NONE may re-arm the tombstone.
    let elapsed = 0
    for (const hour of [1, 6, 12, 23]) {
      advance(hour * HOUR_MS - elapsed)
      elapsed = hour * HOUR_MS
      await expect(
        lifecycle.reserveEditorLease(
          conn,
          ROOM,
          `stale-security-${hour}`,
          now() + 60_000,
          3,
          1,
          EPOCH,
          NEXT_SECURITY_EPOCH,
          authorizedAt,
        ),
      ).rejects.toMatchObject({ code: 'epoch-mismatch', currentRoomEpoch: rotated })
      // Nothing rotated: a refused reserve leaves the room's generation alone.
      await expect(lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)).resolves.toBe(rotated)
    }

    // Just before the tombstone elapses it is still in force...
    advance(IN_PROCESS_ROOM_EPOCH_TOMBSTONE_TTL_MS - elapsed - 1)
    await expect(lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)).resolves.toBe(rotated)

    // ...and one millisecond later the room is free again, 24 h after the
    // RELEASE rather than 24 h after the last denial.
    advance(2)
    await expect(lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)).resolves.toBeUndefined()
    await expect(
      lifecycle.reserveEditorLease(conn, ROOM, 'lease-after', now() + 60_000, 3, 1, EPOCH, SECURITY_EPOCH, now()),
    ).resolves.toMatchObject({ shouldBootstrap: true })
  })

  it('rotates for a newer security generation and refuses an older one', async () => {
    const { lifecycle, rooms, now } = setup()
    const denyRoom = vi.spyOn(rooms, 'denyRoom')
    const holder = connection('conn-1')
    await enterRoom(lifecycle, holder, now, 'lease-1')

    // An older authorization under a different security epoch proves nothing.
    await expect(
      lifecycle.reserveEditorLease(
        connection('conn-2'),
        ROOM,
        'stale-security',
        now() + 60_000,
        3,
        1,
        EPOCH,
        NEXT_SECURITY_EPOCH,
        now() - 1,
      ),
    ).rejects.toBeInstanceOf(CollaborationRoomEpochMismatchError)
    expect(denyRoom).not.toHaveBeenCalled()

    // A NEWER one revokes the room: every holder is evicted and the epoch
    // rotates to a value no existing grant names.
    await expect(
      lifecycle.reserveEditorLease(
        connection('conn-3'),
        ROOM,
        'fresh-security',
        now() + 60_000,
        3,
        1,
        EPOCH,
        NEXT_SECURITY_EPOCH,
        now() + 1,
      ),
    ).rejects.toBeInstanceOf(CollaborationRoomSecurityRevokedError)
    expect(denyRoom).toHaveBeenCalledWith(ROOM, 'security-revoked')
    await expect(lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)).resolves.toBeUndefined()
    await expect(lifecycle.currentRoomEpoch(ROOM, NEXT_SECURITY_EPOCH)).resolves.toEqual(expect.any(String))
  })

  it('refuses reservations with invalid or elapsed inputs', async () => {
    const { lifecycle, now } = setup()
    const conn = connection('conn-1')

    for (const invalid of [
      [now() - 1, 3, 1, EPOCH, SECURITY_EPOCH, now()],
      [now() + 60_000, 3, -1, EPOCH, SECURITY_EPOCH, now()],
      [now() + 60_000, 3, 1, 'no', SECURITY_EPOCH, now()],
      [now() + 60_000, 3, 1, EPOCH, 'no', now()],
      [now() + 60_000, 3, 1, EPOCH, SECURITY_EPOCH, 0],
    ] as const) {
      await expect(
        lifecycle.reserveEditorLease(
          conn,
          ROOM,
          'lease-invalid',
          invalid[0] as number,
          invalid[1] as 3,
          invalid[2] as number,
          invalid[3] as string,
          invalid[4] as string,
          invalid[5] as number,
        ),
      ).rejects.toMatchObject({ code: 'reservation-expired' })
    }
  })

  it('caps the editor leases one room may hold', async () => {
    const { lifecycle, now } = setup()
    for (let index = 0; index < 64; index += 1) {
      await lifecycle.reserveEditorLease(
        connection(`conn-${index}`),
        ROOM,
        `lease-${index}`,
        now() + 60_000,
        3,
        1,
        EPOCH,
        SECURITY_EPOCH,
        now(),
      )
    }

    await expect(
      lifecycle.reserveEditorLease(
        connection('conn-overflow'),
        ROOM,
        'lease-overflow',
        now() + 60_000,
        3,
        1,
        EPOCH,
        SECURITY_EPOCH,
        now(),
      ),
    ).rejects.toMatchObject({ code: 'room-limit' })
  })

  it('answers the C2 responder question from local leases alone', async () => {
    const { lifecycle, now } = setup()
    const first = connection('conn-1')
    const second = connection('conn-2')

    await enterRoom(lifecycle, first, now, 'lease-1')
    // Its own activated lease is not another responder.
    await expect(lifecycle.hasOtherActivatedEditorLease(first, ROOM)).resolves.toBe(false)

    // A merely RESERVED peer cannot answer a full-state retry either.
    await lifecycle.reserveEditorLease(second, ROOM, 'lease-2', now() + 60_000, 3, 1, EPOCH, SECURITY_EPOCH, now())
    await expect(lifecycle.hasOtherActivatedEditorLease(first, ROOM)).resolves.toBe(false)

    await lifecycle.activateEditorLease(
      second,
      ROOM,
      'lease-2',
      now() + 60_000,
      3,
      1,
      undefined,
      EPOCH,
      SECURITY_EPOCH,
      now(),
    )
    await expect(lifecycle.hasOtherActivatedEditorLease(first, ROOM)).resolves.toBe(true)
    await expect(lifecycle.hasOtherActivatedEditorLease(second, 'another-room')).resolves.toBe(false)
  })

  it('grants one Yjs responder per state request until the claim expires', async () => {
    const { lifecycle, now, advance } = setup()
    const first = connection('conn-1')
    const second = connection('conn-2')
    await enterRoom(lifecycle, first, now, 'lease-1')
    await enterRoom(lifecycle, second, now, 'lease-2')

    const granted = await lifecycle.claimYjsResponse(first, ROOM, 'state-request-1', 'lease-1')
    expect(granted).toBe(now() + YJS_RESPONSE_CLAIM_TTL_MS)
    await expect(lifecycle.claimYjsResponse(second, ROOM, 'state-request-1', 'lease-2')).resolves.toBeUndefined()
    // A different request is a different claim.
    await expect(lifecycle.claimYjsResponse(second, ROOM, 'state-request-2', 'lease-2')).resolves.toEqual(
      expect.any(Number),
    )

    advance(YJS_RESPONSE_CLAIM_TTL_MS + 1)
    await expect(lifecycle.claimYjsResponse(second, ROOM, 'state-request-1', 'lease-2')).resolves.toEqual(
      expect.any(Number),
    )

    // An unknown or unactivated lease never claims.
    await expect(lifecycle.claimYjsResponse(first, ROOM, 'state-request-3', 'no-such-lease')).resolves.toBeUndefined()
  })

  it('broadcasts presence join and leave to the room without a relay', async () => {
    const { lifecycle, rooms, now } = setup()
    const broadcast = vi.spyOn(rooms, 'broadcastAll').mockReturnValue(1)
    const conn = connection('conn-1')
    await enterRoom(lifecycle, conn, now, 'lease-1')

    await lifecycle.heartbeatPresence(conn, ROOM, 'lease-1', EPOCH, 42)
    expect(JSON.parse(broadcast.mock.calls.at(-1)![1])).toMatchObject({
      t: 'room-presence',
      room: ROOM,
      action: 'joined',
      clientId: 42,
      userUuid: 'user-conn-1',
    })

    // A repeat heartbeat refreshes rather than re-announcing.
    await lifecycle.heartbeatPresence(conn, ROOM, 'lease-1', EPOCH, 42)
    expect(broadcast).toHaveBeenCalledTimes(1)

    // The same lease may not change its client identity mid-flight.
    await expect(lifecycle.heartbeatPresence(conn, ROOM, 'lease-1', EPOCH, 43)).rejects.toMatchObject({
      code: 'incompatible-protocol',
    })

    await lifecycle.releaseLease(conn, ROOM, 'lease-1', 'clean-leave')
    expect(JSON.parse(broadcast.mock.calls.at(-1)![1])).toMatchObject({
      t: 'room-presence',
      action: 'left',
      reason: 'clean-leave',
    })

    // Presence requires a live activated lease under the room's epoch.
    await expect(lifecycle.heartbeatPresence(conn, ROOM, 'lease-1', EPOCH, 42)).rejects.toBeInstanceOf(
      CollaborationRoomEpochMismatchError,
    )
  })

  it('evicts elapsed leases on the heartbeat sweep and rotates the room', async () => {
    const { lifecycle, now, advance } = setup()
    const conn = connection('conn-1')
    await enterRoom(lifecycle, conn, now, 'lease-1')

    advance(120_000)
    await lifecycle.refreshLeases()

    const rotated = await lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)
    expect(rotated).not.toBe(EPOCH)
    // The lease is gone, so a claim against it no longer answers.
    await expect(lifecycle.claimYjsResponse(conn, ROOM, 'state-request-1', 'lease-1')).resolves.toBeUndefined()
  })

  it('keeps a live lease across the heartbeat sweep', async () => {
    const { lifecycle, now, advance } = setup()
    const conn = connection('conn-1')
    await enterRoom(lifecycle, conn, now, 'lease-1')

    advance(1_000)
    await lifecycle.refreshLeases()

    await expect(lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)).resolves.toBe(EPOCH)
    await expect(lifecycle.hasOtherActivatedEditorLease(connection('conn-2'), ROOM)).resolves.toBe(true)
  })

  it('releases every lease a closing connection holds', async () => {
    const { lifecycle, now } = setup()
    const conn = connection('conn-1')
    await enterRoom(lifecycle, conn, now, 'lease-1')
    await enterRoom(lifecycle, conn, now, 'lease-2', EPOCH, 'second-room')

    await lifecycle.releaseAll(conn)

    expect(await lifecycle.currentRoomEpoch(ROOM, SECURITY_EPOCH)).not.toBe(EPOCH)
    expect(await lifecycle.currentRoomEpoch('second-room', SECURITY_EPOCH)).not.toBe(EPOCH)
    // Releasing an unknown lease is a no-op, not a throw.
    await expect(lifecycle.releaseLease(conn, ROOM, 'never-reserved')).resolves.toBeUndefined()
  })

  it('publishes nothing while attached and denies everything once stopped', async () => {
    const { lifecycle, rooms, now } = setup()
    const denyAll = vi.spyOn(rooms, 'denyAllRooms')
    const conn = connection('conn-1')
    await enterRoom(lifecycle, conn, now, 'lease-1')

    // The local broadcast already happened in handleRelayFrame; there is
    // nothing to relay, and the caller's ordered chain must not see an error.
    await expect(lifecycle.publish({ t: 'room-sync', room: ROOM })).resolves.toBeUndefined()

    await lifecycle.stop()
    expect(lifecycle.isRelayHealthy()).toBe(false)
    expect(denyAll).toHaveBeenCalledWith('relay-unhealthy')
    await expect(lifecycle.publish({ t: 'room-sync', room: ROOM })).rejects.toMatchObject({ code: 'relay-unhealthy' })
    await expect(
      lifecycle.reserveEditorLease(conn, ROOM, 'lease-2', now() + 60_000, 3, 1, EPOCH, SECURITY_EPOCH, now()),
    ).rejects.toMatchObject({ code: 'relay-unhealthy' })
    await expect(
      lifecycle.activateEditorLease(conn, ROOM, 'lease-1', now() + 60_000, 3, 1, undefined, EPOCH, SECURITY_EPOCH),
    ).rejects.toMatchObject({ code: 'relay-unhealthy' })
    await expect(lifecycle.heartbeatPresence(conn, ROOM, 'lease-1', EPOCH, 1)).rejects.toMatchObject({
      code: 'relay-unhealthy',
    })
    await expect(lifecycle.claimYjsResponse(conn, ROOM, 'state-request-1', 'lease-1')).rejects.toMatchObject({
      code: 'relay-unhealthy',
    })
    // Stopping twice is idempotent.
    await expect(lifecycle.stop()).resolves.toBeUndefined()
  })

  it('logs a denial with its cause code and nothing else', async () => {
    const { lifecycle, logger, now } = setup()
    const conn = connection('conn-1')
    await enterRoom(lifecycle, conn, now, 'lease-1')
    await lifecycle.releaseLease(conn, ROOM, 'lease-1', 'clean-leave')

    await expect(
      lifecycle.reserveEditorLease(conn, ROOM, 'lease-2', now() + 60_000, 3, 1, EPOCH, SECURITY_EPOCH, now()),
    ).rejects.toBeInstanceOf(CollaborationRoomEpochMismatchError)

    expect(logger.warn).toHaveBeenCalledWith('[collab-local] lease reservation denied {"cause":"epoch-mismatch"}', {
      cause: 'epoch-mismatch',
    })
  })
})
