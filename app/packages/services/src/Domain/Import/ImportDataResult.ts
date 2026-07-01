import { DecryptedItemInterface } from '@standardnotes/models'

export type ImportDataResult = {
  // Items that were either created or dirtied by this import
  affectedItems: DecryptedItemInterface[]

  // The number of items that were not imported due to failure to decrypt.
  // NOTE: with PERSIST-H2, un-decryptable items are no longer dropped — they are
  // imported as encrypted (see encryptedItemUuids). errorCount now only reflects
  // results that could not be imported at all (none, under the current logic).
  errorCount: number

  // PERSIST-H2: uuids of items that were imported but remain ENCRYPTED because
  // they could not be decrypted with the available keys at import time. They are
  // persisted as ciphertext and will be decrypted automatically once the correct
  // key becomes available. The UI can surface this as "N items imported still-encrypted".
  encryptedItemUuids: string[]
}
