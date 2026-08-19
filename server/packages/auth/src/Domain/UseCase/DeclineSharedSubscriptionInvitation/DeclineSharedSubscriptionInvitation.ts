import { TimerInterface } from '@standardnotes/time'
import { inject, injectable } from 'inversify'

import TYPES from '../../../Bootstrap/Types'
import { InvitationStatus } from '../../SharedSubscription/InvitationStatus'
import { SharedSubscriptionInvitationRepositoryInterface } from '../../SharedSubscription/SharedSubscriptionInvitationRepositoryInterface'
import { UseCaseInterface } from '../UseCaseInterface'

import { DeclineSharedSubscriptionInvitationDTO } from './DeclineSharedSubscriptionInvitationDTO'
import { DeclineSharedSubscriptionInvitationResponse } from './DeclineSharedSubscriptionInvitationResponse'
import { AuthInviteMutationTransactionRunner } from '../../Invite/AuthInviteMutationTransactionRunner'
import { AuthInviteRealtimeOutboxProducer } from '../../Invite/AuthInviteRealtimeOutboxProducer'
import { AuthInviteAffectedUserResolver } from '../../Invite/AuthInviteAffectedUserResolver'

@injectable()
export class DeclineSharedSubscriptionInvitation implements UseCaseInterface {
  constructor(
    @inject(TYPES.Auth_SharedSubscriptionInvitationRepository)
    private sharedSubscriptionInvitationRepository: SharedSubscriptionInvitationRepositoryInterface,
    @inject(TYPES.Auth_Timer) private timer: TimerInterface,
    private inviteMutationTransactionRunner?: AuthInviteMutationTransactionRunner,
    private inviteRealtimeOutboxProducer?: AuthInviteRealtimeOutboxProducer,
    private inviteAffectedUserResolver?: AuthInviteAffectedUserResolver,
  ) {}

  async execute(dto: DeclineSharedSubscriptionInvitationDTO): Promise<DeclineSharedSubscriptionInvitationResponse> {
    if (this.inviteMutationTransactionRunner) {
      return this.inviteMutationTransactionRunner.execute(
        () => this.executeMutation(dto),
        (result) => result.success,
      )
    }
    return this.executeMutation(dto)
  }

  private async executeMutation(
    dto: DeclineSharedSubscriptionInvitationDTO,
  ): Promise<DeclineSharedSubscriptionInvitationResponse> {
    const sharedSubscriptionInvitation = await this.sharedSubscriptionInvitationRepository.findOneByUuidAndStatus(
      dto.sharedSubscriptionInvitationUuid,
      InvitationStatus.Sent,
    )
    if (sharedSubscriptionInvitation === null) {
      return {
        success: false,
      }
    }

    sharedSubscriptionInvitation.status = InvitationStatus.Declined
    sharedSubscriptionInvitation.updatedAt = this.timer.getTimestampInMicroseconds()

    await this.sharedSubscriptionInvitationRepository.save(sharedSubscriptionInvitation)

    const affectedUserUuids = await this.inviteAffectedUserResolver?.resolve(
      [],
      [sharedSubscriptionInvitation.inviterIdentifier, sharedSubscriptionInvitation.inviteeIdentifier],
    )
    if (this.inviteRealtimeOutboxProducer && affectedUserUuids && affectedUserUuids.length > 0) {
      await this.inviteRealtimeOutboxProducer.recordSubscriptionInvite({
        action: 'declined',
        inviteUuid: sharedSubscriptionInvitation.uuid,
        affectedUserUuids,
      })
    }

    return {
      success: true,
    }
  }
}
