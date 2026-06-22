import { Result, UseCaseInterface } from '@standardnotes/domain-core'
import { DeleteSessionByTokenDTO } from './DeleteSessionByTokenDTO'
import { GetSessionFromToken } from '../GetSessionFromToken/GetSessionFromToken'
import { SessionRepositoryInterface } from '../../Session/SessionRepositoryInterface'
import { EphemeralSessionRepositoryInterface } from '../../Session/EphemeralSessionRepositoryInterface'
import { Session } from '../../Session/Session'
import { AuditLogWriterInterface } from '../../AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../../AuditLog/AuditAction'

export class DeleteSessionByToken implements UseCaseInterface<Session> {
  constructor(
    private getSessionFromToken: GetSessionFromToken,
    private sessionRepository: SessionRepositoryInterface,
    private ephemeralSessionRepository: EphemeralSessionRepositoryInterface,
    // Standard Red Notes: optional audit hook (trailing optional param so
    // existing call sites/specs are unchanged). Records logout when present.
    private auditLogWriter?: AuditLogWriterInterface,
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

    return Result.ok(result.session)
  }
}
