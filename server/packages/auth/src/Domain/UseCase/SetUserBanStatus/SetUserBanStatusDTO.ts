export interface SetUserBanStatusDTO {
  userUuid: string
  banned: boolean
  banReason?: string | null
}
