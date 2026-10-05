import { Result } from '@standardnotes/domain-core'
import {
  AsymmetricMessagePayloadType,
  AsymmetricMessageSharedVaultRootKeyChanged,
  KeySystemRootKeyContentSpecialized,
  KeySystemRootKeyParamsInterface,
  ProtocolVersion,
  VaultListing,
  VaultListingInterface,
} from '@standardnotes/models'

import { MutatorClientInterface } from '../../Mutator/MutatorClientInterface'
import { SyncServiceInterface } from '../../Sync/SyncServiceInterface'
import { GetVault } from '../../Vault/UseCase/GetVault'
import { DecryptErroredPayloads } from '../../Encryption/UseCase/DecryptErroredPayloads'
import { HandleRootKeyChangedMessage, RootKeyChangedRejection } from './HandleRootKeyChangedMessage'

/**
 * A `SharedVaultRootKeyChanged` message is only legitimately sent by the OWNER of the shared vault
 * whose key system it names (`RotateVaultKey.shareNewKeyWithMembers` returns early for everyone
 * else). Decrypting and signature-verifying the message proves only that it came from one of our
 * TrustedContacts, and we hold a contact for every co-member of every vault we have ever joined, so
 * these specs pin the owner check that stands between "a trusted contact said so" and "the primary
 * key system root key of this vault is now a key the sender chose".
 */
describe('HandleRootKeyChangedMessage', () => {
  const VaultOwnerUuid = '00000000-0000-0000-0000-00000000own1'
  const OtherContactUuid = '00000000-0000-0000-0000-0000000att1'
  const SystemIdentifier = 'key-system-under-attack'

  let mutator: jest.Mocked<MutatorClientInterface>
  let sync: jest.Mocked<SyncServiceInterface>
  let getVault: jest.Mocked<GetVault>
  let decryptErroredPayloads: jest.Mocked<DecryptErroredPayloads>
  let useCase: HandleRootKeyChangedMessage

  /**
   * Prototyped off the real `VaultListing` so `isSharedVaultListing()` is the production
   * implementation rather than a stub: a plain object cast would answer whatever the cast claimed
   * and the specs below would pass against a use case that never consulted it.
   */
  const makeVaultListing = (sharing: { sharedVaultUuid: string; ownerUserUuid: string } | undefined) => {
    const listing = Object.create(VaultListing.prototype) as VaultListingInterface
    // `uuid` is a getter on the GenericItem prototype, so it is deliberately not assigned here.
    Object.assign(listing, {
      systemIdentifier: SystemIdentifier,
      name: 'Vault',
      sharing,
      rootKeyParams: { creationTimestamp: 1 } as unknown as KeySystemRootKeyParamsInterface,
    })

    return listing
  }

  const makeMessage = (creationTimestamp: number): AsymmetricMessageSharedVaultRootKeyChanged => ({
    type: AsymmetricMessagePayloadType.SharedVaultRootKeyChanged,
    data: {
      recipientUuid: '00000000-0000-0000-0000-00000000rec1',
      rootKey: {
        systemIdentifier: SystemIdentifier,
        key: 'attacker-chosen-key',
        keyVersion: ProtocolVersion.V004,
        token: 'token',
        keyParams: { creationTimestamp } as unknown as KeySystemRootKeyParamsInterface,
      } as KeySystemRootKeyContentSpecialized,
    },
  })

  beforeEach(() => {
    mutator = {} as jest.Mocked<MutatorClientInterface>
    mutator.createItem = jest.fn()
    mutator.changeItem = jest.fn()

    sync = {} as jest.Mocked<SyncServiceInterface>
    sync.sync = jest.fn()

    getVault = {} as jest.Mocked<GetVault>
    getVault.execute = jest.fn()

    decryptErroredPayloads = {} as jest.Mocked<DecryptErroredPayloads>
    decryptErroredPayloads.execute = jest.fn()

    useCase = new HandleRootKeyChangedMessage(mutator, sync, getVault, decryptErroredPayloads)
  })

  it('applies the rotated key when the sender owns the shared vault that owns the key system', async () => {
    const listing = makeVaultListing({ sharedVaultUuid: 'shared-vault-uuid', ownerUserUuid: VaultOwnerUuid })
    getVault.execute = jest.fn().mockReturnValue(Result.ok(listing))

    // Preconditions: this really is a shared vault, and the sender really is its owner — otherwise
    // the assertions below would be satisfied by a rejection path instead of the accept path.
    expect(listing.isSharedVaultListing()).toBe(true)
    expect(listing.sharing?.ownerUserUuid).toBe(VaultOwnerUuid)

    const result = await useCase.execute(makeMessage(500), VaultOwnerUuid)

    expect(result).toEqual({ applied: true })
    expect(mutator.createItem).toHaveBeenCalledTimes(1)
    expect(mutator.changeItem).toHaveBeenCalledTimes(1)
    expect(decryptErroredPayloads.execute).toHaveBeenCalledTimes(1)
  })

  it('rejects a rotated key from a trusted contact who is not the vault owner', async () => {
    const listing = makeVaultListing({ sharedVaultUuid: 'shared-vault-uuid', ownerUserUuid: VaultOwnerUuid })
    getVault.execute = jest.fn().mockReturnValue(Result.ok(listing))

    // Preconditions: the vault is locally known and shared (so the lookup cannot be what fails) and
    // the sender is a different account from its owner.
    expect(listing.isSharedVaultListing()).toBe(true)
    expect(OtherContactUuid).not.toBe(VaultOwnerUuid)

    // A far-future creation timestamp is what would make the injected key the PRIMARY root key for
    // this key system (`KeySystemKeyManager.getPrimaryKeySystemRootKey` sorts by it), i.e. the whole
    // point of the attack this check exists to stop.
    const result = await useCase.execute(makeMessage(Number.MAX_SAFE_INTEGER), OtherContactUuid)

    expect(result).toEqual({ applied: false, reason: RootKeyChangedRejection.SenderIsNotVaultOwner })
    expect(mutator.createItem).not.toHaveBeenCalled()
    expect(mutator.changeItem).not.toHaveBeenCalled()
    expect(decryptErroredPayloads.execute).not.toHaveBeenCalled()
  })

  it('rejects a rotated key aimed at the key system of a private, non-shared vault', async () => {
    const listing = makeVaultListing(undefined)
    getVault.execute = jest.fn().mockReturnValue(Result.ok(listing))

    // Precondition: the listing is genuinely not a shared vault, so this is the non-shared branch
    // rather than an owner mismatch.
    expect(listing.isSharedVaultListing()).toBe(false)

    const result = await useCase.execute(makeMessage(Number.MAX_SAFE_INTEGER), OtherContactUuid)

    expect(result).toEqual({ applied: false, reason: RootKeyChangedRejection.NotASharedVault })
    expect(mutator.createItem).not.toHaveBeenCalled()
    expect(mutator.changeItem).not.toHaveBeenCalled()
  })

  it('still stores the key when the key system is not locally known yet, without touching any listing', async () => {
    const lookup = Result.fail<VaultListingInterface>('Vault not found')
    getVault.execute = jest.fn().mockReturnValue(lookup)

    // Precondition: the lookup genuinely failed. Asymmetric messages are handled before the
    // retrieved payloads of the same sync response are emitted, so a legitimate rotation can arrive
    // ahead of its VaultListing and must not be discarded.
    expect(lookup.isFailed()).toBe(true)

    const result = await useCase.execute(makeMessage(500), VaultOwnerUuid)

    expect(result).toEqual({ applied: true })
    expect(mutator.createItem).toHaveBeenCalledTimes(1)
    expect(mutator.changeItem).not.toHaveBeenCalled()
  })
})
