import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { DeleteSessionByTokenDTO } from './DeleteSessionByTokenDTO'
import { GetSessionFromToken } from '../GetSessionFromToken/GetSessionFromToken'
import { SessionRepositoryInterface } from '../../Session/SessionRepositoryInterface'
import { EphemeralSessionRepositoryInterface } from '../../Session/EphemeralSessionRepositoryInterface'
import { Session } from '../../Session/Session'
import { AuditLogWriterInterface } from '../../AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../../AuditLog/AuditAction'
import { WebhookDispatcherInterface } from '../../Webhook/WebhookDispatcherInterface'
import { WebhookEvent } from '../../Webhook/WebhookEvent'

export class DeleteSessionByToken implements UseCaseInterface<Session> {
  constructor(
    private getSessionFromToken: GetSessionFromToken,
    private sessionRepository: SessionRepositoryInterface,
    private ephemeralSessionRepository: EphemeralSessionRepositoryInterface,
    // Standard Red Notes: optional audit hook (trailing optional param so
    // existing call sites/specs are unchanged). Records logout when present.
    private auditLogWriter?: AuditLogWriterInterface,
    // Standard Red Notes: optional webhook hook (trailing optional param). Fires
    // the `session.revoked` outbound webhook when present; best-effort so it can
    // never fail the logout/revocation.
    private webhookDispatcher?: WebhookDispatcherInterface,
  ) {}

  async execute(dto: DeleteSessionByTokenDTO): Promise<Result<Session>> {
    const resultOrError = await this.getSessionFromToken.execute(dto)
    if (resultOrError.isFailed()) {
      return Result.fail(resultOrError.getError())
    }
    const result = resultOrError.getValue()

    if (result.isEphemeral) {
      await this.ephemeralSessionRepository.deleteOne(result.session.uuid, result.session.userUuid)
    } else {
      await this.sessionRepository.deleteOneByUuid(result.session.uuid)
    }

    if (this.auditLogWriter !== undefined) {
      await this.auditLogWriter.write({
        actorUuid: result.session.userUuid,
        action: AuditAction.Logout,
        targetType: 'session',
        targetUuid: result.session.uuid,
      })
    }

    if (this.webhookDispatcher !== undefined) {
      try {
        await this.webhookDispatcher.dispatch(WebhookEvent.SessionRevoked, {
          userUuid: result.session.userUuid,
          // E2E-safe payload: uuids + timestamp only, never tokens/secrets.
          metadata: {
            sessionUuid: result.session.uuid,
            reason: 'logout',
            revokedAt: new Date().toISOString(),
          },
        })
      } catch {
        // Best-effort: a webhook delivery failure must never fail logout.
        // The dispatcher already logs its own failures internally.
      }
    }

    return Result.ok(result.session)
  }
}
