import 'reflect-metadata'
import { spawn, execFileSync } from 'child_process'
import { randomBytes } from 'crypto'
import { Duplex } from 'stream'
import { DataSource, DataSourceOptions } from 'typeorm'
import { AUTH_TYPEORM_ENTITIES } from '../../Bootstrap/DataSource'
import { sessionDeviceActivity1792022400000 } from '../../../migrations/mysql/1792022400000-session-device-activity'
import { sessionInactivity1792108800000 } from '../../../migrations/mysql/1792108800000-session-inactivity'
import { SessionInactivityService, SESSION_INACTIVITY_MS } from './SessionInactivityService'
import { Session } from './Session'
import { User } from '../User/User'
import { RevokedSession } from './RevokedSession'

// Explicit opt-in; every run creates and drops its own randomly named database.
// Docker mode uses the isolated acceptance stack without publishing its DB port.
const dockerProject = process.env.AUTH_INACTIVITY_MYSQL_TEST_DOCKER_PROJECT
const url = process.env.AUTH_INACTIVITY_MYSQL_TEST_URL
const mysqlDescribe = dockerProject || url ? describe : describe.skip

function connectionOptions(): DataSourceOptions {
  if (url) {
    return { type: 'mysql', url }
  }
  if (dockerProject !== 'srn-ultra-collab') {
    throw new Error('The MariaDB Docker regression requires the isolated acceptance stack')
  }
  const [container] = JSON.parse(execFileSync('docker', ['inspect', `${dockerProject}-db-1`], { encoding: 'utf8' }))
  const env = new Map<string, string>(
    container.Config.Env.map((entry: string) => {
      const index = entry.indexOf('=')
      return [entry.slice(0, index), entry.slice(index + 1)]
    }),
  )
  return {
    type: 'mysql',
    host: 'db',
    username: 'root',
    password: env.get('MYSQL_ROOT_PASSWORD'),
    extra: {
      connectionLimit: 24,
      stream: () => {
        const child = spawn(
          'docker',
          [
            'exec',
            '-i',
            `${dockerProject}-server-1`,
            'node',
            '-e',
            "const net=require('node:net');const s=net.connect(3306,'db');process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));",
          ],
          { stdio: ['pipe', 'pipe', 'ignore'] },
        )
        const bridge = new Duplex({
          read() {},
          write(chunk, encoding, callback) {
            child.stdin.write(chunk, encoding, callback)
          },
          destroy(error, callback) {
            child.kill()
            callback(error)
          },
        })
        child.stdout.on('data', (chunk) => bridge.push(chunk))
        child.stdout.on('end', () => bridge.push(null))
        child.on('error', () => bridge.destroy(new Error('Isolated DB bridge failed')))
        return bridge
      },
    },
  }
}

mysqlDescribe('session inactivity concurrency on real InnoDB', () => {
  let admin: DataSource, db: DataSource
  const database = `srn_policy_test_${randomBytes(8).toString('hex')}`
  const userUuid = '00000000-0000-4000-8000-000000000001'
  const now = Date.parse('2026-10-15T12:00:00Z')
  beforeAll(async () => {
    expect(database).toMatch(/^srn_policy_test_[a-f0-9]{16}$/)
    const options = connectionOptions()
    admin = await new DataSource({ ...options, database: 'mysql' } as DataSourceOptions).initialize()
    await admin.query(`CREATE DATABASE ${database}`)
    db = await new DataSource({
      ...options,
      database,
      entities: AUTH_TYPEORM_ENTITIES,
      synchronize: true,
    } as DataSourceOptions).initialize()
    await new sessionDeviceActivity1792022400000().up(db.createQueryRunner())
    await new sessionInactivity1792108800000().up(db.createQueryRunner())
    await db.query('UPDATE session_inactivity_policy SET installed_at = ?', [now])
    await db.getRepository(User).insert({
      uuid: userUuid,
      email: 'policy-synthetic@example.test',
      encryptedPassword: 'synthetic',
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
  }, 60_000)
  afterAll(async () => {
    if (db?.isInitialized) {
      const [schema] = await db.query('SELECT DATABASE() AS name')
      expect(schema.name).toBe(database)
      const otherUsers = await db
        .getRepository(User)
        .createQueryBuilder('user')
        .where('user.uuid != :userUuid', { userUuid })
        .getCount()
      expect(otherUsers).toBe(0)
      await db.destroy()
    }
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE IF EXISTS ${database}`)
      await admin.destroy()
    }
  }, 60_000)

  it('reproduces the former duplicate insert lock-upgrade deadlock', async () => {
    const a = db.createQueryRunner(),
      b = db.createQueryRunner()
    await db.query("INSERT INTO session_activity VALUES (?, 'old-pattern', ?, NULL)", [userUuid, now])
    try {
      await Promise.all([a.startTransaction(), b.startTransaction()])
      await Promise.all(
        [a, b].map((runner) =>
          runner.query("INSERT IGNORE INTO session_activity VALUES (?, 'old-pattern', NULL, NULL)", [userUuid]),
        ),
      )
      const results = await Promise.allSettled(
        [a, b].map(async (runner) => {
          await runner.query(
            "SELECT last_seen_at FROM session_activity WHERE user_uuid = ? AND session_uuid = 'old-pattern' FOR UPDATE",
            [userUuid],
          )
          await runner.commitTransaction()
        }),
      )
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      expect(rejected).toHaveLength(1)
      expect(rejected[0].reason.driverError.errno).toBe(1213)
    } finally {
      await Promise.all(
        [a, b].map(async (runner) => {
          if (runner.isTransactionActive) {await runner.rollbackTransaction()}
          await runner.release()
        }),
      )
    }
  }, 30_000)

  it.each([false, true])(
    'concurrent checks preserve activity and expired-session tombstones, expired=%s',
    async (expired) => {
      const session = Object.assign(new Session(), {
        uuid: `00000000-0000-4000-8000-${expired ? '000000000003' : '000000000002'}`,
        userUuid,
        privateIdentifier: null,
        authGeneration: 0,
        createdAt: new Date(now),
        updatedAt: new Date(now),
        accessExpiration: new Date(now + 86_400_000),
        refreshExpiration: new Date(now + 86_400_000),
        hashedAccessToken: 'synthetic-access-hash',
        hashedRefreshToken: 'synthetic-refresh-hash',
        apiVersion: '20200115',
        version: 1,
        readonlyAccess: false,
      })
      await db.getRepository(Session).insert(session)
      const seen = expired ? now - SESSION_INACTIVITY_MS - 1 : now - 1_000
      await db.query('INSERT INTO session_activity VALUES (?, ?, ?, NULL)', [userUuid, session.uuid, seen])
      await db.query('INSERT INTO session_device_activity VALUES (?, ?, ?, ?)', [
        userUuid,
        session.uuid,
        'synthetic-profile',
        seen,
      ])
      const ephemeral = { deleteOne: jest.fn(async () => undefined) }
      const policy = new SessionInactivityService(db.getRepository(Session), ephemeral as never, () => new Date(now))
      const results = await Promise.all(Array.from({ length: 20 }, () => policy.check(session, true)))
      expect(results).toEqual(Array(20).fill(!expired))
      const [row] = await db.query(
        'SELECT last_seen_at, revoked_at FROM session_activity WHERE user_uuid = ? AND session_uuid = ?',
        [userUuid, session.uuid],
      )
      expect(Number(row.last_seen_at)).toBe(expired ? seen : now)
      expect(row.revoked_at === null ? null : Number(row.revoked_at)).toBe(expired ? now : null)
      expect(Boolean(await db.getRepository(Session).findOneBy({ uuid: session.uuid }))).toBe(!expired)
      expect(Boolean(await db.getRepository(RevokedSession).findOneBy({ uuid: session.uuid }))).toBe(expired)
      expect(await policy.check(session)).toBe(!expired)
    },
    60_000,
  )
})
