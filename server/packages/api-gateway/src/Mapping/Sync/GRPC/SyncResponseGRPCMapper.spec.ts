import { SyncCommandResponseMetadata, SyncResponse } from '@standardnotes/grpc'

import { SyncResponseGRPCMapper } from './SyncResponseGRPCMapper'

describe('SyncResponseGRPCMapper durable replay wire contract', () => {
  it('keeps the exact response JSON byte-equivalent after protobuf serialization and replay decoding', () => {
    const response = new SyncResponse()
    response.setSyncToken('stored-token')
    response.setRetrievedItemsList([])
    response.setSavedItemsList([])
    response.setConflictsList([])
    response.setMessagesList([])
    response.setSharedVaultsList([])
    response.setSharedVaultInvitesList([])
    response.setNotificationsList([])
    const command = new SyncCommandResponseMetadata()
    command.setId('command-1')
    command.setDigest('a'.repeat(64))
    command.setStatus('committed')
    command.setReplayed(true)
    response.setCommand(command)

    const mapper = new SyncResponseGRPCMapper()
    const originalJson = JSON.stringify(mapper.toProjection(response))
    const replayed = SyncResponse.deserializeBinary(response.serializeBinary())
    const replayedJson = JSON.stringify(mapper.toProjection(replayed))

    expect(replayedJson).toBe(originalJson)
    expect(replayed.getCommand()?.getReplayed()).toBe(true)
    expect(replayedJson).toBe(
      `{"retrieved_items":[],"saved_items":[],"conflicts":[],"sync_token":"stored-token","cursor_token":"","messages":[],"shared_vaults":[],"shared_vault_invites":[],"notifications":[],"command":{"id":"command-1","digest":"${'a'.repeat(64)}","status":"committed"}}`,
    )
  })
})
