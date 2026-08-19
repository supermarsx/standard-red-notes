import { DomainEventInterface, DomainEventPublisherInterface } from '@standardnotes/domain-events'

import { AuthInviteEventTransactionContext } from './AuthInviteEventTransactionContext'

export class AuthInviteTransactionAwareDomainEventPublisher implements DomainEventPublisherInterface {
  constructor(
    private readonly delegate: DomainEventPublisherInterface,
    private readonly transactionContext: AuthInviteEventTransactionContext,
  ) {}

  async publish(event: DomainEventInterface): Promise<void> {
    if (!this.transactionContext.manager) {
      await this.delegate.publish(event)
      return
    }
    this.transactionContext.deferUntilCommit(() => this.delegate.publish(event))
  }
}
