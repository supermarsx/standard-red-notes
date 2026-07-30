export class BackupContentTooLargeError extends Error {
  constructor() {
    super('A single item cannot fit within the configured email attachment limit')
    this.name = 'BackupContentTooLargeError'
  }
}
