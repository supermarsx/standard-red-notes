import {
  AccountStorageUsage,
  StorageComponent,
  StorageScope,
  Uuid,
  storageUsageSignature,
  validStorageComponent,
} from '@standardnotes/domain-core'
import { SQLItemRepository } from '../../../../Infra/TypeORM/SQLItemRepository'
import { SharedVaultRepositoryInterface } from '../../../SharedVault/SharedVaultRepositoryInterface'

type Reader = (scope: StorageScope) => Promise<StorageComponent>
const unavailable = (): StorageComponent => ({ bytes: null, count: null, complete: false })
export class AccountStorageUsageService {
  private files: Reader
  private revisions: Reader
  constructor(
    private items: SQLItemRepository,
    private vaults: SharedVaultRepositoryInterface,
    secret: string,
    filesUrl: string,
    revisionsUrl: string,
  ) {
    const remote =
      (url: string): Reader =>
      async (scope) => {
        if (!url || !secret) {
          throw new Error('Storage authority unavailable')
        }
        const timestamp = String(Date.now())
        const response = await fetch(`${url.replace(/\/$/, '')}/internal/storage-usage`, {
          method: 'POST',
          body: JSON.stringify(scope),
          signal: AbortSignal.timeout(15_000),
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            'x-storage-timestamp': timestamp,
            'x-storage-signature': storageUsageSignature(secret, timestamp, scope),
          },
        })
        if (!response.ok) {
          throw new Error('Storage authority unavailable')
        }
        const data: unknown = await response.json()
        if (!validStorageComponent(data)) {
          throw new Error('Invalid storage authority response')
        }
        return data
      }
    this.files = remote(filesUrl)
    this.revisions = remote(revisionsUrl)
  }
  setReaders(files: Reader, revisions: Reader): void {
    this.files = files
    this.revisions = revisions
  }
  async measure(userUuid: string): Promise<AccountStorageUsage> {
    const uuid = Uuid.create(userUuid)
    if (uuid.isFailed()) {
      throw new Error('Invalid account identifier')
    }
    const vaults = await this.vaults.findByUserUuid(uuid.getValue())
    const scope = { userUuid, vaultUuids: [...new Set(vaults.map((vault) => vault.id.toString()))] }
    if (scope.vaultUuids.length > 1000) {
      throw new Error('Storage scope exceeds supported bound')
    }
    const results = await Promise.allSettled([
      this.items.measureStoredItems(userUuid, scope.vaultUuids),
      this.files(scope),
      this.revisions(scope),
    ])
    const measurements = results.map((result) =>
      result.status === 'fulfilled' && validStorageComponent(result.value) ? result.value : unavailable(),
    )
    const [items, files, revisions] = measurements
    const total = measurements.reduce((sum, component) => sum + (component.bytes ?? 0), 0)
    const complete = measurements.every((component) => component.complete) && Number.isSafeInteger(total)
    return {
      totalBytesUsed: complete ? total : null,
      complete,
      measuredAt: new Date().toISOString(),
      components: { items, files, revisions },
    }
  }
}
