import { createHmac, timingSafeEqual } from 'crypto'

export interface StorageComponent {
  bytes: number | null
  count: number | null
  complete: boolean
}
export interface StorageScope {
  userUuid: string
  vaultUuids: string[]
}
export interface AccountStorageUsage {
  totalBytesUsed: number | null
  complete: boolean
  measuredAt: string
  components: { items: StorageComponent; files: StorageComponent; revisions: StorageComponent }
}
export function validStorageScope(value: unknown): value is StorageScope {
  if (!value || typeof value !== 'object') {
    return false
  }
  const scope = value as StorageScope
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  return (
    typeof scope.userUuid === 'string' &&
    uuid.test(scope.userUuid) &&
    Array.isArray(scope.vaultUuids) &&
    scope.vaultUuids.length <= 1000 &&
    scope.vaultUuids.every((id) => typeof id === 'string' && uuid.test(id)) &&
    new Set(scope.vaultUuids).size === scope.vaultUuids.length
  )
}
export function storageUsageSignature(secret: string, timestamp: string, scope: StorageScope): string {
  return createHmac('sha256', secret)
    .update(`storage-usage:${timestamp}:${JSON.stringify(scope)}`)
    .digest('hex')
}
export function verifyStorageUsageRequest(
  secret: string,
  timestamp: unknown,
  signature: unknown,
  scope: unknown,
  now = Date.now(),
): scope is StorageScope {
  if (
    !secret ||
    typeof timestamp !== 'string' ||
    typeof signature !== 'string' ||
    !/^\d+$/.test(timestamp) ||
    !/^[0-9a-f]{64}$/.test(signature) ||
    !validStorageScope(scope) ||
    Math.abs(now - Number(timestamp)) > 30_000
  ) {
    return false
  }
  return timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(storageUsageSignature(secret, timestamp, scope), 'hex'),
  )
}
export function validStorageComponent(value: unknown): value is StorageComponent {
  const item = value as StorageComponent | undefined
  return (
    !!item &&
    item.complete === true &&
    Number.isSafeInteger(item.bytes) &&
    (item.bytes as number) >= 0 &&
    Number.isSafeInteger(item.count) &&
    (item.count as number) >= 0
  )
}
