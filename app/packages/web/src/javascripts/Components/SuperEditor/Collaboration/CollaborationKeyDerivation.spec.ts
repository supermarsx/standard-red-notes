/**
 * @jest-environment node
 */
import { webcrypto } from 'node:crypto'
import { createRoomCipher } from './RoomCrypto'
import { deriveCollaborationRoomKey, resolveCollaborationKeySource } from './CollaborationKeyDerivation'

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
})

const hasSubtle = Boolean(globalThis.crypto?.subtle)
const maybe = hasSubtle ? describe : describe.skip

maybe('collaboration room-key derivation', () => {
  it('derives the same non-extractable AES-256-GCM key for two vault members', async () => {
    const input = {
      rootKeySecret: 'client-only-shared-vault-root-secret',
      sharedVaultUuid: 'vault-uuid',
      noteUuid: 'note-uuid',
    }
    const first = await deriveCollaborationRoomKey(input)
    const second = await deriveCollaborationRoomKey(input)

    expect(first.extractable).toBe(false)
    expect(first.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    expect(first.usages).toEqual(['encrypt', 'decrypt'])
    await expect(globalThis.crypto.subtle.exportKey('raw', first)).rejects.toBeDefined()

    const plaintext = new TextEncoder().encode('private collaborative content')
    const payload = await createRoomCipher(first).encrypt(plaintext)
    expect(payload).not.toContain('private collaborative content')
    await expect(createRoomCipher(second).decrypt(payload)).resolves.toEqual(plaintext)
  })

  it('isolates notes and vaults through HKDF domain separation', async () => {
    const shared = {
      rootKeySecret: 'same-root-secret',
      sharedVaultUuid: 'vault-a',
      noteUuid: 'note-a',
    }
    const ciphertext = await createRoomCipher(await deriveCollaborationRoomKey(shared)).encrypt(
      new TextEncoder().encode('secret'),
    )
    const wrongNote = await deriveCollaborationRoomKey({ ...shared, noteUuid: 'note-b' })
    const wrongVault = await deriveCollaborationRoomKey({ ...shared, sharedVaultUuid: 'vault-b' })

    await expect(createRoomCipher(wrongNote).decrypt(ciphertext)).rejects.toBeDefined()
    await expect(createRoomCipher(wrongVault).decrypt(ciphertext)).rejects.toBeDefined()
  })
})

describe('resolveCollaborationKeySource', () => {
  const vault = {
    uuid: 'vault-listing',
    systemIdentifier: 'vault-system-a',
    sharing: { sharedVaultUuid: 'shared-vault-a' },
    isSharedVaultListing: () => true,
  }
  const note = {
    uuid: 'note-a',
    locked: false,
    key_system_identifier: 'vault-system-a',
    shared_vault_uuid: 'shared-vault-a',
  }
  const application = (rootKey: {
    uuid: string
    systemIdentifier: string
    key: string
    token: string
    keyParams: { creationTimestamp: number }
    serverUpdatedAtTimestamp: number
  }) =>
    ({
      sessions: {
        isSignedIn: () => true,
        getUser: () => ({ uuid: 'user-a', email: 'alice@example.com' }),
      },
      vaults: { getItemVault: () => vault },
      vaultLocks: {
        isVaultLocked: () => false,
        getUnlockedSharedVaultRootKey: () => rootKey,
      },
      sockets: { isWebSocketConnectionOpen: () => true },
    }) as never

  it('accepts an exact note-vault-root-key chain', () => {
    expect(
      resolveCollaborationKeySource(
        application({
          uuid: 'root-a',
          systemIdentifier: 'vault-system-a',
          key: 'secret-a',
          token: 'rotation-a',
          keyParams: { creationTimestamp: 100 },
          serverUpdatedAtTimestamp: 100,
        }),
        note as never,
      ),
    ).toMatchObject({
      available: true,
      noteUuid: 'note-a',
      sharedVaultUuid: 'shared-vault-a',
      sourceId: expect.stringContaining('"note-a"'),
    })
  })

  it('changes source identity when switching notes inside the same vault with the same root key', () => {
    const rootKey = {
      uuid: 'root-a',
      systemIdentifier: 'vault-system-a',
      key: 'secret-a',
      token: 'rotation-a',
      keyParams: { creationTimestamp: 100 },
      serverUpdatedAtTimestamp: 100,
    }
    const before = resolveCollaborationKeySource(application(rootKey), note as never)
    const after = resolveCollaborationKeySource(application(rootKey), { ...note, uuid: 'note-b' } as never)

    if (!before.available || !after.available) {
      throw new Error('Expected both same-vault notes to resolve')
    }
    expect(after.sourceId).not.toBe(before.sourceId)
  })

  it('changes source identity when key material rotates in place under the same item UUID', () => {
    const before = resolveCollaborationKeySource(
      application({
        uuid: 'root-a',
        systemIdentifier: 'vault-system-a',
        key: 'secret-a',
        token: 'rotation-a',
        keyParams: { creationTimestamp: 100 },
        serverUpdatedAtTimestamp: 100,
      }),
      note as never,
    )
    const after = resolveCollaborationKeySource(
      application({
        uuid: 'root-a',
        systemIdentifier: 'vault-system-a',
        key: 'secret-b',
        token: 'rotation-b',
        keyParams: { creationTimestamp: 200 },
        serverUpdatedAtTimestamp: 200,
      }),
      note as never,
    )

    if (!before.available || !after.available) {
      throw new Error('Expected both in-memory root-key versions to resolve')
    }
    expect(after.sourceId).not.toBe(before.sourceId)
  })

  it('rejects a root key from a different vault even when all public note fields look valid', () => {
    expect(
      resolveCollaborationKeySource(
        application({
          uuid: 'root-b',
          systemIdentifier: 'vault-system-b',
          key: 'wrong-secret',
          token: 'rotation-b',
          keyParams: { creationTimestamp: 100 },
          serverUpdatedAtTimestamp: 100,
        }),
        note as never,
      ),
    ).toEqual({
      available: false,
      reason: 'Live collaboration stopped because the note and shared-vault encryption key do not match.',
    })
  })
})
