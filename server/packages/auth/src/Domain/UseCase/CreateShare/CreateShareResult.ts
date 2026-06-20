export interface CreateShareResult {
  /**
   * The new share uuid. This is the `shareId` the client embeds in the share
   * link. The decryption key lives only in the link fragment and never reaches
   * the server.
   */
  shareId: string
  type: 'note' | 'tag' | 'account'
  nickname: string | null
  createdAt: Date
  oneTimeView: boolean
  viewExpiresMinutes: number | null
}
