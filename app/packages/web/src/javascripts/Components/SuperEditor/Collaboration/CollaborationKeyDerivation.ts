import { isLitePayload, type SNNote, type KeySystemRootKeyInterface, type RootKeyInterface } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import {
  getSuperCollaborationAvailability,
  SUPER_COLLABORATION_SIGN_IN_REASON,
  SUPER_COLLABORATION_VAULT_KEY_REASON,
  SuperCollaborationAvailability,
} from './CollaborationAvailability'

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
  /** Opaque in-memory sign-in epoch; strict identity changes on sign-out/login. */
  sessionUser: object
  username: string
  sourceId: string
}

type UnavailableKeySource = {
  available: false
  reason: string
}

export type CollaborationKeySource = AvailableKeySource | UnavailableKeySource

export type NoteEncryptionIdentity = Readonly<{
  noteUuid: string
  userUuid: string
  sessionUser: object
  sourceId: string
  keySystemIdentifier: string | null
  sharedVaultUuid: string | null
}>

/**
 * Resolve and cross-check the live key source synchronously. Vault notes use the
 * exact unlocked key-system root; ordinary notes use the signed-in account root.
 * Every identifier must agree, and locked notes fail closed.
 */
function resolveEncryptionKeySource(application: WebApplication, note: SNNote): CollaborationKeySource {
  if (isLitePayload(note.payload)) {
    return {
      available: false,
      reason: 'Live collaboration is waiting for the full encrypted note body to load.',
    }
  }
  try {
    if (!application.isAuthorizedToRenderItem(note)) {
      return {
        available: false,
        reason: 'Unlock protected note access to use live collaboration.',
      }
    }
  } catch {
    return {
      available: false,
      reason: 'Unlock protected note access to use live collaboration.',
    }
  }

  const user = application.sessions.getUser()
  const authenticated = application.sessions.isSignedIn() && user !== undefined
  if (!authenticated || !user) {
    return { available: false, reason: SUPER_COLLABORATION_SIGN_IN_REASON }
  }
  const vault = application.vaults.getItemVault(note)
  if (!vault && note.user_uuid !== user.uuid) {
    return {
      available: false,
      reason: 'Live collaboration stopped because the note and account encryption key do not match.',
    }
  }
  const vaultRootKey = vault && !note.locked ? application.vaultLocks.getUnlockedVaultRootKey(vault) : undefined
  const accountRootKey = !vault && !note.locked ? application.encryption.getRootKey() : undefined
  const encryptionKeyAvailable = vault ? Boolean(vaultRootKey?.key) : Boolean(accountRootKey?.masterKey)

  if (!encryptionKeyAvailable) {
    return { available: false, reason: SUPER_COLLABORATION_VAULT_KEY_REASON }
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
      sessionUser: user,
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
    sessionUser: user,
    username: user.email || 'Collaborator',
    sourceId: vaultRootKeySourceId(vaultRootKey, keyScope, note.uuid),
  }
}

export function resolveCollaborationKeySource(application: WebApplication, note: SNNote): CollaborationKeySource {
  const platformAvailability = getSuperCollaborationAvailability()
  return platformAvailability.available ? resolveEncryptionKeySource(application, note) : platformAvailability
}

export function noteEncryptionIdentityFromSource(
  note: SNNote,
  source: Pick<AvailableKeySource, 'noteUuid' | 'userUuid' | 'sessionUser' | 'sourceId'>,
): NoteEncryptionIdentity {
  return {
    noteUuid: source.noteUuid,
    userUuid: source.userUuid,
    sessionUser: source.sessionUser,
    sourceId: source.sourceId,
    keySystemIdentifier: note.key_system_identifier ?? null,
    sharedVaultUuid: note.shared_vault_uuid ?? null,
  }
}

/**
 * Resolve immutable session + root-key identity without depending on realtime
 * platform/transport availability. Durable comment writes use this primitive
 * even when collaboration itself is unavailable.
 */
export function resolveNoteEncryptionIdentity(
  application: WebApplication,
  note: SNNote,
): NoteEncryptionIdentity | undefined {
  const source = resolveEncryptionKeySource(application, note)
  return source.available ? noteEncryptionIdentityFromSource(note, source) : undefined
}

export function matchesNoteEncryptionIdentity(
  application: WebApplication,
  expected: NoteEncryptionIdentity,
  candidate = application.items.findItem<SNNote>(expected.noteUuid),
): boolean {
  if (!candidate || candidate.uuid !== expected.noteUuid) {
    return false
  }
  const current = resolveEncryptionKeySource(application, candidate)
  return (
    current.available &&
    current.noteUuid === expected.noteUuid &&
    current.userUuid === expected.userUuid &&
    current.sessionUser === expected.sessionUser &&
    current.sourceId === expected.sourceId &&
    (candidate.key_system_identifier ?? null) === expected.keySystemIdentifier &&
    (candidate.shared_vault_uuid ?? null) === expected.sharedVaultUuid
  )
}

export type PreparedCollaborationAccess =
  | {
      available: false
      reason: string
      sourceId?: string
    }
  | {
      available: true
      noteUuid: string
      sourceId: string
      roomKey: CryptoKey
      capability: string
      serverUpdatedAtTimestamp: number
      userUuid: string
      sessionUser: object
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
  authorizationContext?: {
    leaseRequestId?: string
    bootstrapChallenge?: string
  },
): Promise<PreparedCollaborationAccess> {
  const before = resolveCollaborationKeySource(application, note)
  if (!before.available) {
    return before
  }

  let roomKey: CryptoKey
  let authorization: { capability: string; serverUpdatedAtTimestamp: number } | undefined
  try {
    ;[roomKey, authorization] = await Promise.all([
      deriveCollaborationRoomKey({
        rootKeySecret: before.rootKeySecret,
        keyScope: before.keyScope,
        noteUuid: before.noteUuid,
      }),
      application.sockets.authorizeCollaborationRoom(
        before.noteUuid,
        authorizationContext?.leaseRequestId,
        authorizationContext?.bootstrapChallenge,
      ),
    ])
  } catch {
    return {
      available: false,
      reason: 'Live collaboration could not establish a secure room.',
      sourceId: before.sourceId,
    }
  }

  if (!authorization) {
    return {
      available: false,
      reason: 'The server did not authorize live editing for this note. Edit permission is required.',
      sourceId: before.sourceId,
    }
  }

  const after = resolveCollaborationKeySource(application, note)
  if (
    !after.available ||
    after.sourceId !== before.sourceId ||
    after.noteUuid !== before.noteUuid ||
    after.userUuid !== before.userUuid ||
    after.sessionUser !== before.sessionUser ||
    after.keyScope !== before.keyScope ||
    after.rootKeySecret !== before.rootKeySecret
  ) {
    return {
      available: false,
      reason: after.available ? 'The note encryption key changed while collaboration was starting.' : after.reason,
      sourceId: before.sourceId,
    }
  }

  return {
    available: true,
    noteUuid: after.noteUuid,
    sourceId: after.sourceId,
    roomKey,
    capability: authorization.capability,
    serverUpdatedAtTimestamp: authorization.serverUpdatedAtTimestamp,
    userUuid: after.userUuid,
    sessionUser: after.sessionUser,
    username: after.username,
  }
}

export function availabilityReason(value: SuperCollaborationAvailability): string | undefined {
  return value.available ? undefined : value.reason
}
