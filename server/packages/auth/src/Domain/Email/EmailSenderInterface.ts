export interface EmailAttachment {
  content: Buffer
  contentType: string
  filename: string
}

export interface SendEmailOptions {
  attachments?: EmailAttachment[]
  html?: boolean
}

export interface EmailSenderInterface {
  /**
   * Sends an email. Returns true only when the provider confirms recipient
   * acceptance. Returns false when delivery is unconfigured or not accepted;
   * interactive callers may then use an alternative such as an on-screen code.
   */
  sendEmail(to: string, subject: string, body: string, options?: SendEmailOptions): Promise<boolean>

  isConfigured(): boolean
}
