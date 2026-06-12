export interface EmailSenderInterface {
  /**
   * Sends an email. Returns true if the email was dispatched, false if email
   * delivery is not configured (in which case callers should fall back to an
   * alternative delivery mechanism such as an on-screen code).
   */
  sendEmail(to: string, subject: string, body: string): Promise<boolean>

  isConfigured(): boolean
}
