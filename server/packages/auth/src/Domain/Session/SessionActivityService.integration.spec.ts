import { DataSource } from 'typeorm'
import { Session } from './Session'
import { SessionActivityService, SESSION_DEVICE_ID } from './SessionActivityService'
import { GetActiveSessionsForUser } from '../UseCase/GetActiveSessionsForUser'
import { sessionDeviceActivity1792022400000 } from '../../../migrations/sqlite/1792022400000-session-device-activity'

const user = '00000000-0000-4000-8000-000000000001'
const sessionId = '00000000-0000-4000-8000-000000000002'
describe('authenticated session/device activity storage', () => {
  let db: DataSource, service: SessionActivityService, now: number, current: Session[]
  beforeEach(async () => {
    now = Date.parse('2026-10-14T12:00:00Z')
    db = await new DataSource({
      type: 'better-sqlite3',
      database: ':memory:',
      entities: [Session],
      synchronize: true,
    }).initialize()
    await new sessionDeviceActivity1792022400000().up(db.createQueryRunner())
    current = [{ uuid: sessionId, refreshExpiration: new Date(now + 300_000) } as Session]
    service = new SessionActivityService(
      db.getRepository(Session),
      { execute: async () => ({ sessions: current }) } as GetActiveSessionsForUser,
      {
        projectSimple: () => ({}),
        projectCustom: (_type, session, own) => ({ uuid: session.uuid, current: session.uuid === own.uuid }),
      },
      () => new Date(now),
    )
  })
  afterEach(async () => {
    await db.destroy()
  })
  it('starts unknown, deduplicates two tabs on one device and records independent profiles using server time', async () => {
    expect(await service.list(user)).toEqual([
      expect.objectContaining({ last_seen_at: null, active: false, devices: [] }),
    ])
    await Promise.all(Array.from({ length: 20 }, () => service.record(user, sessionId, 'device-a')))
    await service.record(user, sessionId, 'device-b')
    const list = await service.list(user, sessionId)
    expect(list[0]).toMatchObject({
      current: true,
      active: true,
      last_seen_at: '2026-10-14T12:00:00.000Z',
      activity_checked_at: '2026-10-14T12:00:00.000Z',
    })
    expect(list[0].devices).toHaveLength(2)
    expect(await db.query('SELECT COUNT(*) AS count FROM session_device_activity')).toEqual([{ count: 2 }])
  })
  it('expires active status at120 seconds, retains lastseen, excludes expired and revoked sessions', async () => {
    await service.record(user, sessionId, 'device-a')
    now += 120_000
    expect((await service.list(user))[0]).toMatchObject({ active: false, last_seen_at: '2026-10-14T12:00:00.000Z' })
    now += 180_000
    expect(await service.list(user)).toEqual([])
    expect(await service.record(user, sessionId, 'device-a')).toBeUndefined()
    current = []
    expect(await service.list(user)).toEqual([])
  })
  it('keeps activity timestamps monotonic when an older observation arrives later', async () => {
    await service.record(user, sessionId, 'device-a')
    now -= 10_000
    await service.record(user, sessionId, 'device-a')
    expect((await service.list(user))[0]).toMatchObject({ last_seen_at: '2026-10-14T12:00:00.000Z' })
  })
  it('uses the real server clock when no clock is injected', async () => {
    const clock = new SessionActivityService(
      db.getRepository(Session),
      { execute: async () => ({ sessions: [] }) } as GetActiveSessionsForUser,
      {} as never,
    )
    expect(await clock.list(user)).toEqual([])
  })
  it('does not publish a device observation when its inactivity fence refuses an authenticated heartbeat', async () => {
    const guarded = new SessionActivityService(
      db.getRepository(Session),
      { execute: async () => ({ sessions: current }) } as GetActiveSessionsForUser,
      {} as never,
      () => new Date(now),
      { check: async () => false } as never,
    )
    expect(await guarded.record(user, sessionId, 'profile-a')).toBeUndefined()
    expect(await db.query('SELECT COUNT(*) AS count FROM session_device_activity')).toEqual([{ count: 0 }])
    expect(SESSION_DEVICE_ID.test('profile-a')).toBe(true)
    expect(SESSION_DEVICE_ID.test('../profile')).toBe(false)
  })
})
