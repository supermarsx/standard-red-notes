import { Result, SharedVaultListingInterface, TrustedContactInterface } from '@standardnotes/snjs'
import { describeContactInviteFailures, sendContactInvites } from './SendContactInvites'

const vault = { systemIdentifier: 'vault-1' } as unknown as SharedVaultListingInterface

function contact(uuid: string, name: string): TrustedContactInterface {
  return { uuid, name, contactUuid: `user-${uuid}` } as unknown as TrustedContactInterface
}

describe('sendContactInvites', () => {
  it('reports a use case failure that aborted before any request instead of swallowing it', async () => {
    const alice = contact('a', 'Alice')
    const invite = jest.fn().mockResolvedValue(Result.fail('Cannot invite contact; me contact not found'))

    const result = await sendContactInvites({
      vault,
      contacts: [alice],
      selectedContacts: [{ uuid: 'a', permission: 'read' }],
      invite,
    })

    expect(result.sentContactUuids).toEqual([])
    expect(result.failures).toEqual([{ contactName: 'Alice', message: 'Cannot invite contact; me contact not found' }])
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
        { contactName: 'Alice', message: 'Cannot invite contact; key system root key not found' },
        { contactName: 'Bob', message: 'Account keypair not found' },
      ],
    })

    expect(message).toContain('None of the invites could be sent:')
    expect(message).toContain('Alice: Cannot invite contact; key system root key not found')
    expect(message).toContain('Bob: Account keypair not found')
  })

  it('counts the partial failure against the whole selection', () => {
    const message = describeContactInviteFailures({
      sentContactUuids: ['a', 'b'],
      failures: [{ contactName: 'Carol', message: 'Cannot invite contact; me contact not found' }],
    })

    expect(message).toContain('1 of 3 invites could not be sent:')
  })
})
