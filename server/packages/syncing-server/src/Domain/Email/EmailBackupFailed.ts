export function getEmailBackupFailedSubject(): string {
  return 'Your email backup could not be created'
}

export function getEmailBackupFailedBody(): string {
  return [
    '<p>Your encrypted data backup could not be attached because at least one item is larger than the',
    'configured email attachment limit.</p>',
    '<p>No partial backup was sent. Export your data from the app, reduce the oversized item, or ask your',
    'server administrator to raise the email attachment limit before the next scheduled attempt.</p>',
  ].join(' ')
}
