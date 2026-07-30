export const Strings = {
  UnsupportedBackupFileVersion:
    'This backup file was created using a newer version of the application and cannot be imported here. Please update your application and try again.',
  BackupFileMoreRecentThanAccount:
    "This backup file was created using a newer encryption version than your account's. Please run the available encryption upgrade and try again.",
  FileAccountPassword: 'File account password',
  BackupItemsUnavailable: (count: number) =>
    `Backup creation stopped because ${count} ${count === 1 ? 'item could' : 'items could'} not be read in full from local storage. No incomplete backup was created. Sync your data, resolve any errored items, and try again.`,
  BackupItemsMissingFromOutput: (count: number) =>
    `Backup creation stopped because ${count} ${count === 1 ? 'item was' : 'items were'} missing from the generated output. No incomplete backup was created. Please try again.`,
  DecryptedBackupItemsUnreadable: (count: number) =>
    `Decrypted backup creation stopped because ${count} ${count === 1 ? 'item is' : 'items are'} encrypted but unreadable with the keys currently available. No incomplete backup was created. Sync your data or resolve errored items, then try again.`,
}
