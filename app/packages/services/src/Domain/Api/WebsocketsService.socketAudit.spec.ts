import { WebSocketsService } from './WebsocketsService'

// Stale authorization results must not cross a session barrier.
describe('socket audit: authorization session fencing', () => {
  it('rejects a late old-session grant after the session revocation barrier', async () => {
    const service = new WebSocketsService({} as never, '', {} as never, { publish: jest.fn() } as never)
    const roomEpoch = 'room_epoch_0000000000000001'
    const grant = {
      epochDiscovery: false as const,
      capability: 'old-session-capability',
      room: 'note-1',
      expiresIn: 300,
      serverUpdatedAtTimestamp: 123,
      collaborationProtocolVersion: 3 as const,
      roomEpoch,
      collaborationSecurityEpoch: 'security_epoch_0000000000000001',
    }
    let resolveOld!: (value: typeof grant) => void
    const oldTransport = jest.fn(() => new Promise<typeof grant>((resolve) => (resolveOld = resolve)))
    service.setCollaborationAuthorizationTransport(oldTransport)
    try {
      const oldRequest = service.authorizeCollaborationRoom('note-1', undefined, undefined, roomEpoch)
      await service.revokeSyncTransportSession()
      const newTransport = jest.fn().mockResolvedValue({ ...grant, capability: 'new-session-capability' })
      service.setCollaborationAuthorizationTransport(newTransport)
      resolveOld(grant)
      expect(await oldRequest).toBeUndefined()

      const result = await service.authorizeCollaborationRoom('note-1', undefined, undefined, roomEpoch)
      expect(result?.capability).toBe('new-session-capability')
      expect(newTransport).toHaveBeenCalledTimes(1)
    } finally {
      service.deinit()
    }
  })
})
