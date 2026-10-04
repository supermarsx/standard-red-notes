import { Result } from '@standardnotes/domain-core'
import { SharedVaultListingInterface, TrustedContactInterface } from '@standardnotes/models'
import { InviteFailure, InviteToVault } from './InviteToVault'

/**
 * Covers the two halves of the broken-collaboration bug:
 *
 *  - "me" is resolved from the account's own self-contact, NOT searched for in the vault's
 *    server-derived contact list (where the owner's entry vanished whenever no self-contact
 *    existed, which was every shipped build).
 *  - each precondition reports which one was missing and what to do, instead of three
 *    interchangeable strings naming internal objects.
 */
describe('InviteToVault', () => {
  const sharedVault = {
    name: 'Team vault',
    description: 'desc',
    iconString: 'safe-square',
    systemIdentifier: 'key-system-1',
    sharing: { sharedVaultUuid: 'shared-1', fileBytesUsed: 0, designatedSurvivor: null },
  } as unknown as SharedVaultListingInterface

  const contact = (uuid: string, name: string, isMe = false) =>
    ({
      uuid: `item-${uuid}`,
      name,
      isMe,
      contactUuid: uuid,
      publicKeySet: { encryption: `enc-${uuid}`, signing: `sig-${uuid}` },
    }) as unknown as TrustedContactInterface

  const recipient = contact('recipient-uuid', 'Chico')
  const selfContact = contact('owner-uuid', 'Me', true)
  const otherMember = contact('other-uuid', 'Dana')

  let keyManager: { getPrimaryKeySystemRootKey: jest.Mock }
  let encryptMessage: { execute: jest.Mock }
  let sendInvite: { execute: jest.Mock }
  let shareContact: { execute: jest.Mock }
  let getKeyPairs: { execute: jest.Mock }
  let selfContactManager: { getOrCreateSelfContact: jest.Mock }

  const createUseCase = () =>
    new InviteToVault(
      keyManager as never,
      encryptMessage as never,
      sendInvite as never,
      shareContact as never,
      getKeyPairs as never,
      selfContactManager as never,
    )

  const execute = (sharedVaultContacts: TrustedContactInterface[] = []) =>
    createUseCase().execute({ sharedVault, sharedVaultContacts, recipient, permission: 'read' })

  beforeEach(() => {
    keyManager = { getPrimaryKeySystemRootKey: jest.fn().mockReturnValue({ content: { key: 'root-key-secret' } }) }
    encryptMessage = { execute: jest.fn().mockReturnValue(Result.ok('encrypted-message')) }
    sendInvite = { execute: jest.fn().mockResolvedValue(Result.ok({ uuid: 'invite-1' })) }
    shareContact = { execute: jest.fn().mockResolvedValue(Result.ok()) }
    getKeyPairs = {
      execute: jest.fn().mockReturnValue(
        Result.ok({
          encryption: { publicKey: 'own-enc-pub', privateKey: 'own-enc-priv' },
          signing: { publicKey: 'own-sig-pub', privateKey: 'own-sig-priv' },
        }),
      ),
    }
    selfContactManager = { getOrCreateSelfContact: jest.fn().mockResolvedValue(selfContact) }
  })

  it('sends the invite using the self contact even when the vault contact list has no isMe entry', async () => {
    const result = await execute([otherMember, recipient])

    expect(result.isFailed()).toBe(false)
    expect(selfContactManager.getOrCreateSelfContact).toHaveBeenCalled()

    const delegated = encryptMessage.execute.mock.calls[0][0].message.data.trustedContacts
    expect(delegated[0]).toEqual({
      name: undefined,
      contactUuid: 'owner-uuid',
      publicKeySet: selfContact.publicKeySet,
    })
    // The recipient is never delegated to themselves, and only the remaining member is.
    expect(delegated.slice(1).map((entry: { contactUuid: string }) => entry.contactUuid)).toEqual(['other-uuid'])

    expect(sendInvite.execute).toHaveBeenCalledWith({
      sharedVaultUuid: 'shared-1',
      recipientUuid: 'recipient-uuid',
      encryptedMessage: 'encrypted-message',
      permission: 'read',
    })
  })

  it('does not delegate the self contact twice when it is also present in the vault contact list', async () => {
    await execute([selfContact, otherMember])

    const delegated = encryptMessage.execute.mock.calls[0][0].message.data.trustedContacts
    expect(delegated.filter((entry: { contactUuid: string }) => entry.contactUuid === 'owner-uuid')).toHaveLength(1)
  })

  it('reports a missing account key pair and issues no request', async () => {
    getKeyPairs.execute.mockReturnValue(Result.fail('no keys'))

    const result = await execute([selfContact])

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe(InviteFailure.NoAccountKeyPair)
    expect(sendInvite.execute).not.toHaveBeenCalled()
  })

  it('reports a missing vault key and issues no request', async () => {
    keyManager.getPrimaryKeySystemRootKey.mockReturnValue(undefined)

    const result = await execute([selfContact])

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe(InviteFailure.NoKeySystemRootKey)
    expect(sendInvite.execute).not.toHaveBeenCalled()
  })

  it('reports an unavailable self contact and issues no request', async () => {
    selfContactManager.getOrCreateSelfContact.mockResolvedValue(undefined)

    const result = await execute([otherMember])

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe(InviteFailure.NoSelfContact)
    expect(sendInvite.execute).not.toHaveBeenCalled()
  })

  it('gives each precondition its own message, so the user can tell which step failed', () => {
    const messages = Object.values(InviteFailure)

    expect(new Set(messages).size).toBe(messages.length)
    for (const message of messages) {
      expect(message).toMatch(/Preferences|signed in/)
    }
  })

  it('leaks no uuid or key material into a message a user may paste publicly', () => {
    const secrets = [
      'owner-uuid',
      'recipient-uuid',
      'shared-1',
      'key-system-1',
      'root-key-secret',
      'own-enc-pub',
      'own-sig-pub',
      'enc-recipient-uuid',
    ]

    for (const message of Object.values(InviteFailure)) {
      for (const secret of secrets) {
        expect(message).not.toContain(secret)
      }
      expect(message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    }
  })

  it('shares the recipient with the other vault members once the invite is sent', async () => {
    await execute([otherMember])

    expect(shareContact.execute).toHaveBeenCalledWith({ sharedVault, contactToShare: recipient })
  })

  it('rejects an invalid permission before touching the vault key', async () => {
    const result = await createUseCase().execute({
      sharedVault,
      sharedVaultContacts: [selfContact],
      recipient,
      permission: 'superuser',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toContain('Invalid shared vault user permission')
    expect(sendInvite.execute).not.toHaveBeenCalled()
  })
})
