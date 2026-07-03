import { BanType } from '../../User/User'

export interface SetUserBanStatusDTO {
  userUuid: string
  banned: boolean
  banReason?: string | null
  // Standard Red Notes: the ban KIND. Omitted (or when `banned` is false) it
  // defaults to 'permanent', so the historical simple-ban call shape
  // ({ userUuid, banned, banReason }) keeps behaving exactly as before.
  banType?: BanType | null
  // Standard Red Notes: expiry for a 'temporary' ban (required and must be in
  // the future when banType === 'temporary'; ignored otherwise).
  bannedUntil?: Date | null
}
