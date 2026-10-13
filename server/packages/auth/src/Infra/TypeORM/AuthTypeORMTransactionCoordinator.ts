import { DataSource, EntityManager } from 'typeorm'
import { runSharedSqliteTransaction, sharedSqliteTransactionQueueStatsForTesting } from '@standardnotes/domain-core'

export interface AuthTypeORMTransactionQueueStats {
  activeQueueKeyCount: number
  sqliteFileQueueCount: number
}

export const authTypeORMTransactionQueueStatsForTesting = sharedSqliteTransactionQueueStatsForTesting

/** Auth and syncing share the per-file SQLite queue even with separate
 * DataSources. MySQL retains its normal pool concurrency. No external I/O may
 * occur while the transaction callback is held. */
export function runAuthTypeORMTransaction<T>(
  dataSource: DataSource,
  transaction: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const execute = () => dataSource.transaction(transaction)
  if (dataSource.options.type !== 'better-sqlite3') {
    return execute()
  }
  return runSharedSqliteTransaction(dataSource, String(dataSource.options.database), execute)
}
