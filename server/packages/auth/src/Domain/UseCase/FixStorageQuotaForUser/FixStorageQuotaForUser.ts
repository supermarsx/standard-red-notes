import { Result, UseCaseInterface, Username } from '@standardnotes/domain-core'

import { FixStorageQuotaForUserDTO } from './FixStorageQuotaForUserDTO'
import { ListSharedSubscriptionInvitations } from '../ListSharedSubscriptionInvitations/ListSharedSubscriptionInvitations'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { InvitationStatus } from '../../SharedSubscription/InvitationStatus'
import { GetSharedSubscriptionForUser } from '../GetSharedSubscriptionForUser/GetSharedSubscriptionForUser'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

export class FixStorageQuotaForUser implements UseCaseInterface<void> {
  constructor(
    private userRepository: UserRepositoryInterface,
    private getSharedSubscriptionForUser: GetSharedSubscriptionForUser,
    private listSharedSubscriptionInvitations: ListSharedSubscriptionInvitations,
    private domainEventFactory: DomainEventFactoryInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private logger: Logger,
  ) {}

  async execute(dto: FixStorageQuotaForUserDTO): Promise<Result<void>> {
    const usernameOrError = Username.create(dto.userEmail)
    if (usernameOrError.isFailed()) {
      return Result.fail(usernameOrError.getError())
    }
    const username = usernameOrError.getValue()

    const user = await this.userRepository.findOneByUsernameOrEmail(username)
    if (user === null) {
      return Result.fail(`Could not find user with email: ${username.value}`)
    }

    /**
     * *** THE HEAL PATH, AND THE PROVISIONAL ZERO THAT USED TO COME WITH IT. ***
     *
     * This is the drift answer for a counter advanced by FILE_UPLOADED and
     * FILE_REMOVED: anything those miss — a crashed worker, a file removed out of
     * band, an account whose totals were never written at all — is corrected from
     * the authoritative source. `RecalculateQuota` in the FILES service sums
     * `listFiles(userUuid)`, which is the bytes actually on disk, and the
     * resulting FILE_QUOTA_RECALCULATED is written as the whole total.
     *
     * TWO THINGS CHANGED HERE, AND THE SECOND WAS FOUND BY RUNNING IT.
     *
     * It used to FAIL OUTRIGHT for an account with no `user_subscriptions` row —
     * which on the default `included` entitlement mode is every account, so the
     * one command that re-derives a total refused to run exactly where the total
     * was missing. The lookup that refused is gone.
     *
     * And it used to write `FILE_UPLOAD_BYTES_USED = 0` first, because the
     * recalculated figure was ADDED. That left the account reporting a confident
     * `0` while holding megabytes, and if the recalculation never arrived the zero
     * WAS the answer. From the `srn-admin` CLI on a single container it cannot
     * arrive: that boot has no event transport, so the publish below throws and
     * the zero is all the operator's "fix" accomplished. A fabricated zero reads
     * as a measurement, so it is worse than the absent figure it replaced.
     * `FileQuotaRecalculatedEventHandler` now writes the total ABSOLUTELY, so
     * there is nothing to zero and a failed publish leaves the previous figure
     * exactly as it was — the right outcome for a correction that did not run.
     */
    await this.domainEventPublisher.publish(
      this.domainEventFactory.createFileQuotaRecalculationRequestedEvent({
        userUuid: user.uuid,
      }),
    )

    this.logger.info('Requested storage quota recalculation for user', {
      userId: user.uuid,
    })

    const invitationsResult = await this.listSharedSubscriptionInvitations.execute({
      inviterEmail: user.email,
    })
    const acceptedInvitations = invitationsResult.invitations.filter(
      (invitation) => invitation.status === InvitationStatus.Accepted,
    )
    for (const invitation of acceptedInvitations) {
      const inviteeUsernameOrError = Username.create(invitation.inviteeIdentifier)
      if (inviteeUsernameOrError.isFailed()) {
        return Result.fail(inviteeUsernameOrError.getError())
      }
      const inviteeUsername = inviteeUsernameOrError.getValue()

      const invitee = await this.userRepository.findOneByUsernameOrEmail(inviteeUsername)
      if (invitee === null) {
        return Result.fail(`Could not find user with email: ${inviteeUsername.value}`)
      }

      // The invitee's shared subscription is still LOOKED UP, because its absence
      // means a broken share and this command should say so rather than quietly
      // recalculating half of one. Nothing is zeroed here either, for the reason
      // above.
      const invitationSubscriptionOrError = await this.getSharedSubscriptionForUser.execute({
        userUuid: invitee.uuid,
      })
      if (invitationSubscriptionOrError.isFailed()) {
        return Result.fail(`Could not find shared subscription for user with email: ${invitation.inviteeIdentifier}`)
      }

      await this.domainEventPublisher.publish(
        this.domainEventFactory.createFileQuotaRecalculationRequestedEvent({
          userUuid: invitee.uuid,
        }),
      )

      this.logger.info('Requested storage quota recalculation for user', {
        userId: invitee.uuid,
      })
    }

    return Result.ok()
  }
}
