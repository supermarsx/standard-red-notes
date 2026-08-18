import { randomUUID } from 'crypto'
import { DataSource } from 'typeorm'

import { SyncCommandRepositoryInterface } from './SyncCommandRepositoryInterface'
import {
  assertSyncCommandDigest,
  assertSyncCommandDigestValue,
  SyncCommandMetadata,
  SyncCommandProtocolError,
  SyncCommandResult,
  syncCommandDigestsEqual,
} from './SyncCommandTypes'
import { SyncCommandTransactionContext } from '../../Infra/TypeORM/SyncCommandTransactionContext'
import { SyncCommandOutboxDispatcher } from './SyncCommandOutboxDispatcher'

export class ExecuteSyncCommand {
  constructor(
    private readonly dataSource: DataSource,
    private readonly transactionContext: SyncCommandTransactionContext,
    private readonly commandRepository: SyncCommandRepositoryInterface,
    private readonly outboxDispatcher: SyncCommandOutboxDispatcher,
    private readonly ttlMilliseconds: number,
  ) {}

  async execute<T extends Record<string, unknown>>(dto: {
    userUuid: string
    sessionUuid: string | null
    metadata: SyncCommandMetadata
    canonicalPayload: Record<string, unknown>
    canonicalDigest?: string
    beforeExecute?: () => Promise<void>
    execute: () => Promise<T>
  }): Promise<SyncCommandResult<T>> {
    if (dto.canonicalDigest) {
      assertSyncCommandDigestValue(dto.metadata, dto.canonicalDigest)
    } else {
      assertSyncCommandDigest(dto.metadata, dto.canonicalPayload)
    }
    const sessionUuid = dto.sessionUuid ?? ''
    const now = Date.now()

    await this.dataSource.transaction((manager) =>
      this.transactionContext.run(manager, async () => {
        await this.commandRepository.insertAcceptedIfAbsent({
          uuid: randomUUID(),
          userUuid: dto.userUuid,
          sessionUuid,
          commandId: dto.metadata.id,
          requestDigest: dto.metadata.digest.toLowerCase(),
          status: 'accepted',
          responseJson: null,
          expiresAtTimestamp: now + this.ttlMilliseconds,
        })

        const accepted = await this.commandRepository.find(dto.userUuid, sessionUuid, dto.metadata.id)
        if (!accepted) {
          throw new Error('Sync command acceptance was not persisted.')
        }
        this.assertStoredDigestMatches(accepted.requestDigest, dto.metadata.digest)
      }),
    )

    let afterCommitOperations: Array<() => Promise<void>> = []
    let newlyCommitted = false
    const result = await this.dataSource.transaction((manager) =>
      this.transactionContext.run(manager, async (): Promise<SyncCommandResult<T>> => {
        let command = await this.commandRepository.find(dto.userUuid, sessionUuid, dto.metadata.id)
        if (!command) {
          throw new Error('Accepted sync command disappeared before execution.')
        }
        this.assertStoredDigestMatches(command.requestDigest, dto.metadata.digest)

        if (command.status === 'committed') {
          if (!command.responseJson) {
            throw new Error('Committed sync command is missing its replay result.')
          }

          return {
            response: JSON.parse(command.responseJson) as T & {
              command: SyncCommandMetadata & { status: 'committed' }
            },
            replayed: true,
          }
        }

        const executionToken = randomUUID()
        const claimed = await this.commandRepository.claimAccepted(command.uuid, executionToken)
        if (!claimed) {
          command = await this.commandRepository.find(dto.userUuid, sessionUuid, dto.metadata.id)
          if (command?.status === 'committed' && command.responseJson) {
            return {
              response: JSON.parse(command.responseJson) as T & {
                command: SyncCommandMetadata & { status: 'committed' }
              },
              replayed: true,
            }
          }

          throw new SyncCommandProtocolError(
            'sync_command_pending',
            'Sync command is accepted and still being processed.',
            409,
          )
        }

        await dto.beforeExecute?.()
        const response = await dto.execute()
        this.transactionContext.assertOutboxHealthy()

        const committedResponse = {
          ...response,
          command: {
            id: dto.metadata.id,
            digest: dto.metadata.digest.toLowerCase(),
            status: 'committed' as const,
          },
        }
        const responseJson = JSON.stringify(committedResponse)

        await this.commandRepository.commit(
          command.uuid,
          executionToken,
          responseJson,
          Date.now() + this.ttlMilliseconds,
        )
        this.transactionContext.assertOutboxHealthy()
        afterCommitOperations = this.transactionContext.takeAfterCommitOperations()
        newlyCommitted = true

        return { response: committedResponse, replayed: false }
      }),
    )

    if (newlyCommitted) {
      await Promise.allSettled(afterCommitOperations.map((operation) => operation()))
      this.outboxDispatcher.wake()
    }

    return result
  }

  private assertStoredDigestMatches(storedDigest: string, presentedDigest: string): void {
    if (!syncCommandDigestsEqual(storedDigest, presentedDigest)) {
      throw new SyncCommandProtocolError(
        'sync_command_digest_mismatch',
        'Sync command id was already accepted with a different request digest.',
        409,
      )
    }
  }
}
