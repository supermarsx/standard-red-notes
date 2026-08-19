import type { CollabFrame } from './CollabChannel'
import { EphemeralRoomPresence, type EncryptedAwarenessIdentity } from './EphemeralRoomPresence'

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
