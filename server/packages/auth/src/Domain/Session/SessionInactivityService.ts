import { Repository } from 'typeorm'
import { Session } from './Session'
import { RevokedSession } from './RevokedSession'
import { EphemeralSessionRepositoryInterface } from './EphemeralSessionRepositoryInterface'
import { runAuthTypeORMTransaction } from '../../Infra/TypeORM/AuthTypeORMTransactionCoordinator'

export const SESSION_INACTIVITY_MS = 60 * 24 * 60 * 60 * 1000
export class InactiveSessionError extends Error {
  constructor() {
    super('Session is no longer active.')
    this.name = 'InactiveSessionError'
  }
}
/** Per-session SQL fence; no account epoch or factor changes. Installation
 * grace is policy metadata, never a fabricated last-seen observation. */
export class SessionInactivityService {
  private interval?: ReturnType<typeof setInterval>
  private running = false
  private durableCursor?: string
  constructor(
    private sessions: Repository<Session>,
    private ephemeral: EphemeralSessionRepositoryInterface,
    private now: () => Date = () => new Date(),
    private onFailure: () => void = () => undefined,
  ) {}
  async check(session: Session, observe = false): Promise<boolean> {
    const active = await runAuthTypeORMTransaction(this.sessions.manager.connection, async (manager) => {
      const now = this.now().getTime()
      const usesRowLocks = ['mysql', 'mariadb'].includes(this.sessions.manager.connection.options.type)
      if (usesRowLocks) {
        // A duplicate INSERT IGNORE holds a shared lock. Concurrent checks then
        // deadlock upgrading it to FOR UPDATE. This no-op upsert takes the
        // exclusive lock immediately and preserves observations and tombstones.
        await manager.query(
          'INSERT INTO session_activity (user_uuid, session_uuid, last_seen_at, revoked_at) VALUES (?, ?, NULL, NULL) ON DUPLICATE KEY UPDATE session_uuid = session_uuid',
          [session.userUuid, session.uuid],
        )
      } else {
        await manager
          .createQueryBuilder()
          .insert()
          .into('session_activity')
          .values({ user_uuid: session.userUuid, session_uuid: session.uuid, last_seen_at: null, revoked_at: null })
          .orIgnore()
          .execute()
      }
      const suffix = usesRowLocks ? ' FOR UPDATE' : ''
      const [row] = await manager.query(
        'SELECT last_seen_at, revoked_at FROM session_activity WHERE user_uuid = ? AND session_uuid = ?' + suffix,
        [session.userUuid, session.uuid],
      )
      if (row.revoked_at !== null) {
        return false
      }
      const [device] = await manager.query(
        'SELECT MAX(last_seen_at) AS last_seen_at FROM session_device_activity WHERE user_uuid = ? AND session_uuid = ?',
        [session.userUuid, session.uuid],
      )
      const observed = [row.last_seen_at, device.last_seen_at]
        .filter((value) => value !== null && Number.isFinite(Number(value)))
        .map(Number)
      let baseline: number
      if (observed.length) {
        baseline = Math.max(...observed)
      } else {
        const [policy] = await manager.query('SELECT installed_at FROM session_inactivity_policy WHERE id = 1')
        if (!policy || !Number.isFinite(Number(policy.installed_at))) {
          throw new Error('Session inactivity policy is unavailable')
        }
        const created = new Date(session.createdAt).getTime()
        baseline = Math.max(
          Number(policy.installed_at),
          Number.isFinite(created) ? created : Number(policy.installed_at),
        )
      }
      if (now - baseline > SESSION_INACTIVITY_MS) {
        await manager
          .createQueryBuilder()
          .update('session_activity')
          .set({ revoked_at: now })
          .where('user_uuid = :user AND session_uuid = :session', { user: session.userUuid, session: session.uuid })
          .execute()
        await manager
          .getRepository(RevokedSession)
          .createQueryBuilder()
          .insert()
          .values({
            uuid: session.uuid,
            userUuid: session.userUuid,
            privateIdentifier: session.privateIdentifier,
            createdAt: this.now(),
            received: false,
            apiVersion: session.apiVersion,
            userAgent: session.userAgent,
            ipAddress: session.ipAddress,
          })
          .orIgnore()
          .execute()
        await manager.getRepository(Session).delete({ uuid: session.uuid, userUuid: session.userUuid })
        return false
      }
      if (observe) {
        await manager
          .createQueryBuilder()
          .update('session_activity')
          .set({ last_seen_at: Math.max(now, ...observed) })
          .where('user_uuid = :user AND session_uuid = :session', { user: session.userUuid, session: session.uuid })
          .execute()
      }
      return true
    })
    if (!active) {
      try {
        await this.ephemeral.deleteOne(session.uuid, session.userUuid)
      } catch {
        this.onFailure()
      }
    }
    return active
  }
  async lastSeen(userUuid: string, sessionUuid: string): Promise<number | undefined> {
    const [row] = await this.sessions.manager.query(
      'SELECT last_seen_at FROM session_activity WHERE user_uuid = ? AND session_uuid = ?',
      [userUuid, sessionUuid],
    )
    const seen = row?.last_seen_at !== null && row?.last_seen_at !== undefined ? Number(row.last_seen_at) : undefined
    return seen !== undefined && Number.isFinite(seen) && seen >= 0 ? seen : undefined
  }
  async retain(sessions: Session[]): Promise<Session[]> {
    const kept: Session[] = []
    for (const session of sessions) {
      if (await this.check(session)) {
        kept.push(session)
      }
    }
    return kept
  }
  async purgeUser(userUuid: string): Promise<void> {
    for (const table of ['session_device_activity', 'session_activity']) {
      for (;;) {
        const removed = await runAuthTypeORMTransaction(this.sessions.manager.connection, async (manager) => {
          const rows = await manager
            .createQueryBuilder()
            .select([
              'activity.session_uuid AS session_uuid',
              ...(table === 'session_device_activity' ? ['activity.device_id AS device_id'] : []),
            ])
            .from(table, 'activity')
            .where('activity.user_uuid = :userUuid', { userUuid })
            .limit(200)
            .getRawMany<{ session_uuid: string; device_id?: string }>()
          if (!rows.length) {
            return 0
          }
          const parameters: Record<string, string> = { userUuid }
          const matching = rows
            .map((row, index) => {
              parameters[`session${index}`] = row.session_uuid
              if (table === 'session_device_activity') {
                parameters[`device${index}`] = row.device_id!
              }
              return `(session_uuid = :session${index}${table === 'session_device_activity' ? ` AND device_id = :device${index}` : ''})`
            })
            .join(' OR ')
          await manager
            .createQueryBuilder()
            .delete()
            .from(table)
            .where(`user_uuid = :userUuid AND (${matching})`, parameters)
            .execute()
          return rows.length
        })
        if (!removed) {
          break
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }
  async cleanup(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      const query = this.sessions.createQueryBuilder('session').orderBy('session.uuid', 'ASC').take(200)
      if (this.durableCursor) {
        query.where('session.uuid > :cursor', { cursor: this.durableCursor })
      }
      const durable = await query.getMany()
      this.durableCursor = durable.length ? durable[durable.length - 1].uuid : undefined
      for (const session of durable) {
        try {
          await this.check(session)
        } catch {
          this.onFailure()
        }
      }
      const ephemeral = (await this.ephemeral.getNextCleanupBatch?.(200)) ?? []
      for (const session of ephemeral) {
        try {
          await this.check(session)
        } catch {
          this.onFailure()
        }
      }
    } finally {
      this.running = false
    }
  }
  start(): void {
    if (this.interval) {
      return
    }
    const run = () => {
      void this.cleanup().catch(() => this.onFailure())
    }
    this.interval = setInterval(run, 60 * 60 * 1000)
    this.interval.unref?.()
    run()
  }
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
    }
    this.interval = undefined
  }
}
