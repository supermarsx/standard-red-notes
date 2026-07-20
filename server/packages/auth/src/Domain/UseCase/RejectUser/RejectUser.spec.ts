import 'reflect-metadata'
import { Result } from '@standardnotes/domain-core'

import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { DeleteAccount } from '../DeleteAccount/DeleteAccount'

import { RejectUser } from './RejectUser'

describe('RejectUser', () => {
  let userRepository: jest.Mocked<UserRepositoryInterface>
  let deleteAccount: jest.Mocked<DeleteAccount>
  let user: User

  const validUuid = '00000000-0000-0000-0000-000000000001'

  beforeEach(() => {
    user = new User()
    user.uuid = validUuid
    user.approved = false // pending

    userRepository = {
      findOneByUuid: jest.fn().mockResolvedValue(user),
    } as unknown as jest.Mocked<UserRepositoryInterface>

    deleteAccount = {
      execute: jest.fn().mockResolvedValue(Result.ok('User deleted.')),
    } as unknown as jest.Mocked<DeleteAccount>
  })

  it('rejects a pending user via the DeleteAccount pipeline', async () => {
    const result = await new RejectUser(userRepository, deleteAccount).execute({ userUuid: validUuid })

    expect(result.isFailed()).toBe(false)
    expect(deleteAccount.execute).toHaveBeenCalledWith({ userUuid: validUuid })
  })

  it('refuses to reject an already-approved (active) account', async () => {
    user.approved = true
    const result = await new RejectUser(userRepository, deleteAccount).execute({ userUuid: validUuid })

    expect(result.isFailed()).toBe(true)
    expect(deleteAccount.execute).not.toHaveBeenCalled()
  })

  it('fails for a missing user', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)
    const result = await new RejectUser(userRepository, deleteAccount).execute({ userUuid: validUuid })

    expect(result.isFailed()).toBe(true)
  })

  it('fails on a malformed uuid before touching the repository', async () => {
    const result = await new RejectUser(userRepository, deleteAccount).execute({ userUuid: 'not-a-uuid' })

    expect(result.isFailed()).toBe(true)
    expect(userRepository.findOneByUuid).not.toHaveBeenCalled()
    expect(deleteAccount.execute).not.toHaveBeenCalled()
  })

  it('propagates a failure from the DeleteAccount pipeline', async () => {
    deleteAccount.execute = jest.fn().mockResolvedValue(Result.fail('Could not delete account.'))

    const result = await new RejectUser(userRepository, deleteAccount).execute({ userUuid: validUuid })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toEqual('Could not delete account.')
  })
})
