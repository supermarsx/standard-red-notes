import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'

import { SyncCommandOutboxRepositoryInterface } from '../../Domain/SyncCommand/SyncCommandOutboxRepositoryInterface'
import { SyncCommandTransactionContext } from './SyncCommandTransactionContext'

export class TransactionAwareDomainEventPublisher implements DomainEventPublisherInterface {
  constructor(
    private readonly delegate: DomainEventPublisherInterface,
    private readonly outboxRepository: SyncCommandOutboxRepositoryInterface,
    private readonly transactionContext: SyncCommandTransactionContext,
  ) {}

  async publish(event: DomainEventInterface): Promise<void> {
    if (!this.transactionContext.manager) {
      await this.delegate.publish(event)
      return
    }

    if (this.transactionContext.defersDomainEventsUntilCommit) {
      this.transactionContext.deferUntilCommit(() => this.delegate.publish(event))
      return
    }

    try {
      await this.outboxRepository.enqueue(event)
    } catch (error) {
      this.transactionContext.markOutboxFailure(error)
      throw error
    }
  }
}
