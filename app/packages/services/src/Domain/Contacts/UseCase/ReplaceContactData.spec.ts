import { ContentType, Result } from '@standardnotes/domain-core'
import {
  ContactPublicKeySet,
  ContactPublicKeySetInterface,
  DecryptedPayload,
  FillItemContentSpecialized,
  MutationType,
  PayloadTimestampDefaults,
  TrustedContact,
  TrustedContactContentSpecialized,
  TrustedContactInterface,
  TrustedContactMutator,
} from '@standardnotes/models'

import { MutatorClientInterface } from '../../Mutator/MutatorClientInterface'
import { SyncServiceInterface } from '../../Sync/SyncServiceInterface'
import { FindContact } from './FindContact'
import { ReplaceContactData } from './ReplaceContactData'

describe('ReplaceContactData', () => {
  const CONTACT_UUID = 'contact-uuid'

  let mutator: MutatorClientInterface
  let sync: SyncServiceInterface
  let findContact: FindContact
  let useCase: ReplaceContactData

  const createKeySetChain = (): ContactPublicKeySetInterface =>
    new ContactPublicKeySet({
      encryption: 'encryption-current',
      signing: 'signing-current',
      timestamp: new Date(2),
      previousKeySet: new ContactPublicKeySet({
        encryption: 'encryption-rotated-away-from',
        signing: 'signing-rotated-away-from',
        timestamp: new Date(1),
        previousKeySet: undefined,
      }),
    })

  const createContact = (params: {
    name?: string
    isMe?: boolean
    publicKeySet: ContactPublicKeySetInterface
  }): TrustedContactInterface =>
    new TrustedContact(
      new DecryptedPayload({
        uuid: 'item-uuid',
        content_type: ContentType.TYPES.TrustedContact,
        ...PayloadTimestampDefaults(),
        content: FillItemContentSpecialized<TrustedContactContentSpecialized, TrustedContactInterface>({
          name: params.name ?? 'Original Name',
          contactUuid: CONTACT_UUID,
          isMe: params.isMe ?? false,
          publicKeySet: params.publicKeySet,
        }),
      }),
    )

  /**
   * Runs the real TrustedContactMutator so the resulting key set — and therefore the chain — is what
   * production would actually persist, rather than whatever a recorded mutator callback is asserted
   * to have been handed.
   */
  const installRealMutator = () => {
    const changeItem = jest.fn(
      async (
        item: TrustedContactInterface,
        mutate: (mutator: TrustedContactMutator) => void,
      ): Promise<TrustedContactInterface> => {
        const contactMutator = new TrustedContactMutator(item, MutationType.UpdateUserTimestamps)
        mutate(contactMutator)
        return new TrustedContact(contactMutator.getResult())
      },
    )

    mutator.changeItem = changeItem as unknown as MutatorClientInterface['changeItem']

    return changeItem
  }

  beforeEach(() => {
    mutator = {} as jest.Mocked<MutatorClientInterface>
    mutator.createItem = jest.fn()

    sync = {} as jest.Mocked<SyncServiceInterface>
    sync.sync = jest.fn()

    findContact = {} as jest.Mocked<FindContact>

    useCase = new ReplaceContactData(mutator, sync, findContact)
  })

  it('creates the contact when none exists yet', async () => {
    findContact.execute = jest.fn().mockReturnValue(Result.fail('Not found'))
    const created = createContact({ publicKeySet: createKeySetChain() })
    mutator.createItem = jest.fn().mockResolvedValue(created)

    const result = await useCase.execute({
      name: 'New Contact',
      contactUuid: CONTACT_UUID,
      isMe: false,
      publicKeySet: createKeySetChain().asJson(),
    })

    expect(result.isFailed()).toBe(false)
    expect(mutator.createItem).toHaveBeenCalled()
    expect(sync.sync).toHaveBeenCalled()
  })

  it('refuses to replace data for the me contact', async () => {
    const meContact = createContact({ isMe: true, publicKeySet: createKeySetChain() })

    // Precondition: the contact really is the me contact, so the refusal is the isMe branch.
    expect(meContact.isMe).toBe(true)

    findContact.execute = jest.fn().mockReturnValue(Result.ok(meContact))
    const changeItem = installRealMutator()

    const result = await useCase.execute({
      name: 'Attacker Chosen Name',
      contactUuid: CONTACT_UUID,
      isMe: false,
      publicKeySet: createKeySetChain().asJson(),
    })

    expect(result.isFailed()).toBe(true)
    expect(changeItem).not.toHaveBeenCalled()
  })

  it('appends a rotated key and preserves the previous key chain', async () => {
    const existing = createContact({ publicKeySet: createKeySetChain() })

    // Preconditions: the contact really holds a two-link chain before the update, so "the chain
    // survived" below cannot be true of a contact that never had one.
    expect(existing.publicKeySet.encryption).toEqual('encryption-current')
    expect(existing.publicKeySet.previousKeySet?.signing).toEqual('signing-rotated-away-from')

    findContact.execute = jest.fn().mockReturnValue(Result.ok(existing))
    const changeItem = installRealMutator()

    const result = await useCase.execute({
      name: 'Rotated Contact',
      contactUuid: CONTACT_UUID,
      isMe: false,
      publicKeySet: new ContactPublicKeySet({
        encryption: 'encryption-rotated-to',
        signing: 'signing-rotated-to',
        timestamp: new Date(3),
        previousKeySet: undefined,
      }).asJson(),
    })

    expect(result.isFailed()).toBe(false)
    expect(changeItem).toHaveBeenCalledTimes(1)

    const updated = result.getValue()

    // The rotation took effect...
    expect(updated.name).toEqual('Rotated Contact')
    expect(updated.publicKeySet.encryption).toEqual('encryption-rotated-to')
    expect(updated.publicKeySet.signing).toEqual('signing-rotated-to')

    // ...and the whole prior chain is still reachable, which is what decides whether an item signed
    // with a superseded key reads as "signed with a non-current key" rather than "not trusted".
    expect(updated.publicKeySet.previousKeySet?.encryption).toEqual('encryption-current')
    expect(updated.publicKeySet.previousKeySet?.previousKeySet?.encryption).toEqual('encryption-rotated-away-from')
    expect(updated.publicKeySet.findKeySetWithSigningKey('signing-current')).toBeDefined()
    expect(updated.publicKeySet.findKeySetWithSigningKey('signing-rotated-away-from')).toBeDefined()
  })

  it('does not grow the chain when the shared key set is unchanged', async () => {
    const existing = createContact({ publicKeySet: createKeySetChain() })

    findContact.execute = jest.fn().mockReturnValue(Result.ok(existing))
    installRealMutator()

    const result = await useCase.execute({
      name: 'Renamed Contact',
      contactUuid: CONTACT_UUID,
      isMe: false,
      // Byte-identical current keys, as every repeated ContactShare carries.
      publicKeySet: createKeySetChain().asJson(),
    })

    expect(result.isFailed()).toBe(false)

    const updated = result.getValue()

    expect(updated.name).toEqual('Renamed Contact')
    expect(updated.publicKeySet.encryption).toEqual('encryption-current')
    // Still exactly two links — not three with 'encryption-current' duplicated.
    expect(updated.publicKeySet.previousKeySet?.encryption).toEqual('encryption-rotated-away-from')
    expect(updated.publicKeySet.previousKeySet?.previousKeySet).toBeUndefined()
  })

  it('cannot be used to erase a previously trusted key', async () => {
    const existing = createContact({ publicKeySet: createKeySetChain() })

    findContact.execute = jest.fn().mockReturnValue(Result.ok(existing))
    installRealMutator()

    // A sender supplying a key set with NO history at all used to overwrite the whole set.
    const result = await useCase.execute({
      name: 'Original Name',
      contactUuid: CONTACT_UUID,
      isMe: false,
      publicKeySet: new ContactPublicKeySet({
        encryption: 'encryption-supplied-by-sender',
        signing: 'signing-supplied-by-sender',
        timestamp: new Date(9),
        previousKeySet: undefined,
      }).asJson(),
    })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().publicKeySet.findKeySetWithSigningKey('signing-current')).toBeDefined()
    expect(result.getValue().publicKeySet.findKeySetWithSigningKey('signing-rotated-away-from')).toBeDefined()
  })
})
