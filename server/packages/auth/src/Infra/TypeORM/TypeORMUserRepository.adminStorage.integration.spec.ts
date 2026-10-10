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
 *   3. The figures are found at all for an account with NO subscription row. On
 *      the default `included` entitlement mode that is every account, and the
 *      list's INNER JOIN against `user_subscriptions` eliminated all of them —
 *      the whole column read 'Not reported' however many files were stored. The
 *      scope precedence is copied from the detail endpoint rather than invented,
 *      so the two panels cannot disagree about one user.
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

  it('reports null for a user with no subscription row AND nothing written anywhere', async () => {
    const userUuid = randomUUID()
    await saveUser(userUuid, 'nosub@example.com')

    const row = await rowFor('nosub@example.com')

    expect(row.subscription).toBeNull()
    expect(row.storageUsedBytes).toBeNull()
    expect(row.storageLimitBytes).toBeNull()
  })

  // -------------------------------------------------------------------------
  // The row-less quota scope — the shape of EVERY account on the default
  // `STANDARD_RED_ENTITLEMENT_MODE=included`, where registration creates no
  // `user_subscriptions` row at all and `ResolveFileQuotaScope` puts the
  // bookkeeping under the user's OWN uuid. The list read used to INNER JOIN
  // `user_subscriptions`, which eliminated every row for such an account, so the
  // whole column read 'Not reported' however many files were held.
  // -------------------------------------------------------------------------

  it('reports figures written under the USER’S OWN uuid when no subscription row exists', async () => {
    const userUuid = randomUUID()
    await saveUser(userUuid, 'included@example.com')
    // No saveSubscription: this is the `included` entitlement mode.
    await saveSubscriptionSetting(userUuid, SettingName.NAMES.FileUploadBytesUsed, '5242880')
    await saveSubscriptionSetting(userUuid, SettingName.NAMES.FileUploadBytesLimit, '-1')

    const row = await rowFor('included@example.com')

    // Precondition: the account really has no subscription row, so the figures
    // can only have come from the row-less scope.
    expect(await dataSource.getRepository(UserSubscription).countBy({ userUuid })).toBe(0)
    expect(row.subscription).toBeNull()
    expect(row.storageUsedBytes).toBe(5242880)
    expect(row.storageLimitBytes).toBe(-1)
  })

  it('reports a MEASURED zero from the row-less scope as zero', async () => {
    const userUuid = randomUUID()
    await saveUser(userUuid, 'includedzero@example.com')
    await saveSubscriptionSetting(userUuid, SettingName.NAMES.FileUploadBytesUsed, '0')

    const row = await rowFor('includedzero@example.com')

    expect(row.storageUsedBytes).toBe(0)
    expect(row.storageUsedBytes).not.toBeNull()
  })

  it('reports an absent row-less usage row as null, never as zero', async () => {
    const userUuid = randomUUID()
    await saveUser(userUuid, 'includedabsent@example.com')
    // Only the limit was ever written under the user's own uuid.
    await saveSubscriptionSetting(userUuid, SettingName.NAMES.FileUploadBytesLimit, '4096')

    const row = await rowFor('includedabsent@example.com')

    // Precondition: the row-less scope really was read (its limit came back).
    expect(row.storageLimitBytes).toBe(4096)
    expect(row.storageUsedBytes).toBeNull()
    expect(row.storageUsedBytes).not.toBe(0)
  })

  it('prefers the SUBSCRIPTION scope over the row-less one, matching the detail endpoint', async () => {
    const userUuid = randomUUID()
    await saveUser(userUuid, 'bothscopes@example.com')
    const subscriptionUuid = await saveSubscription(userUuid, UserSubscriptionType.Regular, 100)
    await saveSubscriptionSetting(subscriptionUuid, SettingName.NAMES.FileUploadBytesUsed, '1111')
    // A stale figure left under the user's own uuid by an earlier build. The
    // detail endpoint (BaseAdminController.getUserUsage) reads the subscription
    // row's uuid whenever one exists and never looks here, so the list must not
    // either — otherwise the two panels show different numbers for one user.
    await saveSubscriptionSetting(userUuid, SettingName.NAMES.FileUploadBytesUsed, '9999')

    const row = await rowFor('bothscopes@example.com')

    expect(row.storageUsedBytes).toBe(1111)
  })

  it('does not report one user’s row-less figures against another user', async () => {
    const firstUuid = randomUUID()
    const secondUuid = randomUUID()
    await saveUser(firstUuid, 'first@example.com')
    await saveUser(secondUuid, 'second@example.com')
    await saveSubscriptionSetting(firstUuid, SettingName.NAMES.FileUploadBytesUsed, '777')

    const first = await rowFor('first@example.com')
    const second = await rowFor('second@example.com')

    expect(first.storageUsedBytes).toBe(777)
    expect(second.storageUsedBytes).toBeNull()
  })

  it('reads every user on the page from its own scope in one pass', async () => {
    // A mixed page: one subscribed account, one row-less account with figures,
    // one row-less account with none. All three must come back correct from the
    // same single list call — the batching is what keeps this off an N+1.
    const subscribedUuid = randomUUID()
    const includedUuid = randomUUID()
    const emptyUuid = randomUUID()
    await saveUser(subscribedUuid, 'mix-sub@example.com')
    await saveUser(includedUuid, 'mix-included@example.com')
    await saveUser(emptyUuid, 'mix-empty@example.com')
    const subscriptionUuid = await saveSubscription(subscribedUuid, UserSubscriptionType.Regular, 100)
    await saveSubscriptionSetting(subscriptionUuid, SettingName.NAMES.FileUploadBytesUsed, '100')
    await saveSubscriptionSetting(includedUuid, SettingName.NAMES.FileUploadBytesUsed, '200')

    const result = await new TypeORMUserRepository(dataSource.getRepository(User)).findUsersForAdmin({
      limit: 50,
      offset: 0,
      sort: 'createdAt',
    })
    const byEmail = new Map(result.rows.map((row) => [row.email, row]))

    expect(byEmail.get('mix-sub@example.com')?.storageUsedBytes).toBe(100)
    expect(byEmail.get('mix-included@example.com')?.storageUsedBytes).toBe(200)
    expect(byEmail.get('mix-empty@example.com')?.storageUsedBytes).toBeNull()
  })

  it('reads the NEWEST of two regular subscriptions, not the oldest', async () => {
    // Scope selection is "newest regular row wins", and with two of them the
    // ordering is the only thing that decides the answer. Without this case an
    // inverted sort, or a last-write-wins fold, passes every other test here.
    const userUuid = randomUUID()
    await saveUser(userUuid, 'twosubs@example.com')
    const olderUuid = await saveSubscription(userUuid, UserSubscriptionType.Regular, 100)
    const newerUuid = await saveSubscription(userUuid, UserSubscriptionType.Regular, 200)
    await saveSubscriptionSetting(olderUuid, SettingName.NAMES.FileUploadBytesUsed, '1000')
    await saveSubscriptionSetting(newerUuid, SettingName.NAMES.FileUploadBytesUsed, '2000')

    const row = await rowFor('twosubs@example.com')

    // Precondition: both regular subscriptions really exist.
    expect(await dataSource.getRepository(UserSubscription).countBy({ userUuid })).toBe(2)
    expect(row.storageUsedBytes).toBe(2000)
  })

  it('reads the FRESHEST duplicate row, even when its value is unusable', async () => {
    // The (name, user_subscription_uuid) index is not unique, so a duplicate pair
    // is possible. `findLastByNameAndUserSubscriptionUuid` — which the detail
    // endpoint goes through — orders by updated_at DESC and would answer null for
    // the garbage row. Letting the staler row win here would print a figure the
    // panel beside it does not show.
    const userUuid = randomUUID()
    await saveUser(userUuid, 'duplicate@example.com')
    await dataSource.getRepository(TypeORMSubscriptionSetting).save({
      name: SettingName.NAMES.FileUploadBytesUsed,
      value: '4096',
      serverEncryptionVersion: 0,
      createdAt: 1,
      updatedAt: 1,
      userSubscriptionUuid: userUuid,
      sensitive: false,
    })
    await dataSource.getRepository(TypeORMSubscriptionSetting).save({
      name: SettingName.NAMES.FileUploadBytesUsed,
      value: 'not-a-number',
      serverEncryptionVersion: 0,
      createdAt: 2,
      updatedAt: 2,
      userSubscriptionUuid: userUuid,
      sensitive: false,
    })

    const row = await rowFor('duplicate@example.com')

    expect(row.storageUsedBytes).toBeNull()
  })
})
