import { resolve } from 'node:path'
import { DataSource, EntityManager } from 'typeorm'

type TransactionQueue = Map<string, Promise<void>>

const dataSourceQueues = new WeakMap<DataSource, TransactionQueue>()
const sqliteFileQueues = new Map<string, TransactionQueue>()
const SQLITE_TRANSACTION_QUEUE_KEY = '__auth_sqlite_transaction__'
let activeQueueKeyCount = 0

export interface AuthTypeORMTransactionQueueStats {
  activeQueueKeyCount: number
  sqliteFileQueueCount: number
}

export function authTypeORMTransactionQueueStatsForTesting(): AuthTypeORMTransactionQueueStats {
  return {
    activeQueueKeyCount,
    sqliteFileQueueCount: sqliteFileQueues.size,
  }
}

/**
 * BetterSqlite3 memoizes one QueryRunner per DataSource. Concurrent TypeORM
 * transaction calls can otherwise interleave as nested savepoints, allowing a
 * reported success to be undone by an unrelated outer rollback. Serialize all
 * explicit auth SQLite transactions by canonical database file (or by
 * DataSource for `:memory:`); MySQL keeps its normal pool concurrency.
 *
 * Callbacks must contain database work only. Never perform SNS, HTTP, WebDAV,
 * or other external I/O while this coordinator is held. Repository save/remove
 * operations can create implicit TypeORM transactions; prefer this coordinator
 * whenever multiple writes must compose atomically.
 */
export async function runAuthTypeORMTransaction<T>(
  dataSource: DataSource,
  transaction: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const execute = () => dataSource.transaction(transaction)
  if (dataSource.options.type !== 'better-sqlite3') {
    return execute()
  }

  const database = String(dataSource.options.database)
  if (database === ':memory:') {
    const queue = dataSourceQueues.get(dataSource) ?? new Map<string, Promise<void>>()
    dataSourceQueues.set(dataSource, queue)

    return runQueue(queue, SQLITE_TRANSACTION_QUEUE_KEY, execute, () => {
      if (queue.size === 0) {
        dataSourceQueues.delete(dataSource)
      }
    })
  }

  const databaseKey = database.startsWith('file:') ? database : resolve(database)
  const queue = sqliteFileQueues.get(databaseKey) ?? new Map<string, Promise<void>>()
  sqliteFileQueues.set(databaseKey, queue)

  return runQueue(queue, SQLITE_TRANSACTION_QUEUE_KEY, execute, () => {
    if (queue.size === 0) {
      sqliteFileQueues.delete(databaseKey)
    }
  })
}

async function runQueue<T>(
  queue: TransactionQueue,
  key: string,
  operation: () => Promise<T>,
  onIdle: () => void,
): Promise<T> {
  const previous = queue.get(key) ?? Promise.resolve()
  if (!queue.has(key)) {
    activeQueueKeyCount++
  }

  let release!: () => void
  const current = new Promise<void>((resolveCurrent) => {
    release = resolveCurrent
  })
  queue.set(key, current)

  await previous
  try {
    return await operation()
  } finally {
    release()
    if (queue.get(key) === current) {
      queue.delete(key)
      activeQueueKeyCount--
    }
    if (queue.size === 0) {
      onIdle()
    }
  }
}
