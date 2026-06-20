export interface CreateShareDTO {
  userUuid: string
  type: string
  encryptedPayload: string
  nickname?: string | null
}
