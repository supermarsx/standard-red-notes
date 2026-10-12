import { AsyncLocalStorage } from 'async_hooks'
import { EntityManager } from 'typeorm'

import { SyncCommandTransactionAbortedError } from '../../Domain/SyncCommand/SyncCommandTypes'

type TransactionState = {
  manager: EntityManager
  mode: 'sync-command' | 'invite-mutation'
  outboxFailure?: unknown
  /** Set once the DATABASE has rolled this transaction back; see `run`. */
  abortedBy?: unknown
  afterCommitOperations: Array<() => Promise<void>>
}

/**
 * MariaDB/MySQL error numbers after which the transaction no longer exists or cannot go on:
 * 1020 ER_CHECKREAD ("Record has changed since last read", raised under
 * innodb_snapshot_isolation), 1205 ER_LOCK_WAIT_TIMEOUT and 1213 ER_LOCK_DEADLOCK.
 */
const ABORTING_ERROR_NUMBERS = new Set([1020, 1205, 1213])
const ABORTING_ERROR_CODES = new Set([
  'ER_CHECKREAD',
  'ER_LOCK_WAIT_TIMEOUT',
  'ER_LOCK_DEADLOCK',
  'SQLITE_BUSY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_LOCKED',
])

/**
 * Whether a query failed because the database gave up on the whole transaction rather than
 * on that one statement. TypeORM wraps the driver's error, so both layers are read.
 */
export function abortsDatabaseTransaction(error: unknown): boolean {
  for (const candidate of [error, (error as { driverError?: unknown } | null | undefined)?.driverError]) {
    if (typeof candidate !== 'object' || candidate === null) {
      continue
    }
    const { errno, code } = candidate as { errno?: unknown; code?: unknown }
    if (typeof errno === 'number' && ABORTING_ERROR_NUMBERS.has(errno)) {
      return true
    }
    if (typeof code === 'string' && ABORTING_ERROR_CODES.has(code)) {
      return true
    }
  }
  return false
}

export class SyncCommandTransactionContext {
  private readonly storage = new AsyncLocalStorage<TransactionState>()

  /**
   * Run a durable command's work inside `manager`'s transaction.
   *
   * Every statement the transaction issues goes through its query runner, and that is where
   * this watches for the one failure the code above it cannot see: the database rolling the
   * WHOLE transaction back (MariaDB does when a statement writes a row another transaction
   * changed after this one first read it). The caller that issued the statement gets an
   * ordinary error and may well swallow it -- saving one item is allowed to fail -- but the
   * transaction is gone, and every later statement would run on its own, outside it, and be
   * kept while the command it belongs to is reported as failed. So from that point on no
   * statement is sent at all -- including the one that would store the command's result,
   * which is how the executor finds out and starts over.
   */
  run<T>(manager: EntityManager, callback: () => Promise<T>): Promise<T> {
    const state: TransactionState = { manager, mode: 'sync-command', afterCommitOperations: [] }
    const queryRunner = manager.queryRunner
    if (!queryRunner || typeof queryRunner.query !== 'function') {
      return this.storage.run(state, callback)
    }

    const originalQuery = queryRunner.query
    const guardedQuery = async (...parameters: Parameters<typeof originalQuery>) => {
      if (state.abortedBy !== undefined) {
        throw new SyncCommandTransactionAbortedError(state.abortedBy)
      }
      try {
        return await originalQuery.apply(queryRunner, parameters)
      } catch (error) {
        if (abortsDatabaseTransaction(error)) {
          state.abortedBy = error
        }
        throw error
      }
    }
    queryRunner.query = guardedQuery as typeof originalQuery

    // Some drivers hand every transaction the same query runner, so the guard must come off.
    return this.storage.run(state, callback).finally(() => {
      if (queryRunner.query === guardedQuery) {
        queryRunner.query = originalQuery
      }
    })
  }

  runInviteMutation<T>(manager: EntityManager, callback: () => Promise<T>): Promise<T> {
    return this.storage.run({ manager, mode: 'invite-mutation', afterCommitOperations: [] }, callback)
  }

  get manager(): EntityManager | undefined {
    return this.storage.getStore()?.manager
  }

  get defersDomainEventsUntilCommit(): boolean {
    return this.storage.getStore()?.mode === 'invite-mutation'
  }

  markOutboxFailure(error: unknown): void {
    const state = this.storage.getStore()
    if (state) {
      state.outboxFailure = error
    }
  }

  assertOutboxHealthy(): void {
    const failure = this.storage.getStore()?.outboxFailure
    if (failure !== undefined) {
      throw failure
    }
  }

  deferUntilCommit(operation: () => Promise<void>): void {
    const state = this.storage.getStore()
    if (!state) {
      throw new Error('Cannot defer an operation without an active sync command transaction.')
    }

    state.afterCommitOperations.push(operation)
  }

  takeAfterCommitOperations(): Array<() => Promise<void>> {
    const state = this.storage.getStore()
    if (!state) {
      return []
    }

    return state.afterCommitOperations.splice(0)
  }
}
