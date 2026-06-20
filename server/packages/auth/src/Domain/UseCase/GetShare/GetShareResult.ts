export interface GetShareResult {
  type: 'note' | 'tag' | 'account'
  /**
   * Opaque, client-encrypted ciphertext. The server never decrypts it; the
   * decryption key lives only in the share link fragment.
   */
  encryptedPayload: string
}
