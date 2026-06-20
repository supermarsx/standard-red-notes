export interface ShareHttpProjection {
  uuid: string
  type: 'note' | 'tag' | 'account'
  nickname: string | null
  createdAt: string
  revoked: boolean
}
