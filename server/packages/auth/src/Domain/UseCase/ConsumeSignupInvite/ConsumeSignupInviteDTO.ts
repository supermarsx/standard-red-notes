export interface ConsumeSignupInviteDTO {
  /** The raw invite token presented by the registering client. */
  token: string
  /** The registering email (for the per-link allowed_domain lock). */
  email: string
  /** The uuid of the user row being created (for the attribution use row). */
  newUserUuid: string
  /** Evaluation clock (server UTC). */
  now: Date
}
