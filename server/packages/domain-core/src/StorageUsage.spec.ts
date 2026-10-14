import { storageUsageSignature, validStorageScope, verifyStorageUsageRequest } from './StorageUsage'
const scope = { userUuid: '00000000-0000-4000-8000-000000000001', vaultUuids: ['00000000-0000-4000-8000-000000000002'] }
describe('internal storage authority proof', () => {
  it('binds timestamp and exact validated ownership scope; rejects tamper, expiry, duplicates and traversal', () => {
    const now = Date.now(),
      timestamp = String(now),
      signature = storageUsageSignature('shared-key', timestamp, scope)
    expect(verifyStorageUsageRequest('shared-key', timestamp, signature, scope, now)).toBe(true)
    expect(verifyStorageUsageRequest('other-key', timestamp, signature, scope, now)).toBe(false)
    expect(verifyStorageUsageRequest('shared-key', timestamp, signature, { ...scope, vaultUuids: [] }, now)).toBe(false)
    expect(verifyStorageUsageRequest('shared-key', timestamp, signature, scope, now + 30_001)).toBe(false)
    expect(validStorageScope({ ...scope, vaultUuids: ['../../outside'] })).toBe(false)
    expect(validStorageScope({ ...scope, vaultUuids: [...scope.vaultUuids, ...scope.vaultUuids] })).toBe(false)
  })
})
