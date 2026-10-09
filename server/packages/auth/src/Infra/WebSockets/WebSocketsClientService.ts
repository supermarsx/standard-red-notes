import { inject, injectable } from 'inversify'

import TYPES from '../../Bootstrap/Types'
import { DomainEventFactoryInterface } from '../../Domain/Event/DomainEventFactoryInterface'
import { User } from '../../Domain/User/User'
import { ClientServiceInterface } from '../../Domain/Client/ClientServiceInterface'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'
import { DomainEventTransportUnavailableError } from '../../Bootstrap/UndeliverableDomainEventPublisher'

@injectable()
export class WebSocketsClientService implements ClientServiceInterface {
  constructor(
    @inject(TYPES.Auth_DomainEventFactory) private domainEventFactory: DomainEventFactoryInterface,
    @inject(TYPES.Auth_DomainEventPublisher) private domainEventPublisher: DomainEventPublisherInterface,
    @inject(TYPES.Auth_Logger) private logger: Logger,
  ) {}

  async sendUserRolesChangedEvent(user: User): Promise<void> {
    const event = this.domainEventFactory.createUserRolesChangedEvent(
      user.uuid,
      user.email,
      (await user.roles).map((role) => role.name),
    )

    this.logger.debug(`[WebSockets] Requesting message ${event.type} to user ${user.uuid}`)

    try {
      await this.domainEventPublisher.publish(
        this.domainEventFactory.createWebSocketMessageRequestedEvent({
          userUuid: user.uuid,
          message: JSON.stringify(event),
        }),
      )
    } catch (error) {
      /**
       * Standard Red Notes: this request carries NO work — it asks whatever
       * holds the user's open sockets to nudge them so the new roles land
       * without a reload. The roles themselves are already saved; a client that
       * is not nudged picks them up on its next sign-in or token refresh.
       *
       * So on a deployment with no transport REACHABLE FROM THIS PROCESS — a
       * bundled single-container or LXC install, where events are delivered by
       * direct call inside the server process and `srn-admin` is a second
       * process — failing the caller would mean `roles grant` reporting failure
       * over a grant that is already in the database. That is what made the one
       * command `docs/DEPLOYMENT.md` tells an operator to run unusable there.
       *
       * ONLY that one typed condition is tolerated. A broker that is configured
       * and rejects the publish is a real failure and still propagates, because
       * on a queued topology this nudge is the only thing that ever reaches the
       * client and swallowing it would hide a broken event bus.
       */
      if (!(error instanceof DomainEventTransportUnavailableError)) {
        throw error
      }

      this.logger.warn(
        `[WebSockets] Could not request ${event.type} for user ${user.uuid}: this deployment has no domain-event ` +
          'transport reachable from this process. The role change is saved; connected clients pick it up on their ' +
          'next sign-in or session refresh.',
      )
    }
  }
}
