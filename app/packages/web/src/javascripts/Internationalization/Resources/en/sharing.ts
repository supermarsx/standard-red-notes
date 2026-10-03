/**
 * English strings for sharing & collaboration (share links, invites, vaults,
 * comments/mentions, permissions). Source of truth: other locales fall back to
 * these until translated.
 */
const sharing = {
  vaultSelectionMenu: 'Vault selection menu',
  vaultOptionsMenu: 'Vault options menu',
  vaultOptions: 'Vault options',
  noVaultsFound: 'No vaults found',
  moveToVault: 'Move to vault',
  moveOutOfVault: 'Move out of {{name}}',
  vaultsFallbackName: 'vaults',
  editVault: 'Edit vault',
  lockVault: 'Lock vault',
  unlockVault: 'Unlock vault',
  openVaultSettings: 'Open vault settings',
  selectionModeMultiple: 'Multiple',
  selectionModeOne: 'One',
  lastEditedBy: 'Last edited by',
  sharedBy: 'Shared by',
  sharedByContact: 'Shared by contact',
  vaultName: 'Vault name',
  sharedInVault: 'Shared in vault',
  copiedToClipboard: 'Copied to clipboard',
  failedToCopyToClipboard: 'Failed to copy to clipboard',
  copyExampleToClipboard: 'Copy example to clipboard',
  copiedExclaim: 'Copied!',
  shareUnavailableTitle: 'Share unavailable',
  shareUnavailableMessage: 'This share link is no longer available.',
  // A share link can fail in four unrelated ways, plus a catch-all for anything
  // unrecognised. All of them used to share ONE sentence ("This share link is
  // invalid or the key is missing."), which told the reader nothing they could
  // act on — a truncated link, a server that did not return the ciphertext, a
  // wrong key and a browser that could not load libsodium all looked identical.
  // Each now says which happened, without ever echoing the key or any note
  // content.
  missingKeyTitle: 'This link is missing its key',
  missingKeyMessage:
    'A share link ends with a “#” followed by its decryption key, and that part is missing here. Ask the sender for the whole link, including everything after the “#”.',
  payloadUnreadableTitle: 'This link could not be read',
  payloadUnreadableMessage:
    'The server answered, but its reply did not contain the shared content. The link itself looks complete, so this is a problem on the server rather than with your copy of the link.',
  undecryptableTitle: 'This link could not be decrypted',
  undecryptableMessage:
    'The shared content arrived, but the key in this link does not open it. The key after the “#” may have been altered or truncated, or the link may have been replaced since it was created.',
  cryptoUnavailableTitle: 'This browser could not decrypt the link',
  cryptoUnavailableMessage:
    'Shared notes are decrypted in your browser, and the decryption library failed to load. Try again, or open the link in a different browser.',
  unexpectedFailureTitle: 'This link could not be opened',
  unexpectedFailureMessage:
    'Something went wrong that we do not have a specific explanation for. The browser console holds the underlying error.',
  technicalDetailLabel: 'Technical detail',
  selfDestructTitle: 'This note self-destructs after viewing',
  oneTimeViewConsumed: 'You are reading a one-time-view link. It has now been consumed and cannot be reopened',
  oneTimeViewExpiresClause_one: ', and fully expires {{count}} minute from the first open',
  oneTimeViewExpiresClause_other: ', and fully expires {{count}} minutes from the first open',
  linkExpires_one: 'This link expires {{count}} minute after it was first opened.',
  linkExpires_other: 'This link expires {{count}} minutes after it was first opened.',
  untitled: 'Untitled',
  tagHasNoNotes: 'This tag has no notes.',
  publicReadOnlyFooter: 'This is a public, read-only shared link. The content was decrypted in your browser.',
  confidentialWatermark: 'Confidential · {{datetime}}',
  contentHiddenTitle: 'Content hidden',
  contentHiddenMessage: 'Return focus to this window to view the shared content.',
}

export default sharing
