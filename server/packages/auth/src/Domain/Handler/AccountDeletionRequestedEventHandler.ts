import { AccountDeletionRequestedEvent, DomainEventHandlerInterface } from '@standardnotes/domain-events'
import { DeletedAccountMarkers, Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { EphemeralSessionRepositoryInterface } from '../Session/EphemeralSessionRepositoryInterface'
import { RevokedSessionRepositoryInterface } from '../Session/RevokedSessionRepositoryInterface'
import { SessionRepositoryInterface } from '../Session/SessionRepositoryInterface'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { SessionInactivityService } from '../Session/SessionInactivityService'

export class AccountDeletionRequestedEventHandler implements DomainEventHandlerInterface {
  constructor(
    private userRepository: UserRepositoryInterface,
    private sessionRepository: SessionRepositoryInterface,
    private ephemeralSessionRepository: EphemeralSessionRepositoryInterface,
    private revokedSessionRepository: RevokedSessionRepositoryInterface,
    private logger: Logger,
    // Standard Red Notes: where the fact of a deletion is written down for
    // services that keep per-user data outside the database (the api-gateway's
    // JSON stores). Every deletion reaches this handler, whichever route or
    // command started it, which is why the note is written here and not at
    // each entry point. Optional: absent in tests and where no shared location
    // is configured.
    private deletedAccountMarkers?: DeletedAccountMarkers,
    private sessionActivity?: SessionInactivityService,
  ) {}

  async handle(event: AccountDeletionRequestedEvent): Promise<void> {
    const userUuidOrError = Uuid.create(event.payload.userUuid)
    if (userUuidOrError.isFailed()) {
      this.logger.warn('Could not find user.', { userId: event.payload.userUuid })

      return
    }
    const userUuid = userUuidOrError.getValue()

    const user = await this.userRepository.findOneByUuid(userUuid)

    if (user === null) {
      this.logger.warn('Could not find user.', { userId: userUuid.value })
      // The account is gone already (a redelivered event, or a deletion that
      // finished elsewhere). What other services hold about it still has to
      // go, and recording it twice is harmless.
      await this.sessionActivity?.purgeUser(userUuid.value)
      await this.recordDeletion(userUuid.value)

      return
    }

    await this.removeSessions(userUuid.value)

    await this.userRepository.remove(user)
    await this.sessionActivity?.purgeUser(userUuid.value)

    // Only now: a marker means "this account is gone, remove what you hold".
    await this.recordDeletion(userUuid.value)

    this.logger.info('Finished account cleanup.', {
      userId: userUuid.value,
    })
  }

  private async recordDeletion(userUuid: string): Promise<void> {
    if (this.deletedAccountMarkers === undefined || !this.deletedAccountMarkers.isConfigured()) {
      return
    }
    if (!(await this.deletedAccountMarkers.add(userUuid))) {
      // The account is deleted either way. Without the note the api-gateway
      // keeps what it holds for this user until an administrator purges it.
      this.logger.warn('Could not record the account deletion for other services.', { userId: userUuid })
    }
  }

  private async removeSessions(userUuid: string): Promise<void> {
    const sessions = await this.sessionRepository.findAllByUserUuid(userUuid)
    for (const session of sessions) {
      await this.sessionRepository.remove(session)
    }

    const ephemeralSessions = await this.ephemeralSessionRepository.findAllByUserUuid(userUuid)
    for (const ephemeralSession of ephemeralSessions) {
      await this.ephemeralSessionRepository.deleteOne(ephemeralSession.uuid, ephemeralSession.userUuid)
    }

    const revokedSessions = await this.revokedSessionRepository.findAllByUserUuid(userUuid)
    for (const revokedSession of revokedSessions) {
      await this.revokedSessionRepository.remove(revokedSession)
    }
  }
}
