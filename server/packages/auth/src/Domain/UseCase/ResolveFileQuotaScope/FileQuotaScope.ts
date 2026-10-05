/**
 * Standard Red Notes: WHERE an account's file-quota bookkeeping lives, and what
 * its allowance falls back to when nobody has set one.
 *
 * `FILE_UPLOAD_BYTES_USED` and `FILE_UPLOAD_BYTES_LIMIT` are SUBSCRIPTION
 * settings: every read and every write is keyed on a `user_subscriptions` row's
 * uuid. On this fork the default entitlement mode is `included`, which means
 * registration creates NO such row (`Register.shouldActivateStandardRedFullFeatures`
 * is false unless the mode is `provisioned-full`) while `GetUserSubscription`
 * still synthesises a PRO_PLAN subscription for the client. The account therefore
 * looks subscribed and has nowhere to keep a byte total — which is why usage read
 * "not reported" on every default self-hosted deployment no matter how many files
 * were uploaded.
 *
 * This scope closes that gap WITHOUT a migration and WITHOUT a second counter: it
 * names one uuid to read and write under, and for a row-less account that uuid is
 * the USER's own uuid — the very identity `GetUserSubscription.createIncludedSubscription`
 * already hands the client as the synthetic subscription's uuid. `subscription_settings`
 * has no foreign key to `user_subscriptions` and `SetSubscriptionSettingValue` only
 * requires a well-formed uuid, so the row-less account's bookkeeping lands in the
 * same table, under the same names, with the same semantics.
 */
export type FileQuotaScope = {
  /**
   * The uuid the two FILE_UPLOAD_BYTES_* settings are stored under. A real
   * `user_subscriptions` uuid when the account has one; otherwise the user's own
   * uuid.
   */
  userSubscriptionUuid: string
  /**
   * Whether a persisted `user_subscriptions` row backs this scope. `false` means
   * the scope is the user's own uuid.
   */
  backedBySubscriptionRow: boolean
  /**
   * The plan whose DEFAULT allowance applies, set ONLY while a real subscription
   * row is unexpired. Absent means no plan default applies and the effective
   * allowance falls back to unlimited (`-1`), which is exactly what
   * `CreateValetToken` mints for an account with no live subscription.
   */
  activePlanName?: string
}
