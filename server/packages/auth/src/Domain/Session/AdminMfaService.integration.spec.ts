import { DataSource } from 'typeorm'
import { Result, SettingName } from '@standardnotes/domain-core'
import { Session } from './Session'
import { runAuthTypeORMTransaction } from '../../Infra/TypeORM/AuthTypeORMTransactionCoordinator'
import { AdminMfaService } from './AdminMfaService'

const user = '00000000-0000-4000-8000-000000000001'
describe('admin all-factor reset with actual SQL storage', () => {
  let db: DataSource, service: AdminMfaService, revoke: jest.Mock, audit: jest.Mock, openSessions: number
  beforeEach(async () => {
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session],
      synchronize: true,
    }).initialize()
    await db.query('CREATE TABLE settings (user_uuid TEXT, name TEXT, value TEXT)')
    for (const table of ['authenticators', 'authenticator_challenges', 'trusted_devices', 'app_passwords']) {
      await db.query(`CREATE TABLE ${table} (user_uuid TEXT)`)
      await db.query(`INSERT INTO ${table} VALUES (?)`, [user])
    }
    await db.query('CREATE TABLE magic_link_tokens (user_identifier TEXT)')
    await db.query('INSERT INTO magic_link_tokens VALUES (?)', [' TARGET@EXAMPLE.TEST '])
    for (const name of [
      SettingName.NAMES.MfaSecret,
      SettingName.NAMES.RecoveryCodes,
      SettingName.NAMES.MagicLinkEnabled,
    ]) {
      await db.query('INSERT INTO settings VALUES (?, ?, ?)', [
        user,
        name,
        name === SettingName.NAMES.MagicLinkEnabled ? 'true' : 'secret-never-exposed',
      ])
    }
    await db.query('INSERT INTO settings VALUES (?, ?, ?)', [user, 'unrelated', 'keep'])
    openSessions = 2
    revoke = jest.fn(async () => {
      openSessions = 0
      return Result.ok()
    })
    audit = jest.fn(async () => undefined)
    const byTable = (table: string) => ({
      findByUserUuid: async () => db.query(`SELECT * FROM ${table} WHERE user_uuid = ?`, [user]),
    })
    service = new AdminMfaService({
      sessions: db.getRepository(Session),
      generation: {
        reset: (_user: string, work: Parameters<typeof runAuthTypeORMTransaction>[1]) =>
          runAuthTypeORMTransaction(db, work),
      } as never,
      users: { findOneByUuid: async () => ({ email: 'target@example.test' }) } as never,
      settings: {
        findLastByNameAndUserUuid: async (name: string) => {
          const rows = await db.query('SELECT value FROM settings WHERE user_uuid = ? AND name = ?', [user, name])
          return rows.length ? { props: { value: rows[0].value } } : null
        },
      } as never,
      authenticators: byTable('authenticators') as never,
      trustedDevices: byTable('trusted_devices') as never,
      appPasswords: byTable('app_passwords') as never,
      getSessions: {
        execute: async () => ({
          sessions: Array.from({ length: openSessions }, () => ({ refreshExpiration: new Date(Date.now() + 60_000) })),
        }),
      } as never,
      getSetting: {
        execute: async () => {
          const rows = await db.query('SELECT value FROM settings WHERE name = ?', [SettingName.NAMES.MagicLinkEnabled])
          return rows.length ? Result.ok({ decryptedValue: rows[0].value }) : Result.fail('missing')
        },
      } as never,
      revokeSessions: { execute: revoke } as never,
      audit: { write: audit } as never,
    })
  })
  afterEach(async () => {
    await db.destroy()
  })
  it('reports only safe metadata and clears all factors/codes/credentials while preserving unrelated settings', async () => {
    const before = await service.status(user)
    expect(before).toEqual({
      totpConfigured: true,
      recoveryCodesAvailable: true,
      magicLinkEnabled: true,
      securityKeyCount: 1,
      trustedDeviceCount: 1,
      appPasswordCount: 1,
      openSessionCount: 2,
    })
    expect(JSON.stringify(before)).not.toContain('secret-never-exposed')
    expect(await service.reset(user, 'admin')).toEqual({
      totpConfigured: false,
      recoveryCodesAvailable: false,
      magicLinkEnabled: false,
      securityKeyCount: 0,
      trustedDeviceCount: 0,
      appPasswordCount: 0,
      openSessionCount: 0,
    })
    expect(revoke).toHaveBeenCalledTimes(2)
    expect(revoke.mock.calls[0][0]).toMatchObject({ userUuid: user, markAsRevoked: true })
    expect(revoke.mock.calls[0][0].currentSessionUuid).not.toBe(user)
    expect(await db.query('SELECT name, value FROM settings')).toEqual([{ name: 'unrelated', value: 'keep' }])
    expect(await db.query('SELECT * FROM magic_link_tokens')).toEqual([])
    expect(await db.query('SELECT * FROM authenticator_challenges')).toEqual([])
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ targetUuid: user, metadata: { scope: 'all_factors', sessionsRevoked: true } }),
    )
    expect(JSON.stringify(audit.mock.calls)).not.toContain('secret-never-exposed')
  })
  it('rolls factor removals back on database failure and never reports successful reset', async () => {
    await db.query(
      "CREATE TRIGGER fail_reset BEFORE DELETE ON app_passwords BEGIN SELECT RAISE(ABORT, 'injected-reset-failure'); END",
    )
    await expect(service.reset(user, 'admin')).rejects.toThrow('injected-reset-failure')
    expect((await service.status(user))?.totpConfigured).toBe(true)
    expect((await db.query('SELECT COUNT(*) AS count FROM authenticators'))[0].count).toBe(1)
    expect(audit).not.toHaveBeenCalled()
  })
  it('does not mutate unknown targets or continue after session revocation fails', async () => {
    expect(await service.reset('not-a-uuid', 'admin')).toBeUndefined()
    expect(await service.status('not-a-uuid')).toBeUndefined()
    const deps = (service as unknown as { deps: { users: { findOneByUuid: () => Promise<unknown> } } }).deps
    const lookup = deps.users.findOneByUuid
    deps.users.findOneByUuid = async () => undefined
    expect(await service.reset(user, 'admin')).toBeUndefined()
    expect(await service.status(user)).toBeUndefined()
    deps.users.findOneByUuid = lookup
    revoke.mockResolvedValueOnce(Result.fail('unavailable'))
    await expect(service.reset(user, 'admin')).rejects.toThrow('Session revocation failed')
    expect((await service.status(user))?.totpConfigured).toBe(true)
    expect(audit).not.toHaveBeenCalled()
  })
})
