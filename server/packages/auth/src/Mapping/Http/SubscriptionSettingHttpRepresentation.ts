export interface SubscriptionSettingHttpRepresentation {
  uuid: string
  name: string
  value: string | null
  createdAt: number
  updatedAt: number
  sensitive: boolean
  /**
   * Standard Red Notes: WHERE this value came from, as a closed vocabulary.
   *
   * Absent on everything the mapper produces from a stored row — a projection of
   * a real `subscription_settings` row needs no provenance because its existence
   * IS its provenance. It is set only by the self-scoped settings controller when
   * it answers an EFFECTIVE value that no row holds:
   *
   *   - `account-setting`       a stored per-account row (the mapper's output,
   *                             labelled explicitly so a client never has to read
   *                             absence as "stored").
   *   - `plan-default`          the subscription plan's default allowance, which
   *                             is what `CreateValetToken` applies when the
   *                             per-account limit setting is missing.
   *   - `no-active-subscription` a subscription row exists and is not live, so
   *                             the token minter grants unlimited (-1) unless an
   *                             explicit limit says otherwise.
   *   - `no-subscription-record` there is no subscription row at all, which on
   *                             the default `included` entitlement is EVERY
   *                             account: the plan is included by the deployment
   *                             rather than stored. Unlimited (-1) for the same
   *                             reason, and kept apart from the member above
   *                             because that one says the subscription is not
   *                             active — which is false of an account the same
   *                             server reports as holding an active plan.
   *
   * ONLY ever accompanies a LIMIT. A usage total is never synthesised: an account
   * with no total reported has its figure absent, because a fabricated 0 and a
   * measured 0 are different answers and only one of them is true.
   */
  origin?: 'account-setting' | 'plan-default' | 'no-active-subscription' | 'no-subscription-record'
}
