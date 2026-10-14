import { Repository } from 'typeorm'
import { Session } from './Session'
import { GetActiveSessionsForUser } from '../UseCase/GetActiveSessionsForUser'
import { CustomProjectorInterface } from '../../Projection/ProjectorInterface'
import { SessionProjector } from '../../Projection/SessionProjector'
import { runAuthTypeORMTransaction } from '../../Infra/TypeORM/AuthTypeORMTransactionCoordinator'
import { SessionInactivityService } from './SessionInactivityService'

export const SESSION_ACTIVITY_WINDOW_MS = 120_000
export const SESSION_DEVICE_ID = /^[a-zA-Z0-9._:-]{1,128}$/

/** Presence observations are never authorization credentials. */
export class SessionActivityService {
  constructor(
    private sessions: Repository<Session>,
    private getSessions: GetActiveSessionsForUser,
    private projector: CustomProjectorInterface<Session>,
    private now: () => Date = () => new Date(),
    private inactivity?: SessionInactivityService,
  ) {}

  async record(userUuid: string, sessionUuid: string, deviceId: string): Promise<Record<string, unknown> | undefined> {
    const { sessions } = await this.getSessions.execute({ userUuid, sessionUuid })
    const session = sessions[0]
    const now = this.now()
    if (!session || new Date(session.refreshExpiration).getTime() <= now.getTime()) {
      return undefined
    }
    if (this.inactivity && !(await this.inactivity.check(session, true))) {
      return undefined
    }
    await runAuthTypeORMTransaction(this.sessions.manager.connection, async (manager) => {
      await manager
        .createQueryBuilder()
        .insert()
        .into('session_device_activity')
        .values({
          user_uuid: userUuid,
          session_uuid: sessionUuid,
          device_id: deviceId,
          last_seen_at: now.getTime(),
        })
        .orIgnore()
        .execute()
      await manager
        .createQueryBuilder()
        .update('session_device_activity')
        .set({ last_seen_at: now.getTime() })
        .where(
          'user_uuid = :userUuid AND session_uuid = :sessionUuid AND device_id = :deviceId AND last_seen_at < :seen',
          { userUuid, sessionUuid, deviceId, seen: now.getTime() },
        )
        .execute()
    })
    return { last_seen_at: now.toISOString(), activity_checked_at: now.toISOString(), active: true }
  }

  async list(userUuid: string, currentSessionUuid?: string): Promise<Array<Record<string, unknown>>> {
    const { sessions } = await this.getSessions.execute({ userUuid })
    const now = this.now()
    const valid = sessions.filter((session) => new Date(session.refreshExpiration).getTime() > now.getTime())
    if (!valid.length) {
      return []
    }
    const rows = await this.sessions.manager
      .createQueryBuilder()
      .select('*')
      .from('session_device_activity', 'activity')
      .where('activity.user_uuid = :userUuid', { userUuid })
      .andWhere('activity.session_uuid IN (:...uuids)', { uuids: valid.map((session) => session.uuid) })
      .getRawMany<{ session_uuid: string; device_id: string; last_seen_at: number | string }>()
    return Promise.all(
      valid.map(async (session) => {
        const devices = rows
          .filter((row) => row.session_uuid === session.uuid)
          .map((row) => {
            const seen = new Date(Number(row.last_seen_at))
            return {
              device_id: row.device_id,
              last_seen_at: seen.toISOString(),
              active: now.getTime() - seen.getTime() < SESSION_ACTIVITY_WINDOW_MS,
            }
          })
          .sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at))
        const used = this.inactivity ? await this.inactivity.lastSeen(userUuid, session.uuid) : undefined
        const deviceSeen = devices[0] ? Date.parse(devices[0].last_seen_at) : undefined
        const seen = Math.max(...[used, deviceSeen].filter((value): value is number => value !== undefined))
        return {
          ...this.projector.projectCustom(SessionProjector.CURRENT_SESSION_PROJECTION, session, {
            uuid: currentSessionUuid,
          } as Session),
          refresh_expiration: new Date(session.refreshExpiration).toISOString(),
          last_seen_at: Number.isFinite(seen) ? new Date(seen).toISOString() : null,
          active: Number.isFinite(seen) && now.getTime() - seen < SESSION_ACTIVITY_WINDOW_MS,
          activity_checked_at: now.toISOString(),
          devices,
        }
      }),
    )
  }
}
