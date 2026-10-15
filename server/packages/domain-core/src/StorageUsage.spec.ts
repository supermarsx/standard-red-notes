import {
  storageUsageSignature,
  validStorageComponent,
  validStorageScope,
  verifyStorageUsageRequest,
} from './StorageUsage'
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

describe('complete storage component contract', () => {
  it('accepts measured zero and exact nonnegative safe integer totals only', () => {
    expect(validStorageComponent({ bytes: 0, count: 0, complete: true })).toBe(true)
    expect(validStorageComponent({ bytes: Number.MAX_SAFE_INTEGER, count: 1, complete: true })).toBe(true)
    for (const value of [
      undefined,
      null,
      1,
      {},
      { bytes: 0, count: 0, complete: false },
      { bytes: null, count: 0, complete: true },
      { bytes: -1, count: 0, complete: true },
      { bytes: 0.5, count: 0, complete: true },
      { bytes: Number.MAX_SAFE_INTEGER + 1, count: 0, complete: true },
      { bytes: 0, count: null, complete: true },
      { bytes: 0, count: -1, complete: true },
      { bytes: 0, count: 0.5, complete: true },
      { bytes: 0, count: Number.MAX_SAFE_INTEGER + 1, complete: true },
    ]) {
      expect(validStorageComponent(value)).toBe(false)
    }
  })
  it('rejects missing or malformed authority scopes and verifies against the default current clock', () => {
    expect(validStorageScope(null)).toBe(false)
    expect(validStorageScope('user')).toBe(false)
    expect(validStorageScope({ userUuid: 1, vaultUuids: [] })).toBe(false)
    expect(validStorageScope({ ...scope, vaultUuids: null })).toBe(false)
    const timestamp = String(Date.now())
    expect(
      verifyStorageUsageRequest('shared-key', timestamp, storageUsageSignature('shared-key', timestamp, scope), scope),
    ).toBe(true)
  })
})
