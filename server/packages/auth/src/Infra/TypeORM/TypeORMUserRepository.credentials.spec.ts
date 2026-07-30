import { SettingName } from '@standardnotes/domain-core'
import { Uuid } from '@standardnotes/domain-core'

import { User } from '../../Domain/User/User'
import { TypeORMSetting } from './TypeORMSetting'
import { TypeORMUserRepository } from './TypeORMUserRepository'

describe('TypeORMUserRepository credential transition', () => {
  const oldHash = 'old-password-hash'
  let persistedUser: User
  let requestedUser: User
  let queryBuilder: {
    update: jest.Mock
    set: jest.Mock
    where: jest.Mock
    andWhere: jest.Mock
    execute: jest.Mock
  }
  let transactionalUsers: { createQueryBuilder: jest.Mock; findOneByOrFail: jest.Mock }
  let transactionalSettings: { delete: jest.Mock }
  let manager: { getRepository: jest.Mock; transaction: jest.Mock }
  let repository: TypeORMUserRepository

  beforeEach(() => {
    persistedUser = {
      uuid: '123e4567-e89b-42d3-a456-426614174000',
      encryptedPassword: 'new-password-hash',
      version: '004',
      email: 'new@example.com',
    } as User
    requestedUser = {
      ...persistedUser,
      pwNonce: 'new-nonce',
      kpCreated: '1700000000',
      kpOrigination: 'password-change',
      updatedAt: new Date(1),
    } as User

    queryBuilder = {
      update: jest.fn(),
      set: jest.fn(),
      where: jest.fn(),
      andWhere: jest.fn(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    }
    queryBuilder.update.mockReturnValue(queryBuilder)
    queryBuilder.set.mockReturnValue(queryBuilder)
    queryBuilder.where.mockReturnValue(queryBuilder)
    queryBuilder.andWhere.mockReturnValue(queryBuilder)
    transactionalUsers = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      findOneByOrFail: jest.fn().mockResolvedValue(persistedUser),
    }
    transactionalSettings = { delete: jest.fn().mockResolvedValue({ affected: 1 }) }
    manager = {
      getRepository: jest.fn().mockImplementation((entity: unknown) => {
        if (entity === User) {
          return transactionalUsers
        }
        if (entity === TypeORMSetting) {
          return transactionalSettings
        }
        throw Error('Unexpected entity')
      }),
      transaction: jest.fn().mockImplementation(async (callback: (value: unknown) => Promise<unknown>) => {
        return callback(manager)
      }),
    }
    repository = new TypeORMUserRepository({ manager } as never)
  })

  it('conditionally updates the exact prior state and deletes escrow in one transaction', async () => {
    const result = await repository.compareAndSwapCredentialsAndInvalidateAccountRecovery({
      user: requestedUser,
      expectedEncryptedPassword: oldHash,
      expectedProtocolVersion: '003',
    })

    expect(result).toBe(persistedUser)
    expect(manager.transaction).toHaveBeenCalledTimes(1)
    expect(queryBuilder.update).toHaveBeenCalledWith(User)
    expect(queryBuilder.set).toHaveBeenCalledWith(
      expect.objectContaining({
        encryptedPassword: 'new-password-hash',
        version: '004',
        email: 'new@example.com',
        pwNonce: 'new-nonce',
      }),
    )
    expect(queryBuilder.where).toHaveBeenCalledWith(
      'uuid = :uuid AND encrypted_password = :expectedEncryptedPassword',
      {
        uuid: requestedUser.uuid,
        expectedEncryptedPassword: oldHash,
      },
    )
    expect(queryBuilder.andWhere).toHaveBeenCalledWith('version = :expectedProtocolVersion', {
      expectedProtocolVersion: '003',
    })
    expect(transactionalSettings.delete).toHaveBeenCalledWith({
      userUuid: requestedUser.uuid,
      name: SettingName.NAMES.AccountRecoveryEscrow,
    })
    expect(transactionalUsers.findOneByOrFail).toHaveBeenCalledWith({ uuid: requestedUser.uuid })
    expect(queryBuilder.execute.mock.invocationCallOrder[0]).toBeLessThan(
      transactionalSettings.delete.mock.invocationCallOrder[0],
    )
  })

  it('returns null without deleting escrow when another credential transition already won', async () => {
    queryBuilder.execute.mockResolvedValue({ affected: 0 })

    const result = await repository.compareAndSwapCredentialsAndInvalidateAccountRecovery({
      user: requestedUser,
      expectedEncryptedPassword: oldHash,
      expectedProtocolVersion: '003',
    })

    expect(result).toBeNull()
    expect(transactionalSettings.delete).not.toHaveBeenCalled()
    expect(transactionalUsers.findOneByOrFail).not.toHaveBeenCalled()
  })

  it('matches a legacy null protocol version without weakening the password compare-and-swap', async () => {
    await repository.compareAndSwapCredentialsAndInvalidateAccountRecovery({
      user: requestedUser,
      expectedEncryptedPassword: oldHash,
      expectedProtocolVersion: null,
    })

    expect(queryBuilder.andWhere).toHaveBeenCalledWith('version IS NULL')
  })

  it('propagates escrow deletion failure so the conditional update is rolled back', async () => {
    transactionalSettings.delete.mockRejectedValue(new Error('database unavailable'))

    await expect(
      repository.compareAndSwapCredentialsAndInvalidateAccountRecovery({
        user: requestedUser,
        expectedEncryptedPassword: oldHash,
        expectedProtocolVersion: '003',
      }),
    ).rejects.toThrow('database unavailable')
    expect(transactionalUsers.findOneByOrFail).not.toHaveBeenCalled()
  })

  it('does not query-cache credential-sensitive UUID reads', async () => {
    const uuid = Uuid.create('123e4567-e89b-42d3-a456-426614174000').getValue()
    const query = {
      where: jest.fn(),
      cache: jest.fn(),
      getOne: jest.fn().mockResolvedValue(persistedUser),
    }
    query.where.mockReturnValue(query)
    const uncachedRepository = new TypeORMUserRepository({
      createQueryBuilder: jest.fn().mockReturnValue(query),
    } as never)

    await expect(uncachedRepository.findOneByUuid(uuid)).resolves.toBe(persistedUser)
    expect(query.cache).not.toHaveBeenCalled()
  })
})
