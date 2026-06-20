export interface GetShareResult {
  type: 'note' | 'tag' | 'account'
  /**
   * Opaque, client-encrypted ciphertext. The server never decrypts it; the
   * decryption key lives only in the share link fragment.
   */
  encryptedPayload: string
  /**
   * True when this share is "burn after reading" (consumed after first open).
   * Lets the public viewer show a self-destruct notice. Never affects crypto.
   */
  oneTimeView: boolean
  /**
   * Minutes the share stays readable AFTER the first open (null if no limit).
   * Informational only — expiry is enforced server-side.
   */
  viewExpiresMinutes: number | null
}
