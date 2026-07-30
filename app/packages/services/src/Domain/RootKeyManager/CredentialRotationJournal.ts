import {
  EncryptedTransferPayload,
  ItemContent,
  RootKeyContentSpecialized,
  RootKeyInterface,
} from '@standardnotes/models'

export enum CredentialRotationPhase {
  Prepared = 'prepared',
  ServerConfirmed = 'server-confirmed',
  LocalItemsPersisted = 'local-items-persisted',
  RollbackPending = 'rollback-pending',
  RollbackConfirmed = 'rollback-confirmed',
}

/**
 * Secret rotation material. This value is only ever serialized inside the two
 * encrypted payloads on CredentialRotationJournal. The outer journal contains
 * no password, root key, wrapping key, or email in plaintext.
 */
export type CredentialRotationBundleContent = ItemContent & {
  schemaVersion: 1
  currentEmail: string
  newEmail: string
  currentRootKey: RootKeyContentSpecialized
  newRootKey: RootKeyContentSpecialized
  wrappingKey?: RootKeyContentSpecialized
}

/**
 * A crash-recovery record for account credential rotation.
 *
 * The same secret bundle is encrypted once by each side of the rotation. This
 * lets launch recovery proceed whether the device persisted the old root or the
 * new root before an interruption. Only ciphertext and non-secret state-machine
 * metadata are stored in the nonwrapped storage domain.
 */
export type CredentialRotationJournal = {
  schemaVersion: 1
  operationId: string
  phase: CredentialRotationPhase
  createdAt: number
  bundleEncryptedByCurrentRoot: EncryptedTransferPayload
  bundleEncryptedByNewRoot: EncryptedTransferPayload
  /**
   * The exact pre-rotation Type-A ciphertexts. They remain encrypted by the
   * current root and allow confirmed rollback (or new-root restaging) before
   * the local database is loaded after a crash.
   */
  rollbackPayloads: EncryptedTransferPayload[]
  newItemsKeyUuid?: string
}

export type CredentialRotationSecrets = {
  currentEmail: string
  newEmail: string
  currentRootKey: RootKeyInterface
  newRootKey: RootKeyInterface
  wrappingKey?: RootKeyInterface
}
