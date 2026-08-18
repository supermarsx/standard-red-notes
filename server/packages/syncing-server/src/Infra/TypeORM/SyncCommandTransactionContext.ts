import { AsyncLocalStorage } from 'async_hooks'
import { EntityManager } from 'typeorm'

type TransactionState = {
  manager: EntityManager
  outboxFailure?: unknown
  afterCommitOperations: Array<() => Promise<void>>
}

export class SyncCommandTransactionContext {
  private readonly storage = new AsyncLocalStorage<TransactionState>()

  run<T>(manager: EntityManager, callback: () => Promise<T>): Promise<T> {
    return this.storage.run({ manager, afterCommitOperations: [] }, callback)
  }

  get manager(): EntityManager | undefined {
    return this.storage.getStore()?.manager
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
