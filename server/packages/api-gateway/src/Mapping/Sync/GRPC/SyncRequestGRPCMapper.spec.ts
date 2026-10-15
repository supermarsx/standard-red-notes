import { SyncRequest } from '@standardnotes/grpc'
import { SyncRequestGRPCMapper } from './SyncRequestGRPCMapper'

describe('revision hints on the gRPC sync path', () => {
  it.each(['automatic', 'metadata'])('preserves %s through the protobuf wire encoding', (revision_creation) => {
    const request = new SyncRequestGRPCMapper().toProjection({
      items: [{ uuid: 'note', content: 'ciphertext', revision_creation }],
    })
    const decoded = SyncRequest.deserializeBinary(request.serializeBinary())
    expect(decoded.getItemsList()[0].getRevisionCreation()).toBe(revision_creation)
    expect(decoded.getItemsList()[0].getContent()).toBe('ciphertext')
  })
  it('keeps old clients valid when they send no hint', () => {
    const request = new SyncRequestGRPCMapper().toProjection({ items: [{ uuid: 'note', content: 'ciphertext' }] })
    expect(request.getItemsList()[0].hasRevisionCreation()).toBe(false)
  })
})
