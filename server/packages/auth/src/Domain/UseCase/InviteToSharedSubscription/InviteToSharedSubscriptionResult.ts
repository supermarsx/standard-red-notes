/**
 * Why a subscription invite was refused.
 *
 * A CLOSED set of stable identifiers, never free text and never anything read
 * off a database error: the controller turns these into the one message a
 * caller sees, and the whole point is that the set is enumerable rather than
 * open-ended.
 *
 * It exists because the refusal used to be `400 {"success": false}` and
 * nothing else. Measured on both shipped topologies at d7bd839d, EVERY invite
 * was refused that way: `STANDARD_RED_ENTITLEMENT_MODE` defaults to `included`
 * on each (docker-compose.yml, docker-compose.single.yml), under which
 * `Register` creates no `user_subscriptions` row at all while
 * `GetUserSubscription` synthesises a PRO_PLAN -- so the account holds
 * PRO_USER, looks fully subscribed everywhere, and `findOneByUserUuid` returns
 * null here. Five distinct conditions, one indistinguishable answer, and the
 * only one an operator could do anything about looked exactly like the four
 * they could not.
 */
export type InviteToSharedSubscriptionRefusal =
  /** The inviter does not hold the Pro role the feature is gated on. */
  | 'not-entitled'
  /**
   * No `user_subscriptions` row belongs to the inviter. On a deployment whose
   * entitlement mode is `included` this is EVERY account, by construction:
   * features are granted without a subscription, so there is no subscription
   * to share.
   */
  | 'no-shareable-subscription'
  /** The inviter is themselves on someone else's shared subscription. */
  | 'subscription-already-shared'
  /** The inviter has used every invite the plan allows. */
  | 'invite-limit-reached'
  /** An invite to this identifier already exists and is not canceled. */
  | 'already-invited'

export type InviteToSharedSubscriptionResult =
  | {
      success: true
      sharedSubscriptionInvitationUuid: string
    }
  | {
      success: false
      refusal: InviteToSharedSubscriptionRefusal
    }
