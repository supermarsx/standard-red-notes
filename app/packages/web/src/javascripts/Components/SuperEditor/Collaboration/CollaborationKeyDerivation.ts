import type { SNNote, KeySystemRootKeyInterface, RootKeyInterface } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import { getSuperCollaborationAvailability, SuperCollaborationAvailability } from './CollaborationAvailability'

const COLLABORATION_HKDF_SALT = 'Standard Red Notes encrypted collaboration room key v1'

function vaultRootKeySourceId(rootKey: KeySystemRootKeyInterface, keyScope: string, noteUuid: string): string {
  // This non-key rotation identity is retained only in memory and is never
  // rendered, logged, serialized, or persisted. The token is encrypted root-key
  // payload metadata (not key material). Vault + note identity ensures a render
  // that switches notes cannot expose the previous note's prepared capability,
  // key, or editor lease before React runs effect cleanup; root-key metadata
  // ensures in-place rotation invalidates every provider.
  return JSON.stringify([
    'vault',
    keyScope,
    noteUuid,
    rootKey.uuid,
    rootKey.keyParams.creationTimestamp,
    rootKey.token,
    rootKey.serverUpdatedAtTimestamp,
  ])
}

function accountRootKeySourceId(rootKey: RootKeyInterface, userUuid: string, noteUuid: string): string {
  // Account key parameters are public KDF metadata and change with credential
  // rotation. They let us synchronously invalidate a mounted provider without
  // retaining or serializing a fingerprint of the account master key itself.
  return JSON.stringify(['account', userUuid, noteUuid, rootKey.keyVersion, rootKey.keyParams.getPortableValue()])
}

const subtle = (): SubtleCrypto => {
  const value = globalThis.crypto?.subtle
  if (!value) {
    throw new Error('WebCrypto SubtleCrypto unavailable')
  }
  return value
}

/**
 * Derive a per-note AES-256-GCM key from the note's current client-only root
 * secret (account root for an ordinary note, key-system root for a vault note).
 *
 * HKDF uses an explicit SRN collaboration domain plus a stable encryption scope
 * and note UUID. The resulting key is non-extractable and can only encrypt or
 * decrypt; neither the root secret nor derived key is serialized, logged, or
 * sent to the relay. Public UUIDs alone are never accepted as key material.
 */
export async function deriveCollaborationRoomKey(input: {
  rootKeySecret: string
  keyScope: string
  noteUuid: string
}): Promise<CryptoKey> {
  if (!input.rootKeySecret || !input.keyScope || !input.noteUuid) {
    throw new Error('Root key, encryption scope, and note UUID are required')
  }

  const encoder = new TextEncoder()
  const secretBytes = encoder.encode(input.rootKeySecret)
  try {
    const sourceKey = await subtle().importKey('raw', secretBytes, 'HKDF', false, ['deriveKey'])
    return await subtle().deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: encoder.encode(COLLABORATION_HKDF_SALT),
        info: encoder.encode(`scope=${input.keyScope}\u0000note=${input.noteUuid}`),
      },
      sourceKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } finally {
    secretBytes.fill(0)
  }
}

type AvailableKeySource = {
  available: true
  noteUuid: string
  keyScope: string
  rootKeySecret: string
  userUuid: string
  username: string
  sourceId: string
}

type UnavailableKeySource = {
  available: false
  reason: string
}

export type CollaborationKeySource = AvailableKeySource | UnavailableKeySource

/**
 * Resolve and cross-check the live key source synchronously. Vault notes use the
 * exact unlocked key-system root; ordinary notes use the signed-in account root.
 * Every identifier must agree, and locked notes fail closed.
 */
export function resolveCollaborationKeySource(application: WebApplication, note: SNNote): CollaborationKeySource {
  const platformAvailability = getSuperCollaborationAvailability()
  if (!platformAvailability.available) {
    return platformAvailability
  }

  const user = application.sessions.getUser()
  const authenticated = application.sessions.isSignedIn() && user !== undefined
  const vault = application.vaults.getItemVault(note)
  const vaultRootKey = vault && !note.locked ? application.vaultLocks.getUnlockedVaultRootKey(vault) : undefined
  const accountRootKey = !vault && !note.locked ? application.encryption.getRootKey() : undefined
  const encryptionKeyAvailable = vault ? Boolean(vaultRootKey?.key) : Boolean(accountRootKey?.masterKey)

  const availability = getSuperCollaborationAvailability({
    authenticated,
    encryptionKeyAvailable,
  })
  if (!availability.available) {
    return availability
  }

  if (!user) {
    return {
      available: false,
      reason: 'Sign in to use live collaboration.',
    }
  }

  if (!vault) {
    if (!accountRootKey?.masterKey || note.key_system_identifier || note.shared_vault_uuid) {
      return {
        available: false,
        reason: 'Live collaboration stopped because the note and account encryption key do not match.',
      }
    }
    const keyScope = `account:${user.uuid}`
    return {
      available: true,
      noteUuid: note.uuid,
      keyScope,
      rootKeySecret: accountRootKey.masterKey,
      userUuid: user.uuid,
      username: user.email || 'Collaborator',
      sourceId: accountRootKeySourceId(accountRootKey, user.uuid, note.uuid),
    }
  }

  const sharedVaultUuid = vault.isSharedVaultListing() ? vault.sharing.sharedVaultUuid : undefined
  const identifiersMatch =
    note.key_system_identifier === vault.systemIdentifier &&
    note.shared_vault_uuid === sharedVaultUuid &&
    vaultRootKey?.systemIdentifier === vault.systemIdentifier
  if (!vaultRootKey?.key || !identifiersMatch) {
    return {
      available: false,
      reason: 'Live collaboration stopped because the note and vault encryption key do not match.',
    }
  }

  const keyScope = vault.isSharedVaultListing()
    ? `shared-vault:${sharedVaultUuid}`
    : `vault:${vault.uuid}:${vault.systemIdentifier}`
  return {
    available: true,
    noteUuid: note.uuid,
    keyScope,
    rootKeySecret: vaultRootKey.key,
    userUuid: user.uuid,
    username: user.email || 'Collaborator',
    sourceId: vaultRootKeySourceId(vaultRootKey, keyScope, note.uuid),
  }
}

export type PreparedCollaborationAccess =
  | {
      available: false
      reason: string
      sourceId?: string
    }
  | {
      available: true
      sourceId: string
      roomKey: CryptoKey
      capability: string
      userUuid: string
      username: string
    }

/**
 * Prepare the key and exact-note room capability, then re-check the source.
 * Rotation, locking, membership removal, sign-out, or socket loss during either
 * await invalidates the result instead of mounting a provider with stale access.
 */
export async function prepareCollaborationAccess(
  application: WebApplication,
  note: SNNote,
): Promise<PreparedCollaborationAccess> {
  const before = resolveCollaborationKeySource(application, note)
  if (!before.available) {
    return before
  }

  let roomKey: CryptoKey
  let capability: string | undefined
  try {
    ;[roomKey, capability] = await Promise.all([
      deriveCollaborationRoomKey({
        rootKeySecret: before.rootKeySecret,
        keyScope: before.keyScope,
        noteUuid: before.noteUuid,
      }),
      application.sockets.authorizeCollaborationRoom(before.noteUuid),
    ])
  } catch {
    return {
      available: false,
      reason: 'Live collaboration could not establish a secure room.',
      sourceId: before.sourceId,
    }
  }

  if (!capability) {
    return {
      available: false,
      reason: 'The server did not authorize live editing for this note. Edit permission is required.',
      sourceId: before.sourceId,
    }
  }

  const after = resolveCollaborationKeySource(application, note)
  if (!after.available || after.sourceId !== before.sourceId || after.noteUuid !== before.noteUuid) {
    return {
      available: false,
      reason: after.available ? 'The note encryption key changed while collaboration was starting.' : after.reason,
      sourceId: before.sourceId,
    }
  }

  return {
    available: true,
    sourceId: after.sourceId,
    roomKey,
    capability,
    userUuid: after.userUuid,
    username: after.username,
  }
}

export function availabilityReason(value: SuperCollaborationAvailability): string | undefined {
  return value.available ? undefined : value.reason
}
