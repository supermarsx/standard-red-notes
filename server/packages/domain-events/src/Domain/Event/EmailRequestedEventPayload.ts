export interface EmailRequestedEventPayload {
  userEmail: string
  messageIdentifier: string
  level: string
  subject: string
  body: string
  sender?: string
  additionalStyles?: string
  backupBatchId?: string
  attachments?: Array<{
    filePath: string
    fileName: string
    attachmentFileName: string
    attachmentContentType: string
    emailSubject?: string
    batchIndex?: number
    batchCount?: number
  }>
  userUuid?: string
}
