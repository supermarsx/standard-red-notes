export interface BackupAttachmentReference {
  fileName: string
  filePath: string
  attachmentFileName: string
  attachmentContentType: string
  emailSubject?: string
  batchIndex?: number
  batchCount?: number
}

export interface BackupAttachmentStorageInterface {
  read(reference: BackupAttachmentReference): Promise<Buffer>
  markDelivered(reference: BackupAttachmentReference): Promise<void>
  delete(reference: BackupAttachmentReference): Promise<void>
}

export class InvalidBackupAttachmentReferenceError extends Error {
  constructor() {
    super('Backup attachment reference is invalid')
    this.name = 'InvalidBackupAttachmentReferenceError'
  }
}

export class BackupAttachmentNotFoundError extends Error {
  constructor() {
    super('Backup attachment was not found')
    this.name = 'BackupAttachmentNotFoundError'
  }
}

export class BackupAttachmentTooLargeError extends Error {
  constructor() {
    super('Backup attachment exceeds the configured byte limit')
    this.name = 'BackupAttachmentTooLargeError'
  }
}

export class BackupAttachmentAlreadyDeliveredError extends Error {
  constructor() {
    super('Backup attachment was already delivered')
    this.name = 'BackupAttachmentAlreadyDeliveredError'
  }
}

export class BackupAttachmentChangedDuringReadError extends Error {
  constructor() {
    super('Backup attachment changed while it was being read')
    this.name = 'BackupAttachmentChangedDuringReadError'
  }
}
