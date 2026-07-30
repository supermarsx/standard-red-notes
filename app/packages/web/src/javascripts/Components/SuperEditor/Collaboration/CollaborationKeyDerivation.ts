import type { SNNote, KeySystemRootKeyInterface, SharedVaultListingInterface } from '@standardnotes/snjs'
import type { WebApplication } from '@/Application/WebApplication'
import { getSuperCollaborationAvailability, SuperCollaborationAvailability } from './CollaborationAvailability'

const COLLABORATION_HKDF_SALT = 'Standard Red Notes encrypted collaboration room key v1'

function collaborationRootKeySourceId(
  rootKey: KeySystemRootKeyInterface,
  sharedVaultUuid: string,
  noteUuid: string,
): string {
  // This non-key rotation identity is retained only in memory and is never
  // rendered, logged, serialized, or persisted. The token is encrypted root-key
  // payload metadata (not key material). Vault + note identity ensures a render
  // that switches notes cannot expose the previous note's prepared capability,
  // key, or editor lease before React runs effect cleanup; root-key metadata
  // ensures in-place rotation invalidates every provider.
  return JSON.stringify([
    sharedVaultUuid,
    noteUuid,
    rootKey.uuid,
    rootKey.keyParams.creationTimestamp,
    rootKey.token,
    rootKey.serverUpdatedAtTimestamp,
  ])
}

const subtle = (): SubtleCrypto => {
  const value = globalThis.crypto?.subtle
  if (!value) {
    throw new Error('WebCrypto SubtleCrypto unavailable')
  }
  return value
}

/**
 * Derive a per-note AES-256-GCM key from the current shared-vault root secret.
 *
 * HKDF uses an explicit SRN collaboration domain plus both the shared-vault UUID
 * and note UUID. The resulting key is non-extractable and can only encrypt or
 * decrypt; neither the root secret nor derived key is serialized, logged, or
 * sent to the relay.
 */
export async function deriveCollaborationRoomKey(input: {
  rootKeySecret: string
  sharedVaultUuid: string
  noteUuid: string
}): Promise<CryptoKey> {
  if (!input.rootKeySecret || !input.sharedVaultUuid || !input.noteUuid) {
    throw new Error('Shared-vault root key, vault UUID, and note UUID are required')
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
        info: encoder.encode(`vault=${input.sharedVaultUuid}\u0000note=${input.noteUuid}`),
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
  sharedVaultUuid: string
  rootKey: KeySystemRootKeyInterface
  vault: SharedVaultListingInterface
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
 * Resolve and cross-check the live key source synchronously. Every identifier
 * must agree (note -> vault listing -> root key); a root key for another vault
 * is rejected even if a caller accidentally supplies it.
 */
export function resolveCollaborationKeySource(application: WebApplication, note: SNNote): CollaborationKeySource {
  const platformAvailability = getSuperCollaborationAvailability()
  if (!platformAvailability.available) {
    return platformAvailability
  }

  const authenticated = application.sessions.isSignedIn() && application.sessions.getUser() !== undefined
  const vault = application.vaults.getItemVault(note)
  const sharedVault = vault?.isSharedVaultListing() === true
  let rootKey: KeySystemRootKeyInterface | undefined

  if (sharedVault && vault && !note.locked && !application.vaultLocks.isVaultLocked(vault)) {
    rootKey = application.vaultLocks.getUnlockedSharedVaultRootKey(vault)
  }

  const availability = getSuperCollaborationAvailability({
    authenticated,
    sharedVault,
    vaultKeyAvailable: Boolean(rootKey) && !note.locked,
    transportConnected: application.sockets.isWebSocketConnectionOpen(),
  })
  if (!availability.available) {
    return availability
  }

  if (!vault?.isSharedVaultListing()) {
    return {
      available: false,
      reason: 'Live collaboration is only available for notes in a shared vault.',
    }
  }

  const sharedVaultListing: SharedVaultListingInterface = vault
  const user = application.sessions.getUser()
  const sharedVaultUuid = sharedVaultListing.sharing.sharedVaultUuid
  const identifiersMatch =
    note.key_system_identifier === sharedVaultListing.systemIdentifier &&
    note.shared_vault_uuid === sharedVaultUuid &&
    rootKey?.systemIdentifier === sharedVaultListing.systemIdentifier

  if (!user || !rootKey || !rootKey.key || !sharedVaultUuid || !identifiersMatch) {
    return {
      available: false,
      reason: 'Live collaboration stopped because the note and shared-vault encryption key do not match.',
    }
  }

  return {
    available: true,
    noteUuid: note.uuid,
    sharedVaultUuid,
    rootKey,
    vault: sharedVaultListing,
    userUuid: user.uuid,
    username: user.email || 'Collaborator',
    sourceId: collaborationRootKeySourceId(rootKey, sharedVaultUuid, note.uuid),
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
        rootKeySecret: before.rootKey.key,
        sharedVaultUuid: before.sharedVaultUuid,
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
      reason: after.available ? 'The shared-vault key changed while collaboration was starting.' : after.reason,
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
