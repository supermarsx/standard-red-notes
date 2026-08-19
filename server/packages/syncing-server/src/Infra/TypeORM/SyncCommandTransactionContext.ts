import { AsyncLocalStorage } from 'async_hooks'
import { EntityManager } from 'typeorm'

type TransactionState = {
  manager: EntityManager
  mode: 'sync-command' | 'invite-mutation'
  outboxFailure?: unknown
  afterCommitOperations: Array<() => Promise<void>>
}

export class SyncCommandTransactionContext {
  private readonly storage = new AsyncLocalStorage<TransactionState>()

  run<T>(manager: EntityManager, callback: () => Promise<T>): Promise<T> {
    return this.storage.run({ manager, mode: 'sync-command', afterCommitOperations: [] }, callback)
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
