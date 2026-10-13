import 'reflect-metadata'

// `otplib` reaches an ESM-only base32 codec that jest cannot `require`. TOTP is
// not what this suite is about, and every other suite that imports it does this.
jest.mock('otplib', () => ({
  generateSync: jest.fn(() => '123456'),
  verifySync: jest.fn(() => ({ valid: false })),
}))

import { randomUUID } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ControllerContainer, RoleName, SettingName } from '@standardnotes/domain-core'
import { PermissionName } from '@standardnotes/features'
import { DirectCallDomainEventPublisher } from '@standardnotes/domain-events-infra'
import { Container } from 'inversify'
import { Repository } from 'typeorm'
import * as winston from 'winston'

import { ContainerConfigLoader } from './Container'
import TYPES from './Types'
import { CrypterInterface } from '../Domain/Encryption/CrypterInterface'
import { User } from '../Domain/User/User'
import { isWritableByItsOwner, settingsWrittenBy, writerOfSetting } from '../Domain/Setting/SettingWriter'
import { ADMIN_MANAGEABLE_SETTINGS } from '../Infra/InversifyExpressUtils/Base/BaseAdminController'

type DirectCallResult = { statusCode: number; json: Record<string, unknown> }
type DirectCallMethod = (request: never, response: never) => Promise<DirectCallResult>

const EVERY_SETTING = Object.values(SettingName.NAMES)

/** A value each setting would accept, so a refusal is about WHO writes and not WHAT. */
const valueFor = (name: string): string => {
  if (name.endsWith('_FREQUENCY')) {
    return 'daily'
  }
  if (name.startsWith('MUTE_')) {
    return 'muted'
  }
  if (name === SettingName.NAMES.LogSessionUserAgent) {
    return 'disabled'
  }
  if (name.endsWith('_LIMIT')) {
    return '5'
  }
  if (name === SettingName.NAMES.NextcloudBackupUrl) {
    return 'https://nextcloud.example.com'
  }
  if (name.endsWith('_ENABLED') || name.endsWith('_ALLOWED') || name.endsWith('_DISABLED')) {
    return 'true'
  }

  return 'value'
}

const errorMessage = (result: DirectCallResult): string =>
  String((result.json?.error as { message?: string } | undefined)?.message ?? '')

/**
 * Standard Red Notes: the account's OWN settings endpoint, on the all-in-one
 * container, asked to write every setting the server knows.
 *
 * *** WHY THIS BOOTS THE REAL CONTAINER. *** An ordinary signed-in user could
 * grant themselves three things an administrator is meant to grant
 * (WORKFLOWS_ENABLED, OCR_SERVER_ALLOWED, NEXTCLOUD_BACKUP_ALLOWED), and could
 * overwrite or delete a value an administrator had set. Measured over HTTP on
 * both topologies: 200 each time. The use cases were doing what they were told;
 * what was wrong was which settings they were told an owner may write, and the
 * only place that question is answered for real is the wired container, through
 * the handler the gateway calls. So this loads the auth container as the
 * all-in-one builds it, over a real sqlite file, and calls the handlers by
 * DirectCall name. There is no Express in between on that topology, so a guard
 * that lived in middleware would be absent here, and this would show it.
 *
 * Nothing below lists the gates. What each setting must answer is derived from
 * the declaration in `SettingWriter.ts`.
 */
describe('writing settings through the owner’s endpoint on the all-in-one (home-server) container', () => {
  let directory: string
  let container: Container
  let controllers: ControllerContainer
  const ownerUuid = randomUUID()
  const adminUuid = randomUUID()

  const call = async (
    method: string,
    as: 'owner' | 'administrator',
    request: Record<string, unknown>,
  ): Promise<DirectCallResult> => {
    const handler = controllers.get(method) as DirectCallMethod | undefined
    if (handler === undefined) {
      throw new Error(`Method ${method} not found`)
    }
    const user =
      as === 'owner'
        ? { uuid: ownerUuid, email: 'owner@example.com' }
        : { uuid: adminUuid, email: 'administrator@example.com' }
    const roles =
      as === 'owner'
        ? [{ uuid: randomUUID(), name: RoleName.NAMES.CoreUser }]
        : [{ uuid: randomUUID(), name: RoleName.NAMES.AdminUser }]

    return handler(
      { params: {}, body: {}, query: {}, headers: {}, ...request } as never,
      {
        locals: { user, roles, readOnlyAccess: false, authTokenVersion: 4 },
        // The handler sets a cache-invalidation header on success.
        setHeader: () => undefined,
      } as never,
    )
  }

  const ownerWrites = (name: string, value: string): Promise<DirectCallResult> =>
    call('auth.users.updateSetting', 'owner', { params: { userUuid: ownerUuid }, body: { name, value } })
  const ownerDeletes = (name: string): Promise<DirectCallResult> =>
    call('auth.users.deleteSetting', 'owner', { params: { userUuid: ownerUuid, settingName: name } })
  const administratorSets = (name: string, value: string): Promise<DirectCallResult> =>
    call('admin.setUserFeatureFlag', 'administrator', { params: { userUuid: ownerUuid }, body: { name, value } })
  const flagsSeenByTheAdministrator = async (): Promise<Record<string, string | null>> =>
    (await call('admin.getUserFeatureFlags', 'administrator', { params: { userUuid: ownerUuid } })).json
      .flags as Record<string, string | null>

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'srn-auth-setting-writers-'))
    controllers = new ControllerContainer()
    container = await new ContainerConfigLoader('server').load({
      controllerConatiner: controllers,
      directCallDomainEventPublisher: new DirectCallDomainEventPublisher(),
      logger: winston.createLogger({ silent: true }) as never,
      environmentOverrides: {
        MODE: 'home-server',
        DB_TYPE: 'sqlite',
        CACHE_TYPE: 'memory',
        DB_SQLITE_DATABASE_PATH: join(directory, 'home_server.sqlite'),
        // Throwaway values for the secrets the container refuses to start without.
        JWT_SECRET: 'j'.repeat(64),
        AUTH_JWT_SECRET: 'a'.repeat(64),
        AUTH_JWT_TTL: '60000',
        ENCRYPTION_SERVER_KEY: 'e'.repeat(64),
        PSEUDO_KEY_PARAMS_KEY: 'p'.repeat(64),
      },
    })

    const connection = container.get<Repository<User>>(TYPES.Auth_ORMUserRepository).manager.connection
    await connection.synchronize()
    for (const [uuid, email] of [
      [ownerUuid, 'owner@example.com'],
      [adminUuid, 'administrator@example.com'],
    ]) {
      await connection.getRepository(User).save({
        uuid,
        version: '004',
        email,
        pwNonce: 'nonce',
        encryptedPassword: 'hash',
        // What registration gives an account: without its own server key no
        // encrypted setting can be stored for it at all.
        encryptedServerKey: await container.get<CrypterInterface>(TYPES.Auth_Crypter).generateEncryptedUserServerKey(),
        serverEncryptionVersion: User.DEFAULT_ENCRYPTION_VERSION,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      })
    }
    // The one permission a setting is tied to: the role every account is given
    // carries it on a real server, so it does here too.
    const stamp = '2026-01-01 00:00:00'
    const roleUuid = randomUUID()
    const permissionUuid = randomUUID()
    await connection.query('INSERT INTO roles (uuid, name, version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', [
      roleUuid,
      RoleName.NAMES.CoreUser,
      stamp,
      stamp,
    ])
    await connection.query('INSERT INTO permissions (uuid, name, created_at, updated_at) VALUES (?, ?, ?, ?)', [
      permissionUuid,
      PermissionName.DailyEmailBackup,
      stamp,
      stamp,
    ])
    await connection.query('INSERT INTO role_permissions (permission_uuid, role_uuid) VALUES (?, ?)', [
      permissionUuid,
      roleUuid,
    ])
    await connection.query('INSERT INTO user_roles (role_uuid, user_uuid) VALUES (?, ?)', [roleUuid, ownerUuid])
  }, 120_000)

  afterAll(async () => {
    await container?.get<Repository<User>>(TYPES.Auth_ORMUserRepository).manager.connection.destroy()
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // Windows keeps the sqlite file locked if the container never finished loading.
    }
  })

  it('lets the owner write exactly the settings declared as the owner’s, and no other', async () => {
    const writtenThoughNotTheOwners: string[] = []
    const refusedThoughTheOwners: string[] = []

    for (const name of EVERY_SETTING) {
      const result = await ownerWrites(name, valueFor(name))
      const written = result.statusCode === 200

      if (written && !isWritableByItsOwner(name)) {
        writtenThoughNotTheOwners.push(name)
      }
      // A subscription setting is refused on this endpoint whoever it belongs to
      // (it has an endpoint of its own), and MFA_SECRET needs a current TOTP
      // token; neither refusal is about who the writer is.
      const refusedForAnotherReason =
        SettingName.create(name).getValue().isASubscriptionSetting() || name === SettingName.NAMES.MfaSecret
      if (!written && isWritableByItsOwner(name) && !refusedForAnotherReason) {
        refusedThoughTheOwners.push(`${name}: ${result.statusCode} ${errorMessage(result)}`)
      }
    }

    expect(writtenThoughNotTheOwners).toEqual([])
    expect(refusedThoughTheOwners).toEqual([])
  }, 120_000)

  it('names the setting and the reason when it refuses the owner a gate', async () => {
    const result = await ownerWrites(SettingName.NAMES.WorkflowsEnabled, 'true')

    expect(result.statusCode).toBe(400)
    expect(errorMessage(result)).toBe(
      `User ${ownerUuid} does not have permission to update setting ${SettingName.NAMES.WorkflowsEnabled}.`,
    )
  })

  /**
   * The other half of the defect: the administrator's decision has to hold.
   * For every gate the admin panel can set, the administrator sets it, the
   * account tries to overwrite it and then to delete it, and what the
   * administrator set is still what the administrator reads back. Then the
   * administrator changes it again, because the fix must not have closed the
   * administrator's own path.
   */
  it('lets the administrator set every gate and stops the account undoing it', async () => {
    const gates = settingsWrittenBy('administrator').filter((name) => ADMIN_MANAGEABLE_SETTINGS.includes(name))
    expect(gates.length).toBeGreaterThanOrEqual(10)

    const undone: string[] = []
    for (const name of gates) {
      const granted = valueFor(name)
      const revoked = granted === 'true' ? 'false' : '7'

      const set = await administratorSets(name, granted)
      if (set.statusCode !== 200) {
        undone.push(`${name}: the administrator could not set it (${set.statusCode} ${errorMessage(set)})`)
        continue
      }
      const overwrite = await ownerWrites(name, revoked)
      const removal = await ownerDeletes(name)
      const afterTheAccountTried = (await flagsSeenByTheAdministrator())[name]
      if (overwrite.statusCode === 200 || removal.statusCode === 200 || afterTheAccountTried !== granted) {
        undone.push(
          `${name}: overwrite ${overwrite.statusCode}, delete ${removal.statusCode}, reads ${afterTheAccountTried}`,
        )
      }
      const changed = await administratorSets(name, revoked)
      const afterTheAdministratorChangedIt = (await flagsSeenByTheAdministrator())[name]
      if (changed.statusCode !== 200 || afterTheAdministratorChangedIt !== revoked) {
        undone.push(
          `${name}: the administrator could not change it (${changed.statusCode}), reads ${afterTheAdministratorChangedIt}`,
        )
      }
    }

    expect(undone).toEqual([])
  }, 120_000)

  it('still lets the owner change and remove a choice of their own that an administrator also set', async () => {
    const shared = settingsWrittenBy('owner-or-administrator')
    expect(shared.length).toBeGreaterThanOrEqual(3)

    for (const name of shared) {
      expect([name, (await administratorSets(name, valueFor(name))).statusCode]).toEqual([name, 200])
      expect([name, (await ownerWrites(name, valueFor(name))).statusCode]).toEqual([name, 200])
      expect([name, (await ownerDeletes(name)).statusCode]).toEqual([name, 200])
    }
  }, 120_000)

  it('refuses the owner the deletion of anything that is not the owner’s to write', async () => {
    // Put a row there by the administrator's path or, for the server's own
    // bookkeeping, straight into the table: the point is what the owner may
    // then do to it.
    const connection = container.get<Repository<User>>(TYPES.Auth_ORMUserRepository).manager.connection
    const deleted: string[] = []
    for (const name of EVERY_SETTING.filter((candidate) => !isWritableByItsOwner(candidate))) {
      if (SettingName.create(name).getValue().isASubscriptionSetting()) {
        continue
      }
      await connection.query('DELETE FROM settings WHERE user_uuid = ? AND name = ?', [ownerUuid, name])
      await connection.query(
        'INSERT INTO settings (uuid, name, value, server_encryption_version, created_at, updated_at, user_uuid, sensitive) VALUES (?, ?, ?, 0, 1, 1, ?, 0)',
        [randomUUID(), name, 'true', ownerUuid],
      )

      const removal = await ownerDeletes(name)
      const stillThere = (await connection.query('SELECT 1 FROM settings WHERE user_uuid = ? AND name = ?', [
        ownerUuid,
        name,
      ])) as unknown[]
      if (removal.statusCode === 200 || stillThere.length !== 1) {
        deleted.push(`${name} (${writerOfSetting(name)}): delete ${removal.statusCode}, rows left ${stillThere.length}`)
      }
    }

    expect(deleted).toEqual([])
  }, 120_000)
})
