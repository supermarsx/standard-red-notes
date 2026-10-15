import { TimerInterface } from '@standardnotes/time'
import { inject, injectable } from 'inversify'
import TYPES from '../Bootstrap/Types'

import { Session } from '../Domain/Session/Session'
import { SessionServiceInterface } from '../Domain/Session/SessionServiceInterface'
import { CustomProjectorInterface } from './ProjectorInterface'

@injectable()
export class SessionProjector implements CustomProjectorInterface<Session> {
  static readonly CURRENT_SESSION_PROJECTION = 'CURRENT_SESSION_PROJECTION'

  constructor(
    @inject(TYPES.Auth_SessionService) private sessionService: SessionServiceInterface,
    @inject(TYPES.Auth_Timer) private timer: TimerInterface,
  ) {}

  projectSimple(session: Session): Record<string, unknown> {
    return {
      uuid: session.uuid,
      api_version: session.apiVersion,
      created_at: this.timer.convertDateToISOString(session.createdAt),
      updated_at: this.timer.convertDateToISOString(session.updatedAt),
      device_info: this.sessionService.getDeviceInfo(session),
      ip_address: session.ipAddress ?? null,
      readonly_access: this.projectReadonlyAccess(session),
      access_expiration: this.timer.convertDateToISOString(session.accessExpiration),
      refresh_expiration: this.timer.convertDateToISOString(session.refreshExpiration),
    }
  }

  projectCustom(projectionType: string, session: Session, currentSession: Session): Record<string, unknown> {
    switch (projectionType) {
      case SessionProjector.CURRENT_SESSION_PROJECTION.toString():
        return {
          uuid: session.uuid,
          api_version: session.apiVersion,
          created_at: this.timer.convertDateToISOString(session.createdAt),
          updated_at: this.timer.convertDateToISOString(session.updatedAt),
          device_info: this.sessionService.getDeviceInfo(session),
          ip_address: session.ipAddress ?? null,
          current: session.uuid === currentSession.uuid,
          readonly_access: this.projectReadonlyAccess(session),
        }
      default:
        throw new Error(`Not supported projection type: ${projectionType}`)
    }
  }

  private projectReadonlyAccess(session: Session): boolean {
    // MySQL/MariaDB hydrate the tinyint column as 0/1, despite its declared TS type.
    const value: unknown = session.readonlyAccess
    if (value === true || value === 1) {
      return true
    }
    if (value === false || value === 0) {
      return false
    }
    throw new Error('Session access policy has an invalid representation.')
  }
}
