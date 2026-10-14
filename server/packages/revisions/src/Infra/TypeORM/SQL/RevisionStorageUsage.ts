import { Repository } from 'typeorm'
import { StorageComponent, StorageScope } from '@standardnotes/domain-core'
import { SQLRevision } from './SQLRevision'

export class RevisionStorageUsage {
  constructor(
    private repository: Repository<SQLRevision>,
    readonly secret: string,
  ) {}
  async measure(scope: StorageScope): Promise<StorageComponent> {
    const byteLength = (field: string) =>
      this.repository.manager.connection.options.type === 'better-sqlite3'
        ? `LENGTH(CAST(COALESCE(revision.${field}, '') AS BLOB))`
        : `OCTET_LENGTH(COALESCE(revision.${field}, ''))`
    const query = this.repository
      .createQueryBuilder('revision')
      .select(`COALESCE(SUM(${['content', 'enc_item_key', 'auth_hash'].map(byteLength).join(' + ')}), 0)`, 'bytes')
      .addSelect('COUNT(*)', 'count')
      .where('(revision.shared_vault_uuid IS NULL AND revision.user_uuid = :userUuid)', { userUuid: scope.userUuid })
    if (scope.vaultUuids.length) {
      query.orWhere('revision.shared_vault_uuid IN (:...vaultUuids)', { vaultUuids: scope.vaultUuids })
    }
    const row = await query.getRawOne<{ bytes: string | number; count: string | number }>()
    const bytes = Number(row?.bytes),
      count = Number(row?.count)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(count) || count < 0) {
      throw new Error('Revision size unavailable')
    }
    return { bytes, count, complete: true }
  }
}
