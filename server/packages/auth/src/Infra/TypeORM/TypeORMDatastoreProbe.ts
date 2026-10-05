import { DataSource, MigrationExecutor } from 'typeorm'

import { DatastoreProbe } from '../../Domain/Diagnostics/AuthRuntimeDiagnostics'

/**
 * Standard Red Notes: the TypeORM half of the datastore probe the admin
 * Diagnostics pane reads.
 *
 * SEPARATE FROM THE REPORT ON PURPOSE. `AuthRuntimeDiagnostics` holds the
 * SHAPE of the answer and must stay free of anything that can reach a
 * connection option; this file is the only place that touches a `DataSource`,
 * and it hands the report nothing but numbers, booleans and rejections.
 *
 * THE WRITE PROBE. A zero-row DML against an auth-owned table. `WHERE 1 = 0` is
 * an impossible predicate, so no row is matched, no row lock is taken and no
 * undo record is written — while the statement itself is still a WRITE and is
 * refused up front by a read-only server, a read-only replica, or a user whose
 * `UPDATE` grant was revoked. That is the case this field exists for: all three
 * pass a `SELECT 1` and fail every real write, and nothing else on the admin
 * screen can see them. It is deliberately NOT an insert-and-rollback: that would
 * take gap locks on a live table to detect two further faults (lock contention,
 * disk pressure) that the pane is told it does not measure.
 *
 * `roles` is the table because the health-check controller already holds its
 * repository, so the probe adds no binding and no new reach into the schema.
 * `SET name = name` writes a column to itself, so even a matched row — which
 * `WHERE 1 = 0` makes impossible — would be a no-op.
 */
const WRITE_PROBE_SQL = 'UPDATE roles SET name = name WHERE 1 = 0'

const READ_PROBE_SQL = 'SELECT 1'

/** The pool census, read defensively off whatever driver this deployment bound. */
function readPoolCensus(dataSource: DataSource): { inUse: number; size: number } | undefined {
  // `MysqlDriver.pool` is the mysql2 pool; a replication setup binds
  // `poolCluster` instead and a SQLite deployment binds neither. Absent is
  // reported as absent — a zeroed census over a driver with no pool would read
  // as a healthy, empty pool.
  const pool = (dataSource.driver as unknown as { pool?: unknown }).pool
  if (pool === undefined || pool === null || typeof pool !== 'object') {
    return undefined
  }

  const candidate = pool as {
    _allConnections?: { length?: unknown }
    _freeConnections?: { length?: unknown }
    config?: { connectionLimit?: unknown }
  }
  const all = candidate._allConnections?.length
  const free = candidate._freeConnections?.length
  const limit = candidate.config?.connectionLimit

  if (typeof all !== 'number' || typeof free !== 'number' || typeof limit !== 'number') {
    return undefined
  }

  return { inUse: Math.max(0, all - free), size: limit }
}

/**
 * How many migrations the live schema is behind.
 *
 * `MigrationExecutor.getPendingMigrations()` is the library's own answer, so the
 * count cannot drift from what a boot-time `migrationsRun` would execute. Only
 * its LENGTH is returned: the migration objects carry names, and a schema name
 * is a disclosure the pane has no use for.
 */
async function readPendingMigrationCount(dataSource: DataSource): Promise<number> {
  const pending = await new MigrationExecutor(dataSource).getPendingMigrations()

  return pending.length
}

export function createTypeORMDatastoreProbe(dataSource: DataSource): DatastoreProbe {
  return {
    initialized: dataSource.isInitialized,
    read: async (): Promise<void> => {
      await dataSource.query(READ_PROBE_SQL)
    },
    write: async (): Promise<void> => {
      await dataSource.query(WRITE_PROBE_SQL)
    },
    pendingMigrations: (): Promise<number> => readPendingMigrationCount(dataSource),
    pool: (): { inUse: number; size: number } | undefined => readPoolCensus(dataSource),
  }
}
