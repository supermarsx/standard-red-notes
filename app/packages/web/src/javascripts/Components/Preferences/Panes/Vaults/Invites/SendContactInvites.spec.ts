import { Result, SharedVaultListingInterface, TrustedContactInterface } from '@standardnotes/snjs'
import { describeContactInviteFailures, sendContactInvites } from './SendContactInvites'

const vault = { systemIdentifier: 'vault-1' } as unknown as SharedVaultListingInterface

/**
 * Mirrors `InviteFailure` in services/.../VaultInvite/UseCase/InviteToVault.ts, which is the single
 * source of truth. Copied rather than imported because `@standardnotes/snjs` resolves to its built
 * bundle here, so an import would make this suite depend on a package rebuild.
 */
const NoSelfContactFailure =
  'Your own contact record could not be created, so the invitee would have no way to verify who invited them. Make sure you are signed in and that syncing has completed, then try again.'
const NoKeySystemRootKeyFailure =
  "This vault's key is not available on this device, so there is nothing to share with the invitee. Unlock the vault in Preferences → Vaults and try again."

function contact(uuid: string, name: string): TrustedContactInterface {
  return { uuid, name, contactUuid: `user-${uuid}` } as unknown as TrustedContactInterface
}

describe('sendContactInvites', () => {
  it('reports a use case failure that aborted before any request instead of swallowing it', async () => {
    const alice = contact('a', 'Alice')
    const invite = jest.fn().mockResolvedValue(Result.fail(NoSelfContactFailure))

    const result = await sendContactInvites({
      vault,
      contacts: [alice],
      selectedContacts: [{ uuid: 'a', permission: 'read' }],
      invite,
    })

    expect(result.sentContactUuids).toEqual([])
    expect(result.failures).toEqual([{ contactName: 'Alice', message: NoSelfContactFailure }])
  })

  it('keeps inviting the remaining contacts after one rejects', async () => {
    const alice = contact('a', 'Alice')
    const bob = contact('b', 'Bob')
    const invite = jest
      .fn()
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce(Result.ok({}))

    const result = await sendContactInvites({
      vault,
      contacts: [alice, bob],
      selectedContacts: [
        { uuid: 'a', permission: 'read' },
        { uuid: 'b', permission: 'admin' },
      ],
      invite,
    })

    expect(invite).toHaveBeenCalledTimes(2)
    expect(result.sentContactUuids).toEqual(['b'])
    expect(result.failures).toEqual([{ contactName: 'Alice', message: 'Network request failed' }])
  })

  it('forwards the vault, resolved contact and permission for each selection', async () => {
    const alice = contact('a', 'Alice')
    const invite = jest.fn().mockResolvedValue(Result.ok({}))

    await sendContactInvites({
      vault,
      contacts: [alice],
      selectedContacts: [{ uuid: 'a', permission: 'admin' }],
      invite,
    })

    expect(invite).toHaveBeenCalledWith(vault, alice, 'admin')
  })

  it('reports a selection whose contact is no longer loaded rather than skipping it silently', async () => {
    const invite = jest.fn().mockResolvedValue(Result.ok({}))

    const result = await sendContactInvites({
      vault,
      contacts: [],
      selectedContacts: [{ uuid: 'gone', permission: 'read' }],
      invite,
    })

    expect(invite).not.toHaveBeenCalled()
    expect(result.failures).toEqual([
      { contactName: 'Unknown contact', message: 'This contact is no longer available to invite.' },
    ])
  })

  it('records every successful invite when nothing fails', async () => {
    const invite = jest.fn().mockResolvedValue(Result.ok({}))

    const result = await sendContactInvites({
      vault,
      contacts: [contact('a', 'Alice'), contact('b', 'Bob')],
      selectedContacts: [
        { uuid: 'a', permission: 'read' },
        { uuid: 'b', permission: 'write' },
      ],
      invite,
    })

    expect(result.failures).toEqual([])
    expect(result.sentContactUuids).toEqual(['a', 'b'])
  })
})

describe('describeContactInviteFailures', () => {
  it('names each contact and the reason its invite never went out', () => {
    const message = describeContactInviteFailures({
      sentContactUuids: [],
      failures: [
        { contactName: 'Alice', message: NoKeySystemRootKeyFailure },
        { contactName: 'Bob', message: NoSelfContactFailure },
      ],
    })

    expect(message).toContain('None of the invites could be sent:')
    expect(message).toContain(`Alice: ${NoKeySystemRootKeyFailure}`)
    expect(message).toContain(`Bob: ${NoSelfContactFailure}`)
    // Distinguishable: the two contacts failed for different reasons and the user can see which.
    expect(NoKeySystemRootKeyFailure).not.toEqual(NoSelfContactFailure)
  })

  it('counts the partial failure against the whole selection', () => {
    const message = describeContactInviteFailures({
      sentContactUuids: ['a', 'b'],
      failures: [{ contactName: 'Carol', message: NoSelfContactFailure }],
    })

    expect(message).toContain('1 of 3 invites could not be sent:')
  })
})
