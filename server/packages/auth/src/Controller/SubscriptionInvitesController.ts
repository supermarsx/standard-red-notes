import {
  SubscriptionInviteAcceptRequestParams,
  SubscriptionInviteAcceptResponseBody,
  SubscriptionInviteCancelRequestParams,
  SubscriptionInviteCancelResponseBody,
  SubscriptionInviteDeclineRequestParams,
  SubscriptionInviteDeclineResponseBody,
  SubscriptionInviteListRequestParams,
  SubscriptionInviteListResponseBody,
  SubscriptionInviteRequestParams,
  SubscriptionInviteResponseBody,
} from '@standardnotes/api'
import { HttpResponse, HttpStatusCode } from '@standardnotes/responses'
import { inject, injectable } from 'inversify'

import TYPES from '../Bootstrap/Types'
import { AcceptSharedSubscriptionInvitation } from '../Domain/UseCase/AcceptSharedSubscriptionInvitation/AcceptSharedSubscriptionInvitation'
import { CancelSharedSubscriptionInvitation } from '../Domain/UseCase/CancelSharedSubscriptionInvitation/CancelSharedSubscriptionInvitation'
import { DeclineSharedSubscriptionInvitation } from '../Domain/UseCase/DeclineSharedSubscriptionInvitation/DeclineSharedSubscriptionInvitation'
import { InviteToSharedSubscription } from '../Domain/UseCase/InviteToSharedSubscription/InviteToSharedSubscription'
import { InviteToSharedSubscriptionRefusal } from '../Domain/UseCase/InviteToSharedSubscription/InviteToSharedSubscriptionResult'
import { ListSharedSubscriptionInvitations } from '../Domain/UseCase/ListSharedSubscriptionInvitations/ListSharedSubscriptionInvitations'

/**
 * One fixed sentence per refusal. A `Record` over the closed union on purpose:
 * add a refusal and this stops compiling, which is the only thing that keeps a
 * new silent `success: false` from shipping. No identifier, address, count or
 * database detail goes in a message -- a caller already knows who it invited,
 * and an invite endpoint must not become an oracle about other accounts.
 */
const SUBSCRIPTION_INVITE_REFUSAL_MESSAGES: Record<InviteToSharedSubscriptionRefusal, string> = {
  'not-entitled': 'Sharing a subscription requires a Pro subscription on this account.',
  'no-shareable-subscription':
    'This account has no subscription to share. A deployment that grants features to every account directly has no shared-subscription plan behind them, so there is nothing to invite anyone to.',
  'subscription-already-shared':
    'This account is a member of a shared subscription and cannot share it onwards. Only the subscription owner can invite.',
  'invite-limit-reached': 'Every invite included with this subscription has been used. Cancel one to free a slot.',
  'already-invited': 'An invitation to that recipient already exists.',
}

@injectable()
export class SubscriptionInvitesController {
  constructor(
    @inject(TYPES.Auth_InviteToSharedSubscription) private inviteToSharedSubscription: InviteToSharedSubscription,
    @inject(TYPES.Auth_AcceptSharedSubscriptionInvitation)
    private acceptSharedSubscriptionInvitation: AcceptSharedSubscriptionInvitation,
    @inject(TYPES.Auth_DeclineSharedSubscriptionInvitation)
    private declineSharedSubscriptionInvitation: DeclineSharedSubscriptionInvitation,
    @inject(TYPES.Auth_CancelSharedSubscriptionInvitation)
    private cancelSharedSubscriptionInvitation: CancelSharedSubscriptionInvitation,
    @inject(TYPES.Auth_ListSharedSubscriptionInvitations)
    private listSharedSubscriptionInvitations: ListSharedSubscriptionInvitations,
  ) {}

  async acceptInvite(
    params: SubscriptionInviteAcceptRequestParams,
  ): Promise<HttpResponse<SubscriptionInviteAcceptResponseBody>> {
    const result = await this.acceptSharedSubscriptionInvitation.execute({
      sharedSubscriptionInvitationUuid: params.inviteUuid,
    })

    if (result.success) {
      return {
        status: HttpStatusCode.Success,
        data: result,
      }
    }

    return {
      status: HttpStatusCode.BadRequest,
      data: result,
    }
  }

  async declineInvite(
    params: SubscriptionInviteDeclineRequestParams,
  ): Promise<HttpResponse<SubscriptionInviteDeclineResponseBody>> {
    const result = await this.declineSharedSubscriptionInvitation.execute({
      sharedSubscriptionInvitationUuid: params.inviteUuid,
    })

    if (result.success) {
      return {
        status: HttpStatusCode.Success,
        data: result,
      }
    }

    return {
      status: HttpStatusCode.BadRequest,
      data: result,
    }
  }

  async invite(params: SubscriptionInviteRequestParams): Promise<HttpResponse<SubscriptionInviteResponseBody>> {
    if (!params.identifier) {
      return {
        status: HttpStatusCode.BadRequest,
        data: {
          error: {
            message: 'Missing invitee identifier',
          },
        },
      }
    }

    const result = await this.inviteToSharedSubscription.execute({
      inviterEmail: params.inviterEmail as string,
      inviterUuid: params.inviterUuid as string,
      inviteeIdentifier: params.identifier,
      inviterRoles: params.inviterRoles as string[],
    })

    if (result.success) {
      return {
        status: HttpStatusCode.Success,
        data: result,
      }
    }

    // `success: false` is KEPT, because that is the field the client reads.
    // The message is added beside it: this route used to answer
    // `400 {"success": false}` to all five distinct refusals, including the one
    // that fires for every account on a self-hosted deployment, so neither the
    // caller nor an operator reading an access log could tell "there is no
    // subscription here to share" from "you already invited that person".
    return {
      status: HttpStatusCode.BadRequest,
      data: {
        ...result,
        error: {
          message: SUBSCRIPTION_INVITE_REFUSAL_MESSAGES[result.refusal],
        },
      },
    }
  }

  async cancelInvite(
    params: SubscriptionInviteCancelRequestParams,
  ): Promise<HttpResponse<SubscriptionInviteCancelResponseBody>> {
    const result = await this.cancelSharedSubscriptionInvitation.execute({
      sharedSubscriptionInvitationUuid: params.inviteUuid,
      inviterEmail: params.inviterEmail as string,
    })

    if (result.success) {
      return {
        status: HttpStatusCode.Success,
        data: result,
      }
    }

    return {
      status: HttpStatusCode.BadRequest,
      data: result,
    }
  }

  async listInvites(
    params: SubscriptionInviteListRequestParams,
  ): Promise<HttpResponse<SubscriptionInviteListResponseBody>> {
    const result = await this.listSharedSubscriptionInvitations.execute({
      inviterEmail: params.inviterEmail as string,
    })

    return {
      status: HttpStatusCode.Success,
      data: result,
    }
  }
}
