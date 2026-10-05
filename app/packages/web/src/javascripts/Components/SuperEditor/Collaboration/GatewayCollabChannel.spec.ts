import { WebSocketsServiceEvent } from '@standardnotes/snjs'
import { createGatewayCollabChannel } from './GatewayCollabChannel'

/**
 * The provider's whole bounded join-retry ladder is gated on `isConnected()` and
 * armed only by `subscribeStatus`. Both were wired here with no test at all, so
 * nothing proved the gate reads the real socket or that a reconnect maps to
 * `true` — a ladder that never arms, or one that retries against a closed
 * socket, would both have looked exactly like working code.
 */
describe('createGatewayCollabChannel transport status', () => {
  const socketsFor = (overrides: Record<string, unknown> = {}) =>
    ({
      sockets: {
        isWebSocketConnectionOpen: () => true,
        sendCollaborationFrame: jest.fn(),
        onCollaborationFrame: jest.fn(() => jest.fn()),
        authorizeCollaborationRoom: jest.fn(),
        addEventObserver: jest.fn(() => jest.fn()),
        ...overrides,
      },
    }) as never

  it('reads the live socket on every isConnected check rather than caching it', () => {
    let open = false
    const isWebSocketConnectionOpen = jest.fn(() => open)
    const channel = createGatewayCollabChannel(socketsFor({ isWebSocketConnectionOpen }))

    expect(channel.isConnected()).toBe(false)
    open = true
    expect(channel.isConnected()).toBe(true)
    // Precondition: the adapter really delegated rather than answering from a
    // value captured at construction.
    expect(isWebSocketConnectionOpen).toHaveBeenCalledTimes(2)
  })

  it('maps only socket open and close onto the provider transport status', () => {
    let observer: ((event: unknown) => Promise<void>) | undefined
    const dispose = jest.fn()
    const addEventObserver = jest.fn((handler: (event: unknown) => Promise<void>) => {
      observer = handler
      return dispose
    })
    const channel = createGatewayCollabChannel(socketsFor({ addEventObserver }))
    const status: boolean[] = []

    const unsubscribe = channel.subscribeStatus?.((connected) => status.push(connected))
    // Precondition: the adapter really subscribed, so the frames below are
    // delivered through the production path and not a test-only shim.
    expect(observer).toBeDefined()

    void observer?.(WebSocketsServiceEvent.WebSocketDidOpen)
    void observer?.(WebSocketsServiceEvent.WebSocketDidClose)
    // An unrelated service event must not be read as a transport transition:
    // a spurious `true` re-arms the ladder and resets its retry budget.
    void observer?.(WebSocketsServiceEvent.ItemsChangedOnServer)

    expect(status).toEqual([true, false])
    unsubscribe?.()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('refuses an epoch-bound authorization for a malformed epoch without calling the transport', async () => {
    const authorizeCollaborationRoom = jest.fn()
    const channel = createGatewayCollabChannel(socketsFor({ authorizeCollaborationRoom }))

    await expect(channel.authorizeEpochBound?.('note-1', 'too-short', 'lease-1')).resolves.toBeUndefined()
    // Fail closed BEFORE the round trip: a malformed pin must never reach the
    // authorize lane, where it would be signed or discovered against.
    expect(authorizeCollaborationRoom).not.toHaveBeenCalled()
  })

  it('refuses a non-object authorization result', async () => {
    const authorizeCollaborationRoom = jest.fn().mockResolvedValue('capability-as-a-string')
    const channel = createGatewayCollabChannel(socketsFor({ authorizeCollaborationRoom }))

    await expect(
      channel.authorizeEpochBound?.('note-1', 'room_epoch_0000000000000001', 'lease-1'),
    ).resolves.toBeUndefined()
    expect(authorizeCollaborationRoom).toHaveBeenCalledTimes(1)
  })
})

describe('createGatewayCollabChannel shared room leases', () => {
  it('forwards stable editor/comment lease identities to the shared socket', () => {
    const sendCollaborationFrame = jest.fn()
    const application = {
      sockets: {
        isWebSocketConnectionOpen: () => true,
        sendCollaborationFrame,
        onCollaborationFrame: jest.fn(() => jest.fn()),
        authorizeCollaborationRoom: jest.fn(),
      },
    } as never
    const editor = createGatewayCollabChannel(application)
    const comments = createGatewayCollabChannel(application)

    editor.send({ t: 'room-join', room: 'note-1', cap: 'cap-1', requestId: 'editor' })
    comments.send({ t: 'room-join', room: 'note-1', cap: 'cap-2', requestId: 'comments' })
    expect(sendCollaborationFrame).toHaveBeenCalledTimes(2)

    comments.send({ t: 'room-leave', room: 'note-1', requestId: 'comments' })
    expect(sendCollaborationFrame).toHaveBeenLastCalledWith({
      t: 'room-leave',
      room: 'note-1',
      requestId: 'comments',
    })

    editor.send({ t: 'room-leave', room: 'note-1', requestId: 'editor' })
    expect(sendCollaborationFrame).toHaveBeenLastCalledWith({
      t: 'room-leave',
      room: 'note-1',
      requestId: 'editor',
    })
    expect(sendCollaborationFrame).toHaveBeenCalledTimes(4)
  })

  it('exposes only the opaque capability to the relay provider', async () => {
    const authorizeCollaborationRoom = jest.fn().mockResolvedValue({
      capability: 'capability-1',
      serverUpdatedAtTimestamp: 123,
    })
    const application = {
      sockets: {
        isWebSocketConnectionOpen: () => true,
        sendCollaborationFrame: jest.fn(),
        onCollaborationFrame: jest.fn(() => jest.fn()),
        authorizeCollaborationRoom,
      },
    } as never

    await expect(createGatewayCollabChannel(application).authorize('note-1')).resolves.toBe('capability-1')
    expect(authorizeCollaborationRoom).toHaveBeenCalledWith('note-1')
  })

  it('binds protocol-v3 reauthorization to the immutable cipher room epoch', async () => {
    const roomEpoch = 'room_epoch_0000000000000001'
    const authorizeCollaborationRoom = jest
      .fn()
      .mockResolvedValueOnce({
        capability: 'epoch-capability',
        roomEpoch,
        collaborationProtocolVersion: 3,
      })
      .mockResolvedValueOnce({
        capability: 'rotated-capability',
        roomEpoch: 'room_epoch_0000000000000002',
        collaborationProtocolVersion: 3,
      })
    const application = {
      sockets: {
        isWebSocketConnectionOpen: () => true,
        sendCollaborationFrame: jest.fn(),
        onCollaborationFrame: jest.fn(() => jest.fn()),
        authorizeCollaborationRoom,
      },
    } as never
    const channel = createGatewayCollabChannel(application)

    await expect(channel.authorizeEpochBound?.('note-1', roomEpoch, 'lease-1')).resolves.toEqual({
      capability: 'epoch-capability',
      roomEpoch,
      collaborationProtocolVersion: 3,
    })
    expect(authorizeCollaborationRoom).toHaveBeenLastCalledWith('note-1', 'lease-1', undefined, roomEpoch)

    await expect(channel.authorizeEpochBound?.('note-1', roomEpoch, 'lease-1')).resolves.toBeUndefined()
  })
})
