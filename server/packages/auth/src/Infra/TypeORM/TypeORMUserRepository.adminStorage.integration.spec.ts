import 'reflect-metadata'

import { randomUUID } from 'crypto'
import { existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SettingName } from '@standardnotes/domain-core'
import { DataSource } from 'typeorm'

import { AppDataSource } from '../../Bootstrap/DataSource'
import { Env } from '../../Bootstrap/Env'
import { User } from '../../Domain/User/User'
import { UserSubscription } from '../../Domain/Subscription/UserSubscription'
import { UserSubscriptionType } from '../../Domain/Subscription/UserSubscriptionType'
import { TypeORMSubscriptionSetting } from './TypeORMSubscriptionSetting'
import { TypeORMUserRepository } from './TypeORMUserRepository'

/**
 * Standard Red Notes: what the admin users LIST reports for per-user server
 * storage, proved against a real database rather than a mocked query builder.
 *
 * Two properties are pinned here, and they are the two the admin panel's storage
 * column was getting wrong:
 *
 *   1. An ABSENT subscription setting is reported as `null`, never as `0`. The
 *      FILE_UPLOAD_BYTES_USED row is written only when the auth worker handles a
 *      FILE_UPLOADED event, so an account whose uploads have never succeeded has
 *      no row at all. A `0` here would be a measurement nobody took, and would
 *      make a broken files subsystem indistinguishable from an empty account.
 *   2. The figures come from the user's REGULAR subscription only. Enforcement
 *      (CreateValetToken) and the per-user detail endpoint
 *      (GetRegularSubscriptionForUser) both read a regular subscription; the list
 *      query used to join every `user_subscriptions` row, so a user who also
 *      belonged to a more recently created SHARED subscription had that one's
 *      figures reported, disagreeing with both.
 */
describe('TypeORMUserRepository admin storage figures on better-sqlite3', () => {
  let databasePath: string
  let dataSource: DataSource

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
    const created = new AppDataSource({ env, runMigrations: false }).dataSource
    await created.initialize()
    await created.synchronize(true)
    return created
  }

  const saveUser = async (uuid: string, email: string): Promise<void> => {
    await dataSource.getRepository(User).save({
      uuid,
      version: '004',
      email,
      pwNonce: 'nonce',
      encryptedPassword: 'hash',
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })
  }

  const saveSubscription = async (
    userUuid: string,
    subscriptionType: UserSubscriptionType,
    createdAt: number,
  ): Promise<string> => {
    const uuid = randomUUID()
    await dataSource.getRepository(UserSubscription).save({
      uuid,
      planName: 'PRO_PLAN',
      endsAt: 9_000_000_000_000_000,
      createdAt,
      updatedAt: createdAt,
      renewedAt: null,
      cancelled: false,
      subscriptionId: 1,
      subscriptionType,
      userUuid,
    })
    return uuid
  }

  const saveSubscriptionSetting = async (
    userSubscriptionUuid: string,
    name: string,
    value: string | null,
  ): Promise<void> => {
    await dataSource.getRepository(TypeORMSubscriptionSetting).save({
      name,
      value,
      serverEncryptionVersion: 0,
      createdAt: 1,
      updatedAt: 1,
      userSubscriptionUuid,
      sensitive: false,
    })
  }

  const rowFor = async (email: string) => {
    const result = await new TypeORMUserRepository(dataSource.getRepository(User)).findUsersForAdmin({
      limit: 50,
      offset: 0,
      sort: 'createdAt',
    })
    const row = result.rows.find((candidate) => candidate.email === email)
    if (row === undefined) {
      throw new Error(`No admin list row for ${email}`)
    }
    return row
  }

  beforeEach(async () => {
    databasePath = join(tmpdir(), `srn-admin-storage-${randomUUID()}.sqlite`)
    dataSource = await createDataSource()
  })

  afterEach(async () => {
    if (dataSource.isInitialized) {
      await dataSource.destroy()
    }
    if (existsSync(databasePath)) {
      unlinkSync(databasePath)
    }
  })

  it('reports the stored figures when the regular subscription carries both', async () => {
    const userUuid = randomUUID()
    await saveUser(userUuid, 'measured@example.com')
    const subscriptionUuid = await saveSubscription(userUuid, UserSubscriptionType.Regular, 100)
    await saveSubscriptionSetting(subscriptionUuid, SettingName.NAMES.FileUploadBytesUsed, '2048')
    await saveSubscriptionSetting(subscriptionUuid, SettingName.NAMES.FileUploadBytesLimit, '-1')

    const row = await rowFor('measured@example.com')

    expect(row.storageUsedBytes).toBe(2048)
    expect(row.storageLimitBytes).toBe(-1)
  })

  it('reports a MEASURED zero as zero', async () => {
    const userUuid = randomUUID()
    await saveUser(userUuid, 'zero@example.com')
    const subscriptionUuid = await saveSubscription(userUuid, UserSubscriptionType.Regular, 100)
    await saveSubscriptionSetting(subscriptionUuid, SettingName.NAMES.FileUploadBytesUsed, '0')
    await saveSubscriptionSetting(subscriptionUuid, SettingName.NAMES.FileUploadBytesLimit, '4096')

    const row = await rowFor('zero@example.com')

    // A real zero IS a measurement and must survive as the number 0.
    expect(row.storageUsedBytes).toBe(0)
    expect(row.storageLimitBytes).toBe(4096)
  })

  it('reports an ABSENT usage row as null, never as zero', async () => {
    const userUuid = randomUUID()
    await saveUser(userUuid, 'absent@example.com')
    const subscriptionUuid = await saveSubscription(userUuid, UserSubscriptionType.Regular, 100)
    // Only the limit was ever written. This is the shape of an account whose
    // uploads have never succeeded.
    await saveSubscriptionSetting(subscriptionUuid, SettingName.NAMES.FileUploadBytesLimit, '4096')

    const row = await rowFor('absent@example.com')

    // Precondition: the subscription really was found (its limit came back).
    expect(row.storageLimitBytes).toBe(4096)
    expect(row.storageUsedBytes).toBeNull()
    expect(row.storageUsedBytes).not.toBe(0)
  })

  it('reports a value that is not a number as null, never as zero', async () => {
    const userUuid = randomUUID()
    await saveUser(userUuid, 'garbage@example.com')
    const subscriptionUuid = await saveSubscription(userUuid, UserSubscriptionType.Regular, 100)
    await saveSubscriptionSetting(subscriptionUuid, SettingName.NAMES.FileUploadBytesUsed, 'NaN')
    await saveSubscriptionSetting(subscriptionUuid, SettingName.NAMES.FileUploadBytesLimit, '4096')

    const row = await rowFor('garbage@example.com')

    expect(row.storageLimitBytes).toBe(4096)
    expect(row.storageUsedBytes).toBeNull()
  })

  it('ignores a SHARED subscription’s figures, even a newer one', async () => {
    const userUuid = randomUUID()
    await saveUser(userUuid, 'shared@example.com')
    const regularUuid = await saveSubscription(userUuid, UserSubscriptionType.Regular, 100)
    await saveSubscriptionSetting(regularUuid, SettingName.NAMES.FileUploadBytesLimit, '4096')
    // A more recently created SHARED subscription carrying DIFFERENT figures.
    // Neither enforcement nor the per-user detail endpoint ever reads these.
    const sharedUuid = await saveSubscription(userUuid, UserSubscriptionType.Shared, 200)
    await saveSubscriptionSetting(sharedUuid, SettingName.NAMES.FileUploadBytesUsed, '999999')
    await saveSubscriptionSetting(sharedUuid, SettingName.NAMES.FileUploadBytesLimit, '888888')

    const row = await rowFor('shared@example.com')

    // Precondition: both subscriptions exist for this user.
    expect(await dataSource.getRepository(UserSubscription).countBy({ userUuid })).toBe(2)
    expect(row.storageLimitBytes).toBe(4096)
    expect(row.storageUsedBytes).toBeNull()
  })

  it('reports null for a user with no subscription at all', async () => {
    const userUuid = randomUUID()
    await saveUser(userUuid, 'nosub@example.com')

    const row = await rowFor('nosub@example.com')

    expect(row.subscription).toBeNull()
    expect(row.storageUsedBytes).toBeNull()
    expect(row.storageLimitBytes).toBeNull()
  })
})
