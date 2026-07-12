export interface SignupInviteUseProps {
  /** The invite link whose slot was consumed. */
  inviteLinkUuid: string
  /** The uuid of the new user created via that consume. */
  newUserUuid: string
  /** The referrer (self-serve link creator), or null for admin links. */
  referrerUserUuid: string | null
  createdAt: Date
}
