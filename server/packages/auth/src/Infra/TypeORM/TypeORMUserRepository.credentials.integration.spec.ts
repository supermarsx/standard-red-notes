import 'reflect-metadata'

import { randomUUID } from 'crypto'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SettingName, Uuid } from '@standardnotes/domain-core'
import { DataSource } from 'typeorm'

import { AppDataSource } from '../../Bootstrap/DataSource'
import { Env } from '../../Bootstrap/Env'
import { User } from '../../Domain/User/User'
import { TypeORMSetting } from './TypeORMSetting'
import { TypeORMUserRepository } from './TypeORMUserRepository'

describe('TypeORMUserRepository credential transition on better-sqlite3', () => {
  let databasePath: string
  let dataSources: DataSource[]

  const createDataSource = async (): Promise<DataSource> => {
    const env = {
      load: jest.fn(),
      get: jest.fn((name: string) => {
        if (name === 'DB_SQLITE_DATABASE_PATH') {
          return databasePath
        }
        return undefined
      }),
    } as unknown as Env
    const dataSource = new AppDataSource({ env, runMigrations: false }).dataSource
    await dataSource.initialize()
    dataSources.push(dataSource)
    return dataSource
  }

  beforeEach(() => {
    databasePath = join(tmpdir(), `srn-credential-cas-${randomUUID()}.sqlite`)
    dataSources = []
  })

  afterEach(async () => {
    await Promise.all(
      dataSources.filter((dataSource) => dataSource.isInitialized).map((dataSource) => dataSource.destroy()),
    )
    if (existsSync(databasePath)) {
      unlinkSync(databasePath)
    }
  })

  it('allows only one of two cross-connection attempts to replace the exact prior credentials', async () => {
    const firstDataSource = await createDataSource()
    await firstDataSource.synchronize(true)
    const secondDataSource = await createDataSource()
    const uuid = randomUUID()
    const oldHash = 'old-password-hash'

    await firstDataSource.getRepository(User).save({
      uuid,
      version: '003',
      email: 'person@example.com',
      workspaceIdentifier: 'team-a',
      pwNonce: 'old-nonce',
      encryptedPassword: oldHash,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })
    await firstDataSource.getRepository(TypeORMSetting).save({
      name: SettingName.NAMES.AccountRecoveryEscrow,
      value: 'opaque-client-ciphertext',
      serverEncryptionVersion: 1,
      createdAt: 1,
      updatedAt: 1,
      userUuid: uuid,
      sensitive: false,
    })

    const firstCandidate = {
      ...(await firstDataSource.getRepository(User).findOneByOrFail({ uuid })),
      encryptedPassword: 'first-new-hash',
      version: '004',
      pwNonce: 'first-nonce',
      updatedAt: new Date(1),
    } as User
    const secondCandidate = {
      ...(await secondDataSource.getRepository(User).findOneByOrFail({ uuid })),
      encryptedPassword: 'second-new-hash',
      version: '004',
      pwNonce: 'second-nonce',
      updatedAt: new Date(2),
    } as User

    const firstDomainRepository = new TypeORMUserRepository(firstDataSource.getRepository(User))
    const attempts = await Promise.allSettled([
      firstDomainRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery({
        user: firstCandidate,
        expectedEncryptedPassword: oldHash,
        expectedProtocolVersion: '003',
      }),
      new TypeORMUserRepository(
        secondDataSource.getRepository(User),
      ).compareAndSwapCredentialsAndInvalidateAccountRecovery({
        user: secondCandidate,
        expectedEncryptedPassword: oldHash,
        expectedProtocolVersion: '003',
      }),
    ])

    const winners = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<User | null> =>
        attempt.status === 'fulfilled' && attempt.value !== null,
    )
    expect(winners).toHaveLength(1)
    const persisted = await firstDomainRepository.findOneByUuid(Uuid.create(uuid).getValue())
    expect(persisted).not.toBeNull()
    expect(['first-new-hash', 'second-new-hash']).toContain(persisted!.encryptedPassword)
    expect(
      await firstDataSource.getRepository(TypeORMSetting).findOneBy({
        userUuid: uuid,
        name: SettingName.NAMES.AccountRecoveryEscrow,
      }),
    ).toBeNull()
  })
})
