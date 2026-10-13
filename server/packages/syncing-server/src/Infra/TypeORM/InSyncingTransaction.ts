import { DataSource, EntityManager } from 'typeorm'
import { runSharedSqliteTransaction } from '@standardnotes/domain-core'

/** SQLite uses one shared connection: concurrent async transactions must not nest. */
export function inSyncingTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
  readCommitted = false,
): Promise<T> {
  const type = (dataSource.options as { type?: string } | undefined)?.type
  if (readCommitted && (type === 'mysql' || type === 'mariadb')) {
    // Fence discovery must not pin an old item snapshot while awaiting its lock.
    return dataSource.transaction('READ COMMITTED', work)
  }
  if (type !== 'sqlite' && type !== 'better-sqlite3') {
    return dataSource.transaction(work)
  }
  return runSharedSqliteTransaction(
    dataSource,
    String((dataSource.options as { database?: unknown }).database ?? ':memory:'),
    () => dataSource.transaction(work),
  )
}
