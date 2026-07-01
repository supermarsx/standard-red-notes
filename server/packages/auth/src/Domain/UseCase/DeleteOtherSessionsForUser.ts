import { inject, injectable, optional } from 'inversify'
import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import TYPES from '../../Bootstrap/Types'
import { Session } from '../Session/Session'
import { SessionRepositoryInterface } from '../Session/SessionRepositoryInterface'
import { SessionServiceInterface } from '../Session/SessionServiceInterface'
import { DeleteOtherSessionsForUserDTO } from './DeleteOtherSessionsForUserDTO'
import { AuditLogWriterInterface } from '../AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../AuditLog/AuditAction'
import { WebhookDispatcherInterface } from '../Webhook/WebhookDispatcherInterface'
import { WebhookEvent } from '../Webhook/WebhookEvent'

@injectable()
export class DeleteOtherSessionsForUser implements UseCaseInterface<void> {
  constructor(
    @inject(TYPES.Auth_SessionRepository) private sessionRepository: SessionRepositoryInterface,
    @inject(TYPES.Auth_SessionService) private sessionService: SessionServiceInterface,
    // Standard Red Notes: optional audit + webhook hooks. Record/fire one
    // `session.revoked` per terminated "other" session when wired; both are
    // best-effort so they can never fail the bulk revocation.
    @inject(TYPES.Auth_AuditLogWriter) @optional() private auditLogWriter?: AuditLogWriterInterface,
    @inject(TYPES.Auth_WebhookDispatcher) @optional() private webhookDispatcher?: WebhookDispatcherInterface,
  ) {}

  async execute(dto: DeleteOtherSessionsForUserDTO): Promise<Result<void>> {
    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail(userUuidOrError.getError())
    }
    const userUuid = userUuidOrError.getValue()

    const currentSessionUuidOrError = Uuid.create(dto.currentSessionUuid)
    if (currentSessionUuidOrError.isFailed()) {
      return Result.fail(currentSessionUuidOrError.getError())
    }
    const currentSessionUuid = currentSessionUuidOrError.getValue()

    const sessions = await this.sessionRepository.findAllByUserUuid(dto.userUuid)

    if (dto.markAsRevoked) {
      await Promise.all(
        sessions.map(async (session: Session) => {
          if (session.uuid !== currentSessionUuid.value) {
            await this.sessionService.createRevokedSession(session)
          }
        }),
      )
    }

    await this.sessionRepository.deleteAllByUserUuidExceptOne({ userUuid, currentSessionUuid })

    const revokedSessions = sessions.filter((session: Session) => session.uuid !== currentSessionUuid.value)
    await this.recordRevocations(dto.userUuid, revokedSessions)

    return Result.ok()
  }

  // Standard Red Notes: best-effort audit + `session.revoked` webhook for each
  // "other" session that was terminated. Mirrors the single-session revoke path
  // (DeleteSessionForUser) so the audit + webhook shape stays consistent.
  private async recordRevocations(userUuid: string, revokedSessions: Session[]): Promise<void> {
    if (this.auditLogWriter === undefined && this.webhookDispatcher === undefined) {
      return
    }

    const revokedAt = new Date().toISOString()

    for (const session of revokedSessions) {
      if (this.auditLogWriter !== undefined) {
        await this.auditLogWriter.write({
          actorUuid: userUuid,
          action: AuditAction.SessionRevoked,
          targetType: 'session',
          targetUuid: session.uuid,
          metadata: { scope: 'other-sessions' },
        })
      }

      if (this.webhookDispatcher !== undefined) {
        try {
          await this.webhookDispatcher.dispatch(WebhookEvent.SessionRevoked, {
            userUuid,
            // E2E-safe payload: uuids + timestamp only, never tokens/secrets.
            metadata: { sessionUuid: session.uuid, scope: 'other-sessions', revokedAt },
          })
        } catch {
          // Best-effort: a webhook delivery failure must never fail revocation.
          // The dispatcher already logs its own failures internally.
        }
      }
    }
  }
}
