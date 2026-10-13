import { createHmac } from 'crypto'
import { signCollaborationSaveProof } from './CollaborationSaveFenceDispatch'
import { computeSyncCommandDigest, logicalSyncCommandPayload } from './SyncCommandDigest'

describe('gateway collaboration save proof', () => {
  it('binds authenticated identities while preserving the client command digest', () => {
    const body = { items: [], collaboration_save_fences: [{ room: 'note', token: 'token' }] }
    const signed = signCollaborationSaveProof(body, 'user', 'device', 'secret')
    const timestamp = signed.collaboration_save_fence_timestamp
    expect(signed.collaboration_save_fence_signature).toBe(
      createHmac('sha256', 'secret')
        .update(
          `save-proof:${timestamp}:${JSON.stringify({ userUuid: 'user', deviceId: 'device', proofs: body.collaboration_save_fences })}`,
        )
        .digest('hex'),
    )
    expect(computeSyncCommandDigest(logicalSyncCommandPayload(signed))).toBe(computeSyncCommandDigest(body))
    expect(signed.collaboration_save_fence_device_id).toBe('device')
  })
  it('strips forged authentication fields and signs only socket proof payloads', () => {
    const signed = signCollaborationSaveProof(
      {
        items: [],
        collaboration_save_fence_device_id: 'forged',
        collaboration_save_fence_timestamp: 'forged',
        collaboration_save_fence_signature: 'forged',
      },
      'user',
      'device',
      'secret',
    )
    expect(signed).toEqual({ items: [] })
  })
})
