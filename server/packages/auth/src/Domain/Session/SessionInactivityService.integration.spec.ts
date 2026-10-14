import 'reflect-metadata'
import { DataSource } from 'typeorm'
import { createHash } from 'crypto'
import { AUTH_TYPEORM_ENTITIES } from '../../Bootstrap/DataSource'
import { User } from '../User/User'
import { Session } from './Session'
import { RevokedSession } from './RevokedSession'
import { SessionInactivityService, SESSION_INACTIVITY_MS } from './SessionInactivityService'
import { sessionDeviceActivity1792022400000 } from '../../../migrations/sqlite/1792022400000-session-device-activity'
import { sessionInactivity1792108800000 } from '../../../migrations/sqlite/1792108800000-session-inactivity'
import { GetSessionFromToken } from '../UseCase/GetSessionFromToken/GetSessionFromToken'
import { TypeORMCacheEntry } from '../../Infra/TypeORM/TypeORMCacheEntry'
import { TypeORMCacheEntryRepository } from '../../Infra/TypeORM/TypeORMCacheEntryRepository'
import { TypeORMEphemeralSessionRepository } from '../../Infra/TypeORM/TypeORMEphemeralSessionRepository'
import { CacheEntryPersistenceMapper } from '../../Mapping/CacheEntryPersistenceMapper'
import { SessionActivityService } from './SessionActivityService'
import { GetActiveSessionsForUser } from '../UseCase/GetActiveSessionsForUser'
import { AccountDeletionRequestedEventHandler } from '../Handler/AccountDeletionRequestedEventHandler'
const userUuid = '00000000-0000-4000-8000-000000000001'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
describe('60day inactivity policy with real SQL state', () => {
  it.each([false, true])(
    'purges both observation tables on account deletion, including redelivery=%s, while preserving another account and the installation singleton',
    async (alreadyGone) => {
      const other = id(999)
      for (let index = 0; index < 401; index++) {
        await db.query('INSERT INTO session_device_activity VALUES (?,?,?,?)', [
          userUuid,
          id(index + 2),
          'profile',
          now,
        ])
        await db.query('INSERT INTO session_activity VALUES (?,?,?,NULL)', [userUuid, id(index + 2), now])
      }
      await db.query('INSERT INTO session_device_activity VALUES (?,?,?,?)', [other, id(900), 'other-profile', now])
      await db.query('INSERT INTO session_activity VALUES (?,?,?,NULL)', [other, id(900), now])
      const existing = await db.getRepository(User).findOneByOrFail({ uuid: userUuid })
      const remove = jest.fn(async () => {
        await db.getRepository(User).delete(userUuid)
      })
      const handler = new AccountDeletionRequestedEventHandler(
        { findOneByUuid: async () => (alreadyGone ? null : existing), remove } as never,
        { findAllByUserUuid: async () => [] } as never,
        { findAllByUserUuid: async () => [] } as never,
        { findAllByUserUuid: async () => [] } as never,
        { warn: jest.fn(), info: jest.fn() } as never,
        undefined,
        policy,
      )
      await handler.handle({ payload: { userUuid } } as never)
      expect(await db.query('SELECT user_uuid FROM session_device_activity')).toEqual([{ user_uuid: other }])
      expect(await db.query('SELECT user_uuid FROM session_activity')).toEqual([{ user_uuid: other }])
      expect(await db.query('SELECT installed_at FROM session_inactivity_policy')).toEqual([
        { installed_at: installed },
      ])
      expect(remove).toHaveBeenCalledTimes(alreadyGone ? 0 : 1)
    },
  )
  let db: DataSource,
    policy: SessionInactivityService,
    ephemeral: TypeORMEphemeralSessionRepository,
    now: number,
    installed: number
  beforeEach(async () => {
    now = Date.parse('2026-10-15T12:00:00Z')
    installed = now
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: AUTH_TYPEORM_ENTITIES,
      synchronize: true,
    }).initialize()
    await new sessionDeviceActivity1792022400000().up(db.createQueryRunner())
    await new sessionInactivity1792108800000().up(db.createQueryRunner())
    await db.query('UPDATE session_inactivity_policy SET installed_at = ?', [installed])
    await db.getRepository(User).insert({
      uuid: userUuid,
      email: 'inactive@example.test',
      encryptedPassword: 'stored',
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    const sql = db.getRepository(TypeORMCacheEntry)
    ephemeral = new TypeORMEphemeralSessionRepository(
      new TypeORMCacheEntryRepository(sql, new CacheEntryPersistenceMapper()),
      9999999,
      {
        getUTCDate: () => new Date(now),
        getUTCDateNSecondsAhead: (seconds: number) => new Date(now + seconds * 1000),
      } as never,
      sql,
    )
    policy = new SessionInactivityService(db.getRepository(Session), ephemeral, () => new Date(now))
  })
  afterEach(async () => {
    policy.stop()
    jest.useRealTimers()
    await db.destroy()
  })
  const session = (n = 2, created = now) =>
    Object.assign(new Session(), {
      uuid: id(n),
      userUuid,
      privateIdentifier: `private${n}`,
      authGeneration: 0,
      createdAt: new Date(created),
      updatedAt: new Date(now),
      accessExpiration: new Date(now + 9999999999),
      refreshExpiration: new Date(now + 9999999999),
      hashedAccessToken: createHash('sha256').update('access').digest('hex'),
      hashedRefreshToken: 'hash',
      apiVersion: '20200115',
      version: 1,
      readonlyAccess: false,
    })
  const device = async (s: Session, time: number) =>
    db.query('INSERT INTO session_device_activity VALUES (?,?,?,?)', [userUuid, s.uuid, 'real-profile', time])
  it('gives unobserved legacy sessions fixed install grace without inventing last-seen and expires strictly after60days', async () => {
    const old = session(2, now - 365 * 86400000)
    await db.getRepository(Session).insert(old)
    expect(await policy.check(old)).toBe(true)
    expect(await policy.lastSeen(userUuid, old.uuid)).toBeUndefined()
    now = installed + SESSION_INACTIVITY_MS
    expect(await policy.check(old)).toBe(true)
    now++
    expect(await policy.check(old)).toBe(false)
    expect(await db.getRepository(Session).findOneBy({ uuid: old.uuid })).toBeNull()
    expect(await db.getRepository(RevokedSession).findOneBy({ uuid: old.uuid })).not.toBeNull()
    expect(await policy.check(old, true)).toBe(false)
    expect(await policy.lastSeen(userUuid, old.uuid)).toBeUndefined()
  })
  it('uses creation for new unobserved sessions and preserves a genuinely used legacy session after installation grace', async () => {
    const legacy = session(2, installed - 365 * 86400000)
    expect(await policy.check(legacy, true)).toBe(true)
    now = installed + SESSION_INACTIVITY_MS
    expect(await policy.check(legacy, true)).toBe(true)
    now++
    expect(await policy.check(legacy)).toBe(true)
    const fresh = session(3, now)
    expect(await policy.check(fresh)).toBe(true)
    now += SESSION_INACTIVITY_MS
    expect(await policy.check(fresh)).toBe(true)
    now++
    expect(await policy.check(fresh)).toBe(false)
  })
  it('device history overrides grace, retains newest observations and ignores updated_at without changing account generation', async () => {
    const stale = session(2, installed - 365 * 86400000),
      active = session(3, installed - 365 * 86400000)
    await db.getRepository(Session).insert([stale, active])
    await device(stale, now - SESSION_INACTIVITY_MS - 1)
    await device(active, now - 1000)
    expect(await policy.retain([stale, active])).toEqual([active])
    expect(await db.getRepository(Session).count()).toBe(1)
    expect((await db.getRepository(User).findOneByOrFail({ uuid: userUuid })).authGeneration).toBe(0)
  })
  it('rejects stale tokens before periodic cleanup and never records accesshash-only validation as usage', async () => {
    const s = session()
    await db.getRepository(Session).insert(s)
    const getter = new GetSessionFromToken(
      { findOneByUuid: async () => s } as never,
      { findOneByUuid: async () => null } as never,
      {} as never,
      { error: jest.fn() } as never,
      undefined,
      policy,
    )
    const request = {
      authTokenFromHeaders: `1:${s.uuid}:access`,
      requestMetadata: { method: 'POST', url: '/sessions/refresh' },
    }
    expect((await getter.execute(request)).isFailed()).toBe(false)
    expect(await policy.lastSeen(userUuid, s.uuid)).toBeUndefined()
    await device(s, now - SESSION_INACTIVITY_MS - 1)
    expect((await getter.execute(request)).isFailed()).toBe(true)
    expect(await policy.lastSeen(userUuid, s.uuid)).toBeUndefined()
  })
  it('automatically removes stale ephemeral aliases, fences late refresh and retains active cached sessions', async () => {
    const stale = session(2),
      active = session(3)
    await ephemeral.insert(stale)
    await ephemeral.insert(active)
    await device(stale, now - SESSION_INACTIVITY_MS - 1)
    await device(active, now - 1000)
    await policy.cleanup()
    expect(await ephemeral.findOneByUuid(stale.uuid)).toBeNull()
    expect(await ephemeral.findOneByPrivateIdentifier(stale.privateIdentifier!)).toBeNull()
    await expect(ephemeral.update(stale)).rejects.toThrow()
    expect(await ephemeral.findOneByUuid(active.uuid)).not.toBeNull()
    await ephemeral.insert(stale)
    expect(await policy.check(stale, true)).toBe(false)
  })
  it('serializes actual use with cleanup while already-inactive sessions cannot revive themselves', async () => {
    const current = session(),
      stale = session(3)
    await db.getRepository(Session).insert([current, stale])
    await device(current, now - SESSION_INACTIVITY_MS)
    await device(stale, now - SESSION_INACTIVITY_MS - 1)
    const [kept] = await Promise.all([policy.check(current, true), policy.cleanup()])
    expect(kept).toBe(true)
    expect(await db.getRepository(Session).findOneBy({ uuid: current.uuid })).not.toBeNull()
    expect(await policy.check(stale, true)).toBe(false)
  })
  it('shows genuine server usage without inventing a device profile or exposing creation/grace as last-seen', async () => {
    const s = session()
    await policy.check(s, true)
    const list = new SessionActivityService(
      db.getRepository(Session),
      { execute: async () => ({ sessions: [s] }) } as GetActiveSessionsForUser,
      { projectCustom: () => ({ uuid: s.uuid }) } as never,
      () => new Date(now),
      policy,
    )
    expect((await list.list(userUuid))[0]).toMatchObject({
      last_seen_at: new Date(now).toISOString(),
      active: true,
      devices: [],
    })
    expect(await db.query('SELECT COUNT(*) AS count FROM session_device_activity')).toEqual([{ count: 0 }])
  })
  it('schedules automatically without duplicate timers and stops cleanly', async () => {
    jest.useFakeTimers()
    const cleanup = jest.spyOn(policy, 'cleanup').mockResolvedValue()
    policy.start()
    policy.start()
    expect(cleanup).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(3600000)
    expect(cleanup).toHaveBeenCalledTimes(2)
    policy.stop()
    jest.advanceTimersByTime(3600000)
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
  it('uses the actual default server clock and fails closed if the policy singleton is absent', async () => {
    const real = new SessionInactivityService(db.getRepository(Session), ephemeral)
    const s = session()
    const before = Date.now()
    expect(await real.check(s, true)).toBe(true)
    expect(await real.lastSeen(userUuid, s.uuid)).toBeGreaterThanOrEqual(before)
    expect(await real.lastSeen(userUuid, s.uuid)).toBeLessThanOrEqual(Date.now())
    await db.query('DELETE FROM session_inactivity_policy')
    await expect(policy.check(session(3))).rejects.toThrow('Session inactivity policy is unavailable')
    await db.query('INSERT INTO session_inactivity_policy VALUES (1,?)', [installed])
    await device(s, Date.now() - SESSION_INACTIVITY_MS - 1)
    await db.query('UPDATE session_activity SET last_seen_at = NULL')
    jest.spyOn(ephemeral, 'deleteOne').mockRejectedValue(new Error('cache unavailable'))
    expect(await real.check(s)).toBe(false)
  })
  it('continues bounded cleanup after one failed candidate and prevents overlapping runs', async () => {
    await db.getRepository(Session).insert([session(2), session(3)])
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>((resolve) => {
        release = resolve
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve
      })
    const check = jest
      .spyOn(policy, 'check')
      .mockImplementationOnce(async () => {
        entered()
        await waiting
        throw new Error('candidate unavailable')
      })
      .mockResolvedValue(true)
    const pending = policy.cleanup()
    await started
    await policy.cleanup()
    expect(check).toHaveBeenCalledTimes(1)
    release()
    await pending
    expect(check).toHaveBeenCalledTimes(2)
  })
  it('never processes more than200durable candidates per bounded cleanup page', async () => {
    await db.getRepository(Session).insert(Array.from({ length: 201 }, (_, index) => session(index + 2)))
    const check = jest.spyOn(policy, 'check').mockResolvedValue(true)
    await policy.cleanup()
    expect(check).toHaveBeenCalledTimes(200)
    await policy.cleanup()
    expect(check).toHaveBeenCalledTimes(201)
  })
  it('retries scheduled cleanup after a transient database failure without leaking an interval', async () => {
    jest.useFakeTimers()
    const onFailure = jest.fn()
    const scheduled = new SessionInactivityService(db.getRepository(Session), ephemeral, () => new Date(now), onFailure)
    const cleanup = jest
      .spyOn(scheduled, 'cleanup')
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue(undefined)
    try {
      scheduled.start()
      await Promise.resolve()
      await Promise.resolve()
      expect(onFailure).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(3600000)
      expect(cleanup).toHaveBeenCalledTimes(2)
    } finally {
      scheduled.stop()
    }
  })
  it('continues cleanup after a failed ephemeral candidate without granting the candidate new activity', async () => {
    const onFailure = jest.fn()
    const worker = new SessionInactivityService(
      db.getRepository(Session),
      { getNextCleanupBatch: async () => [session()] } as never,
      () => new Date(now),
      onFailure,
    )
    jest.spyOn(worker, 'check').mockRejectedValue(new Error('candidate unavailable'))
    await worker.cleanup()
    expect(onFailure).toHaveBeenCalledTimes(1)
    expect(await policy.lastSeen(userUuid, id(2))).toBeUndefined()
  })
})
