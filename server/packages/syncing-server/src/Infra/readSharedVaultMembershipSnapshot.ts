import { Repository } from 'typeorm'
import { runSharedSqliteTransaction } from '@standardnotes/domain-core'
import { TypeORMSharedVaultUser } from './TypeORM/TypeORMSharedVaultUser'

export class SharedVaultMembershipAuthority {
  constructor(private repository: Repository<TypeORMSharedVaultUser>) {}
  read(userUuid?: string) {
    return readSharedVaultMembershipSnapshot(this.repository, userUuid)
  }
}

/** One SQL statement gives a consistent snapshot; joining vaults excludes orphan
 * memberships after vault deletion. Fetch one extra row and reject rather than
 * silently treating a truncated result as authority to revoke other members. */
export async function readSharedVaultMembershipSnapshot(
  repository: Repository<TypeORMSharedVaultUser>,
  userUuid?: string,
) {
  const source = repository.manager.connection
  if (source.options.type === 'better-sqlite3') {
    // A separate async task shares SQLite's connection and could otherwise
    // observe another task's uncommitted membership mutation. Wait for all
    // auth/sync writes to this file before reading the authority.
    return runSharedSqliteTransaction(source, String(source.options.database), () => readSnapshot(repository, userUuid))
  }
  return readSnapshot(repository, userUuid)
}

async function readSnapshot(repository: Repository<TypeORMSharedVaultUser>, userUuid?: string) {
  const query = repository
    .createQueryBuilder('membership')
    .innerJoin('shared_vaults', 'vault', 'vault.uuid = membership.shared_vault_uuid')
    .limit(100_001)
  if (userUuid) {
    query.where('membership.user_uuid = :userUuid', { userUuid })
  }
  const memberships = await query.getMany()
  if (memberships.length > 100_000) {
    throw new Error('Shared-vault membership snapshot exceeds supported size')
  }
  return memberships.map((row) => ({
    ...row,
    createdAtTimestamp: Number(row.createdAtTimestamp),
    updatedAtTimestamp: Number(row.updatedAtTimestamp),
  }))
}
