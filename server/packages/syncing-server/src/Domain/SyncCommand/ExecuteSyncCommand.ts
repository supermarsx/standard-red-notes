import { randomUUID } from 'crypto'
import { DataSource, EntityManager } from 'typeorm'

import { SyncCommandRepositoryInterface } from './SyncCommandRepositoryInterface'
import {
  assertSyncCommandDigest,
  assertSyncCommandDigestValue,
  SyncCommandClaimLostError,
  SyncCommandMetadata,
  SyncCommandProtocolError,
  SyncCommandResult,
  SyncCommandTransactionAbortedError,
  syncCommandDigestsEqual,
} from './SyncCommandTypes'
import {
  abortsDatabaseTransaction,
  SyncCommandTransactionContext,
} from '../../Infra/TypeORM/SyncCommandTransactionContext'
import { SyncCommandOutboxDispatcher } from './SyncCommandOutboxDispatcher'

/**
 * How many times one command's execution is attempted when the database aborts it.
 *
 * Two people saving the same shared note is the ordinary cause: one save commits between the
 * other reading the item and writing it. The next attempt reads the row the other one left
 * and answers with an ordinary sync conflict, so a second attempt is nearly always the last.
 */
export const MAX_SYNC_COMMAND_EXECUTION_ATTEMPTS = 3
const EXECUTION_RETRY_BASE_DELAY_MS = 15

type ExecutionOutcome<T extends Record<string, unknown>> = {
  result: SyncCommandResult<T>
  afterCommitOperations: Array<() => Promise<void>>
  newlyCommitted: boolean
}

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

    let outcome: ExecutionOutcome<T> | undefined
    for (let attempt = 1; outcome === undefined; attempt += 1) {
      try {
        outcome = await this.executeOnce(dto, sessionUuid, attempt === 1)
      } catch (error) {
        // "Still being processed" and "accepted under another digest" are answers, not
        // failures: someone else holds this command, and it is theirs to finish.
        if (error instanceof SyncCommandProtocolError) {
          throw error
        }
        if (attempt < MAX_SYNC_COMMAND_EXECUTION_ATTEMPTS && this.wasAbortedByDatabase(error)) {
          await this.pauseBeforeRetry(attempt)
          continue
        }
        await this.abandonAcceptance(dto.userUuid, sessionUuid, dto.metadata.id)
        throw error
      }
    }

    if (outcome.newlyCommitted) {
      await Promise.allSettled(outcome.afterCommitOperations.map((operation) => operation()))
      this.outboxDispatcher.wake()
    }

    return outcome.result
  }

  /**
   * One attempt: claim, execute and store the result in a single transaction, so that the
   * mutation and the record that it happened are kept or lost together.
   */
  private async executeOnce<T extends Record<string, unknown>>(
    dto: {
      userUuid: string
      metadata: SyncCommandMetadata
      beforeExecute?: () => Promise<void>
      execute: () => Promise<T>
    },
    sessionUuid: string,
    firstAttempt: boolean,
  ): Promise<ExecutionOutcome<T>> {
    let afterCommitOperations: Array<() => Promise<void>> = []
    let newlyCommitted = false
    const result = await this.inExecutionTransaction((manager) =>
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

        // The admission check counts a request; a retry is the same request.
        if (firstAttempt) {
          await dto.beforeExecute?.()
        }
        // `execute` may have swallowed the very error that ended this transaction. Nothing
        // has to ask: the transaction context refuses every later statement, so storing the
        // result below fails and this attempt is abandoned.
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

    return { result, afterCommitOperations, newlyCommitted }
  }

  /**
   * The execution transaction reads each row as it is now, not as it was when the
   * transaction began.
   *
   * An item is saved by reading it, checking the client's stamp against it, and updating it
   * `WHERE updated_at_timestamp = <the stamp that was read>`; a concurrent save is meant to
   * make that update match nothing and come back as an ordinary sync conflict. Under
   * MariaDB's default (REPEATABLE READ with snapshot isolation) the update is instead refused
   * with "Record has changed since last read" and the whole transaction is rolled back, so
   * two people saving one shared note failed each other's commands. READ COMMITTED is what
   * the same statements already run under outside a command, one autocommit each.
   * SQLite has one writer at a time and no such level, so it keeps its default.
   */
  private inExecutionTransaction<R>(run: (manager: EntityManager) => Promise<R>): Promise<R> {
    const databaseType = (this.dataSource.options as { type?: string } | undefined)?.type
    if (databaseType === 'mysql' || databaseType === 'mariadb') {
      return this.dataSource.transaction('READ COMMITTED', run)
    }
    return this.dataSource.transaction(run)
  }

  private wasAbortedByDatabase(error: unknown): boolean {
    return (
      error instanceof SyncCommandTransactionAbortedError ||
      error instanceof SyncCommandClaimLostError ||
      abortsDatabaseTransaction(error)
    )
  }

  private pauseBeforeRetry(attempt: number): Promise<void> {
    const milliseconds =
      EXECUTION_RETRY_BASE_DELAY_MS * attempt + Math.floor(Math.random() * EXECUTION_RETRY_BASE_DELAY_MS)
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
  }

  /**
   * A command whose execution failed did not take effect, and must not go on saying that it
   * might have.
   *
   * The acceptance is committed on its own, before the execution, and used to stay behind
   * when the execution failed. A status query then answered `accepted`, which a client reads
   * as "still being processed": it kept the command, sent nothing else, and asked again every
   * twenty seconds until the record expired a day later. With the acceptance gone the answer
   * is `unknown` -- the server's statement that the command did not take effect -- and the
   * client replays it. A command that some other request is executing or has committed is
   * left exactly as it is.
   */
  private async abandonAcceptance(userUuid: string, sessionUuid: string, commandId: string): Promise<void> {
    try {
      await this.commandRepository.deleteAcceptedIfUnclaimed(userUuid, sessionUuid, commandId)
    } catch {
      // The original failure is the one to report; an acceptance left behind expires.
    }
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
