import { Result } from '@standardnotes/domain-core'
import { TrustedContactInterface } from '@standardnotes/models'
import { GetVaultContacts } from './GetVaultContacts'

/**
 * `GetVaultUsers` already returns the server's own reason for refusing the member list. This use
 * case used to replace it with a fixed 'Failed to get vault users', and
 * `VaultInviteService.inviteContactToSharedVault` surfaced that string verbatim — a fourth
 * indistinguishable, unactionable message in the invite alert. The reason must survive.
 */
describe('GetVaultContacts', () => {
  const contact = (uuid: string) => ({ uuid: `item-${uuid}`, contactUuid: uuid }) as unknown as TrustedContactInterface

  let findContact: { execute: jest.Mock }
  let getVaultUsers: { execute: jest.Mock }

  const createUseCase = () => new GetVaultContacts(findContact as never, getVaultUsers as never)

  beforeEach(() => {
    findContact = { execute: jest.fn() }
    getVaultUsers = { execute: jest.fn() }
  })

  it("preserves the server's reason when the member list cannot be read", async () => {
    getVaultUsers.execute.mockResolvedValue(Result.fail('Shared vault not found'))

    const result = await createUseCase().execute({ sharedVaultUuid: 'shared-1', readFromCache: false })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toBe('Shared vault not found')
    expect(result.getError()).not.toBe('Failed to get vault users')
  })

  it('resolves each vault user to its local contact', async () => {
    getVaultUsers.execute.mockResolvedValue(Result.ok([{ user_uuid: 'a' }, { user_uuid: 'b' }]))
    findContact.execute.mockImplementation(({ userUuid }: { userUuid: string }) => Result.ok(contact(userUuid)))

    const result = await createUseCase().execute({ sharedVaultUuid: 'shared-1', readFromCache: false })

    expect(result.isFailed()).toBe(false)
    expect(result.getValue().map((entry) => entry.contactUuid)).toEqual(['a', 'b'])
  })

  it('drops a vault user with no local contact rather than failing the whole list', async () => {
    getVaultUsers.execute.mockResolvedValue(Result.ok([{ user_uuid: 'a' }, { user_uuid: 'stranger' }]))
    findContact.execute.mockImplementation(({ userUuid }: { userUuid: string }) =>
      userUuid === 'a' ? Result.ok(contact('a')) : Result.fail('Contact not found'),
    )

    const result = await createUseCase().execute({ sharedVaultUuid: 'shared-1', readFromCache: false })

    expect(result.getValue().map((entry) => entry.contactUuid)).toEqual(['a'])
  })

  it('forwards the cache preference to GetVaultUsers', async () => {
    getVaultUsers.execute.mockResolvedValue(Result.ok([]))

    await createUseCase().execute({ sharedVaultUuid: 'shared-1', readFromCache: true })

    expect(getVaultUsers.execute).toHaveBeenCalledWith({ sharedVaultUuid: 'shared-1', readFromCache: true })
  })
})
