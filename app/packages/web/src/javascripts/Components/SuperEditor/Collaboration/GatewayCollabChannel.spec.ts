import { createGatewayCollabChannel } from './GatewayCollabChannel'

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
