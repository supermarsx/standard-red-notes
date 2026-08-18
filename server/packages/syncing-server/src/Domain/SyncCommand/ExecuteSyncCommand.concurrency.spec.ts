import { DataSource, EntityManager } from 'typeorm'

import { SyncCommandTransactionContext } from '../../Infra/TypeORM/SyncCommandTransactionContext'
import { ExecuteSyncCommand } from './ExecuteSyncCommand'
import { StoredSyncCommand, SyncCommandRepositoryInterface } from './SyncCommandRepositoryInterface'
import { computeSyncCommandDigest } from './SyncCommandTypes'

class SerializedTransactions {
  private tail = Promise.resolve()

  async transaction<T>(callback: (manager: EntityManager) => Promise<T>): Promise<T> {
    let release: () => void = () => undefined
    const previous = this.tail
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await callback({} as EntityManager)
    } finally {
      release()
    }
  }
}

class InMemoryCommandRepository implements SyncCommandRepositoryInterface {
  private readonly commands = new Map<string, StoredSyncCommand & { executionToken?: string }>()

  async insertAcceptedIfAbsent(command: StoredSyncCommand): Promise<void> {
    if (![...this.commands.values()].some((entry) => this.key(entry) === this.key(command))) {
      this.commands.set(command.uuid, { ...command })
    }
  }

  async find(userUuid: string, sessionUuid: string, commandId: string): Promise<StoredSyncCommand | null> {
    return (
      [...this.commands.values()].find(
        (entry) => entry.userUuid === userUuid && entry.sessionUuid === sessionUuid && entry.commandId === commandId,
      ) ?? null
    )
  }

  async claimAccepted(uuid: string, executionToken: string): Promise<boolean> {
    const command = this.commands.get(uuid)
    if (!command || command.status !== 'accepted' || command.executionToken) {
      return false
    }
    command.executionToken = executionToken
    return true
  }

  async commit(uuid: string, executionToken: string, responseJson: string, expiresAtTimestamp: number): Promise<void> {
    const command = this.commands.get(uuid)
    if (!command || command.executionToken !== executionToken) {
      throw new Error('lost claim')
    }
    command.status = 'committed'
    command.responseJson = responseJson
    command.expiresAtTimestamp = expiresAtTimestamp
    delete command.executionToken
  }

  async deleteExpired(): Promise<number> {
    return 0
  }

  private key(command: Pick<StoredSyncCommand, 'userUuid' | 'sessionUuid' | 'commandId'>): string {
    return `${command.userUuid}:${command.sessionUuid}:${command.commandId}`
  }
}

describe('ExecuteSyncCommand concurrent replay', () => {
  it('serializes competing duplicates so the mutation executes exactly once', async () => {
    const transactions = new SerializedTransactions()
    const repository = new InMemoryCommandRepository()
    const transactionContext = new SyncCommandTransactionContext()
    const dispatcher = { wake: jest.fn() }
    const useCase = new ExecuteSyncCommand(
      transactions as unknown as DataSource,
      transactionContext,
      repository,
      dispatcher as never,
      60_000,
    )
    const canonicalPayload = { api: '20200115', items: [] }
    const dto = {
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      metadata: { id: 'same-command', digest: computeSyncCommandDigest(canonicalPayload) },
      canonicalPayload,
    }
    const beforeExecute = jest.fn(async () => undefined)
    const mutation = jest.fn(async () => ({ sync_token: 'one-result' }))

    const [left, right] = await Promise.all([
      useCase.execute({ ...dto, beforeExecute, execute: mutation }),
      useCase.execute({ ...dto, beforeExecute, execute: mutation }),
    ])

    expect(beforeExecute).toHaveBeenCalledTimes(1)
    expect(mutation).toHaveBeenCalledTimes(1)
    expect(dispatcher.wake).toHaveBeenCalledTimes(1)
    expect([left.replayed, right.replayed].sort()).toEqual([false, true])
    expect(JSON.stringify(left.response)).toBe(JSON.stringify(right.response))
    expect(transactionContext.manager).toBeUndefined()
  })
})
