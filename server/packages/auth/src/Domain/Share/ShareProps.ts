export interface ShareProps {
  userUuid: string
  type: 'note' | 'tag' | 'account'
  encryptedPayload: string
  nickname: string | null
  createdAt: Date
  revoked: boolean
  /**
   * Standard Red Notes: "burn after reading". When true the share is consumed
   * (made unavailable) the first time it is successfully fetched from the public
   * read path, so a second open returns "no longer available".
   */
  oneTimeView: boolean
  /**
   * Optional time limit (in minutes) AFTER the first open. When set together with
   * a `firstOpenedAt`, fetches succeed only until `firstOpenedAt + N minutes`,
   * then the share expires. Null means no per-view time limit.
   */
  viewExpiresMinutes: number | null
  /**
   * Timestamp of the first successful public fetch. Null until the share has been
   * opened. Used to enforce `oneTimeView` consumption and `viewExpiresMinutes`.
   */
  firstOpenedAt: Date | null
}
