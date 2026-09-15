import type { CollabFrame } from './CollabChannel'
import {
  EphemeralRoomPresence,
  PRESENCE_REJOIN_GRACE_MS,
  type EncryptedAwarenessIdentity,
} from './EphemeralRoomPresence'

const room = 'presence-note'
const roomEpoch = 'room_epoch_0000000000000001'
const remoteClientId = 41

const joinedFrame = (
  overrides: Partial<Extract<CollabFrame, { t: 'room-presence'; action: 'joined' }>> = {},
): Extract<CollabFrame, { t: 'room-presence'; action: 'joined' }> => ({
  t: 'room-presence',
  room,
  roomEpoch,
  protocolVersion: 3,
  action: 'joined',
  presenceId: 'presence-1',
  userUuid: 'user-1',
  clientId: remoteClientId,
  ttlMilliseconds: 30_000,
  ...overrides,
})

const leftFrame = (
  overrides: Partial<Extract<CollabFrame, { t: 'room-presence'; action: 'left' }>> = {},
): Extract<CollabFrame, { t: 'room-presence'; action: 'left' }> => ({
  t: 'room-presence',
  room,
  roomEpoch,
  protocolVersion: 3,
  action: 'left',
  presenceId: 'presence-1',
  clientId: remoteClientId,
  userUuid: 'user-1',
  reason: 'clean-leave',
  ...overrides,
})

describe('EphemeralRoomPresence', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it('emits one encrypted-awareness-labeled join and one TTL leave across duplicate heartbeat refreshes', () => {
    let now = 0
    const identities = new Map<number, EncryptedAwarenessIdentity>()
    const activities = jest.fn()
    const terminal = jest.fn()
    const presence = new EphemeralRoomPresence({
      room,
      roomEpoch,
      localClientId: 7,
      resolveEncryptedAwarenessIdentity: (clientId) => identities.get(clientId),
      onActivity: activities,
      onTerminalClient: terminal,
      now: () => now,
    })

    expect(presence.accept(joinedFrame())).toBe(true)
    expect(activities).not.toHaveBeenCalled()

    identities.set(remoteClientId, { userUuid: 'user-1', label: '  Alice  ' })
    presence.reconcileEncryptedAwareness()
    expect(activities).toHaveBeenCalledTimes(1)
    expect(activities).toHaveBeenLastCalledWith({
      action: 'joined',
      presenceId: 'presence-1',
      userUuid: 'user-1',
      clientId: remoteClientId,
      label: 'Alice',
    })

    now += 10_000
    jest.advanceTimersByTime(10_000)
    expect(presence.accept(joinedFrame())).toBe(true)
    presence.reconcileEncryptedAwareness()
    expect(activities).toHaveBeenCalledTimes(1)

    now += 29_999
    jest.advanceTimersByTime(29_999)
    expect(presence.size).toBe(1)
    now += 1
    jest.advanceTimersByTime(1)

    expect(presence.size).toBe(0)
    expect(terminal).toHaveBeenCalledTimes(1)
    expect(terminal).toHaveBeenCalledWith(remoteClientId, 'heartbeat-timeout')
    // R31: the editor teardown is immediate, but the notice waits out the rejoin window.
    expect(activities).toHaveBeenCalledTimes(1)

    now += PRESENCE_REJOIN_GRACE_MS
    jest.advanceTimersByTime(PRESENCE_REJOIN_GRACE_MS)
    expect(activities).toHaveBeenCalledTimes(2)
    expect(activities).toHaveBeenLastCalledWith({
      action: 'left',
      presenceId: 'presence-1',
      userUuid: 'user-1',
      clientId: remoteClientId,
      label: 'Alice',
      reason: 'heartbeat-timeout',
    })
    expect(presence.accept(leftFrame({ reason: 'heartbeat-timeout' }))).toBe(false)
    expect(activities).toHaveBeenCalledTimes(2)
  })

  it('says nothing at all when a timed-out collaborator rejoins inside the grace window', () => {
    // R31. A backgrounded tab misses heartbeats and comes straight back; "Alice left" followed
    // by "Alice joined" describes our transport, not anything Alice did.
    let now = 0
    const identities = new Map<number, EncryptedAwarenessIdentity>([
      [remoteClientId, { userUuid: 'user-1', label: 'Alice' }],
    ])
    const activities = jest.fn()
    const presence = new EphemeralRoomPresence({
      room,
      roomEpoch,
      localClientId: 7,
      resolveEncryptedAwarenessIdentity: (clientId) => identities.get(clientId),
      onActivity: activities,
      now: () => now,
    })

    expect(presence.accept(joinedFrame())).toBe(true)
    expect(activities).toHaveBeenCalledTimes(1)
    expect(activities).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'joined', label: 'Alice' }))

    now += 30_000
    jest.advanceTimersByTime(30_000)
    expect(presence.size).toBe(0)
    expect(activities).toHaveBeenCalledTimes(1)

    // The same user returns on a fresh presence id and client id, as a reconnect does.
    now += PRESENCE_REJOIN_GRACE_MS - 1
    jest.advanceTimersByTime(PRESENCE_REJOIN_GRACE_MS - 1)
    identities.set(51, { userUuid: 'user-1', label: 'Alice' })
    expect(presence.accept(joinedFrame({ presenceId: 'presence-2', clientId: 51 }))).toBe(true)
    presence.reconcileEncryptedAwareness()

    // Ride out more than the whole grace window on ordinary heartbeat refreshes: the
    // withheld departure was cancelled, not merely deferred.
    for (let step = 0; step < 6; step += 1) {
      now += 20_000
      jest.advanceTimersByTime(20_000)
      expect(presence.accept(joinedFrame({ presenceId: 'presence-2', clientId: 51 }))).toBe(true)
    }
    expect(activities).toHaveBeenCalledTimes(1)
    expect(presence.size).toBe(1)
  })

  it('announces a clean leave and a revocation at once rather than holding them', () => {
    let now = 0
    const activities = jest.fn()
    const presence = new EphemeralRoomPresence({
      room,
      roomEpoch,
      localClientId: 7,
      resolveEncryptedAwarenessIdentity: () => ({ userUuid: 'user-1', label: 'Alice' }),
      onActivity: activities,
      now: () => now,
    })

    expect(presence.accept(joinedFrame())).toBe(true)
    expect(presence.accept(leftFrame({ reason: 'clean-leave' }))).toBe(true)
    expect(activities).toHaveBeenCalledTimes(2)
    expect(activities).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'left', reason: 'clean-leave', label: 'Alice' }),
    )

    expect(presence.accept(joinedFrame({ presenceId: 'presence-3', clientId: 52 }))).toBe(true)
    expect(presence.accept(leftFrame({ presenceId: 'presence-3', clientId: 52, reason: 'revoked' }))).toBe(true)
    expect(activities).toHaveBeenCalledTimes(4)
    expect(activities).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'left', reason: 'revoked' }))
  })

  it('rejects mismatched epochs and identities, then emits one terminal revocation transition', () => {
    let identity: EncryptedAwarenessIdentity | undefined = { userUuid: 'spoofed-user', label: 'Mallory' }
    const activities = jest.fn()
    const terminal = jest.fn()
    const presence = new EphemeralRoomPresence({
      room,
      roomEpoch,
      localClientId: 7,
      resolveEncryptedAwarenessIdentity: () => identity,
      onActivity: activities,
      onTerminalClient: terminal,
    })

    expect(presence.accept(joinedFrame({ roomEpoch: 'room_epoch_0000000000000002' }))).toBe(false)
    expect(presence.size).toBe(0)
    expect(activities).not.toHaveBeenCalled()

    expect(presence.accept(joinedFrame())).toBe(true)
    expect(activities).not.toHaveBeenCalled()
    identity = { userUuid: 'user-1', label: 'Alice' }
    presence.reconcileEncryptedAwareness()
    expect(activities).toHaveBeenCalledTimes(1)

    expect(presence.accept(leftFrame({ reason: 'revoked' }))).toBe(true)
    expect(presence.accept(leftFrame({ reason: 'revoked' }))).toBe(false)
    expect(terminal).toHaveBeenCalledTimes(1)
    expect(terminal).toHaveBeenCalledWith(remoteClientId, 'revoked')
    expect(activities).toHaveBeenCalledTimes(2)
    expect(activities).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'left', label: 'Alice', reason: 'revoked' }),
    )
  })

  it('clears disconnect state and its single expiry timer without synthetic activity', () => {
    const activities = jest.fn()
    const presence = new EphemeralRoomPresence({
      room,
      roomEpoch,
      localClientId: 7,
      resolveEncryptedAwarenessIdentity: () => ({ userUuid: 'user-1', label: 'Alice' }),
      onActivity: activities,
    })

    expect(presence.accept(joinedFrame())).toBe(true)
    expect(presence.size).toBe(1)
    expect(activities).toHaveBeenCalledTimes(1)
    presence.clear()
    expect(presence.size).toBe(0)

    jest.advanceTimersByTime(120_000)
    expect(activities).toHaveBeenCalledTimes(1)
  })
})
