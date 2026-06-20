export interface ShareProps {
  userUuid: string
  type: 'note' | 'tag' | 'account'
  encryptedPayload: string
  nickname: string | null
  createdAt: Date
  revoked: boolean
}
