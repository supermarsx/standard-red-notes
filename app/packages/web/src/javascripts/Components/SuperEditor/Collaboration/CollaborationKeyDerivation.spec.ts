/**
 * @jest-environment jsdom
 */
import { webcrypto } from 'node:crypto'
import { TextDecoder, TextEncoder } from 'node:util'
import { createRoomCipher } from './RoomCrypto'
import {
  deriveCollaborationRoomKey,
  prepareCollaborationAccess,
  resolveCollaborationKeySource,
} from './CollaborationKeyDerivation'

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
})
Object.defineProperty(globalThis, 'TextEncoder', { configurable: true, value: TextEncoder })
Object.defineProperty(globalThis, 'TextDecoder', { configurable: true, value: TextDecoder })

const hasSubtle = Boolean(globalThis.crypto?.subtle)
const maybe = hasSubtle ? describe : describe.skip

maybe('collaboration room-key derivation', () => {
  it.each([
    ['a missing epoch', { capability: 'capability', serverUpdatedAtTimestamp: 100, collaborationProtocolVersion: 3 }],
    [
      'a malformed epoch',
      {
        capability: 'capability',
        roomEpoch: 'not a safe epoch',
        serverUpdatedAtTimestamp: 100,
        collaborationProtocolVersion: 3,
      },
    ],
    [
      'a legacy protocol epoch',
      {
        capability: 'capability',
        roomEpoch: 'room_epoch_0000000000000001',
        serverUpdatedAtTimestamp: 100,
        collaborationProtocolVersion: 2,
      },
    ],
  ])('fails closed when authorization returns %s', async (_case, authorization) => {
    const sessionUser = { uuid: 'user-a', email: 'alice@example.com' }
    const application = {
      sessions: { isSignedIn: () => true, getUser: () => sessionUser },
      vaults: { getItemVault: () => undefined },
      vaultLocks: { getUnlockedVaultRootKey: () => undefined },
      encryption: {
        getRootKey: () => ({
          masterKey: 'account-root',
          keyVersion: '004',
          keyParams: { getPortableValue: () => ({ identifier: 'alice', pw_nonce: 'parameters' }) },
        }),
      },
      sockets: { authorizeCollaborationRoom: async () => authorization },
      isAuthorizedToRenderItem: () => true,
    } as never
    const note = {
      uuid: 'personal-note',
      user_uuid: 'user-a',
      locked: false,
      key_system_identifier: undefined,
      shared_vault_uuid: undefined,
    } as never

    await expect(prepareCollaborationAccess(application, note)).resolves.toEqual({
      available: false,
      reason: 'The collaboration gateway did not provide a valid encrypted room epoch.',
      sourceId: expect.any(String),
    })
  })

  it('derives the same non-extractable AES-256-GCM key for two vault members', async () => {
    const input = {
      rootKeySecret: 'client-only-shared-vault-root-secret',
      keyScope: 'shared-vault:vault-uuid',
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
      keyScope: 'shared-vault:vault-a',
      noteUuid: 'note-a',
    }
    const ciphertext = await createRoomCipher(await deriveCollaborationRoomKey(shared)).encrypt(
      new TextEncoder().encode('secret'),
    )
    const wrongNote = await deriveCollaborationRoomKey({ ...shared, noteUuid: 'note-b' })
    const wrongVault = await deriveCollaborationRoomKey({ ...shared, keyScope: 'shared-vault:vault-b' })

    await expect(createRoomCipher(wrongNote).decrypt(ciphertext)).rejects.toBeDefined()
    await expect(createRoomCipher(wrongVault).decrypt(ciphertext)).rejects.toBeDefined()
  })

  it('rejects an authorization resolved after a same-UUID sign-out and relogin', async () => {
    const firstSession = { uuid: 'user-a', email: 'alice@example.com' }
    const secondSession = { uuid: 'user-a', email: 'alice@example.com' }
    let activeSession = firstSession
    let resolveAuthorization!: (value: {
      capability: string
      roomEpoch: string
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 3
    }) => void
    const authorization = new Promise<{
      capability: string
      roomEpoch: string
      serverUpdatedAtTimestamp: number
      collaborationProtocolVersion: 3
    }>((resolve) => {
      resolveAuthorization = resolve
    })
    const application = {
      sessions: {
        isSignedIn: () => true,
        getUser: () => activeSession,
      },
      vaults: { getItemVault: () => undefined },
      vaultLocks: { getUnlockedVaultRootKey: () => undefined },
      encryption: {
        getRootKey: () => ({
          masterKey: 'same-account-root',
          keyVersion: '004',
          keyParams: { getPortableValue: () => ({ identifier: 'alice', pw_nonce: 'same-params' }) },
        }),
      },
      sockets: { authorizeCollaborationRoom: () => authorization },
      isAuthorizedToRenderItem: () => true,
    } as never
    const note = {
      uuid: 'personal-note',
      user_uuid: 'user-a',
      locked: false,
      key_system_identifier: undefined,
      shared_vault_uuid: undefined,
    } as never

    const preparation = prepareCollaborationAccess(application, note)
    activeSession = secondSession
    resolveAuthorization({
      capability: 'old-session-capability',
      roomEpoch: 'room_epoch_0000000000000001',
      serverUpdatedAtTimestamp: 100,
      collaborationProtocolVersion: 3,
    })

    await expect(preparation).resolves.toMatchObject({
      available: false,
      reason: 'The note encryption key changed while collaboration was starting.',
    })
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
        getUnlockedVaultRootKey: () => rootKey,
      },
      encryption: { getRootKey: () => undefined },
      sockets: { isWebSocketConnectionOpen: () => true },
      isAuthorizedToRenderItem: () => true,
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
      keyScope: 'shared-vault:shared-vault-a',
      sourceId: expect.stringContaining('"note-a"'),
    })
  })

  it('rejects a body-stripped lite note before reading vault or key material', () => {
    const getItemVault = jest.fn()
    const getUnlockedVaultRootKey = jest.fn()
    const liteApplication = Object.assign(
      {},
      application({
        uuid: 'root-a',
        systemIdentifier: 'vault-system-a',
        key: 'secret-a',
        token: 'rotation-a',
        keyParams: { creationTimestamp: 100 },
        serverUpdatedAtTimestamp: 100,
      }) as unknown as object,
      {
        vaults: { getItemVault },
        vaultLocks: { getUnlockedVaultRootKey },
      },
    ) as never

    expect(
      resolveCollaborationKeySource(liteApplication, {
        ...note,
        payload: { content: { __lazyLite: true } },
      } as never),
    ).toEqual({
      available: false,
      reason: 'Live collaboration is waiting for the full encrypted note body to load.',
    })
    expect(getItemVault).not.toHaveBeenCalled()
    expect(getUnlockedVaultRootKey).not.toHaveBeenCalled()
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
      reason: 'Live collaboration stopped because the note and vault encryption key do not match.',
    })
  })

  it('uses the account root for an ordinary personal note and isolates it by account', () => {
    const accountRoot = {
      masterKey: 'account-master-key',
      keyVersion: '004',
      keyParams: { getPortableValue: () => ({ identifier: 'alice', pw_nonce: 'rotation-a' }) },
    }
    const personalApplication = {
      sessions: {
        isSignedIn: () => true,
        getUser: () => ({ uuid: 'user-a', email: 'alice@example.com' }),
      },
      vaults: { getItemVault: () => undefined },
      vaultLocks: { getUnlockedVaultRootKey: () => undefined },
      encryption: { getRootKey: () => accountRoot },
      isAuthorizedToRenderItem: () => true,
    } as never

    expect(
      resolveCollaborationKeySource(personalApplication, {
        uuid: 'personal-note',
        user_uuid: 'user-a',
        locked: false,
        key_system_identifier: undefined,
        shared_vault_uuid: undefined,
      } as never),
    ).toMatchObject({
      available: true,
      keyScope: 'account:user-a',
      rootKeySecret: 'account-master-key',
      sourceId: expect.stringContaining('personal-note'),
    })
  })

  it('rejects an ordinary note owned by a prior account before reading the current root key', () => {
    const getRootKey = jest.fn(() => ({
      masterKey: 'must-not-cross-accounts',
      keyVersion: '004',
      keyParams: { getPortableValue: () => ({ identifier: 'current-user' }) },
    }))
    const personalApplication = {
      sessions: {
        isSignedIn: () => true,
        getUser: () => ({ uuid: 'current-user', email: 'current@example.com' }),
      },
      vaults: { getItemVault: () => undefined },
      vaultLocks: { getUnlockedVaultRootKey: jest.fn() },
      encryption: { getRootKey },
      isAuthorizedToRenderItem: () => true,
    } as never

    expect(
      resolveCollaborationKeySource(personalApplication, {
        uuid: 'same-uuid-from-prior-account',
        user_uuid: 'prior-user',
        locked: false,
        key_system_identifier: undefined,
        shared_vault_uuid: undefined,
      } as never),
    ).toEqual({
      available: false,
      reason: 'Live collaboration stopped because the note and account encryption key do not match.',
    })
    expect(getRootKey).not.toHaveBeenCalled()
  })

  it('fails closed before reading key material when a protected-note session expires', () => {
    const getRootKey = jest.fn(() => ({
      masterKey: 'must-not-be-read',
      keyVersion: '004',
      keyParams: { getPortableValue: () => ({ identifier: 'alice' }) },
    }))
    const getItemVault = jest.fn()
    const protectedApplication = {
      sessions: {
        isSignedIn: () => true,
        getUser: () => ({ uuid: 'user-a', email: 'alice@example.com' }),
      },
      vaults: { getItemVault },
      vaultLocks: { getUnlockedVaultRootKey: jest.fn() },
      encryption: { getRootKey },
      isAuthorizedToRenderItem: jest.fn(() => false),
    } as never

    expect(
      resolveCollaborationKeySource(protectedApplication, {
        uuid: 'protected-note',
        protected: true,
        locked: false,
      } as never),
    ).toEqual({
      available: false,
      reason: 'Unlock protected note access to use live collaboration.',
    })
    expect(getRootKey).not.toHaveBeenCalled()
    expect(getItemVault).not.toHaveBeenCalled()
  })

  it('uses an unlocked private-vault root and rejects a locked note', () => {
    const privateVault = {
      uuid: 'private-vault-listing',
      systemIdentifier: 'private-system',
      isSharedVaultListing: () => false,
    }
    const privateRoot = {
      uuid: 'private-root',
      systemIdentifier: 'private-system',
      key: 'private-vault-secret',
      token: 'private-rotation',
      keyParams: { creationTimestamp: 100 },
      serverUpdatedAtTimestamp: 100,
    }
    const privateApplication = {
      sessions: {
        isSignedIn: () => true,
        getUser: () => ({ uuid: 'user-a', email: 'alice@example.com' }),
      },
      vaults: { getItemVault: () => privateVault },
      vaultLocks: { getUnlockedVaultRootKey: () => privateRoot },
      encryption: { getRootKey: () => undefined },
      isAuthorizedToRenderItem: () => true,
    } as never
    const privateNote = {
      uuid: 'private-note',
      locked: false,
      key_system_identifier: 'private-system',
      shared_vault_uuid: undefined,
    }

    expect(resolveCollaborationKeySource(privateApplication, privateNote as never)).toMatchObject({
      available: true,
      keyScope: 'vault:private-vault-listing:private-system',
      rootKeySecret: 'private-vault-secret',
    })
    expect(resolveCollaborationKeySource(privateApplication, { ...privateNote, locked: true } as never)).toEqual({
      available: false,
      reason: 'Unlock or sync the note encryption key to use live collaboration.',
    })
  })
})
