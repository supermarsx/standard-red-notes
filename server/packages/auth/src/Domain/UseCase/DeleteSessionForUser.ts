import { inject, injectable, optional } from 'inversify'
import TYPES from '../../Bootstrap/Types'
import { EphemeralSession } from '../Session/EphemeralSession'
import { EphemeralSessionRepositoryInterface } from '../Session/EphemeralSessionRepositoryInterface'
import { Session } from '../Session/Session'
import { SessionRepositoryInterface } from '../Session/SessionRepositoryInterface'
import { SessionServiceInterface } from '../Session/SessionServiceInterface'
import { DeleteSessionForUserDTO } from './DeleteSessionForUserDTO'
import { DeleteSessionForUserResponse } from './DeleteSessionForUserResponse'
import { UseCaseInterface } from './UseCaseInterface'
import { AuditLogWriterInterface } from '../AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../AuditLog/AuditAction'

@injectable()
export class DeleteSessionForUser implements UseCaseInterface {
  constructor(
    @inject(TYPES.Auth_SessionRepository) private sessionRepository: SessionRepositoryInterface,
    @inject(TYPES.Auth_EphemeralSessionRepository)
    private ephemeralSessionRepository: EphemeralSessionRepositoryInterface,
    @inject(TYPES.Auth_SessionService) private sessionService: SessionServiceInterface,
    // Standard Red Notes: optional audit hook. Records a session revocation when
    // wired (home-server binds it; specs may omit it).
    @inject(TYPES.Auth_AuditLogWriter) @optional() private auditLogWriter?: AuditLogWriterInterface,
  ) {}

  async execute(dto: DeleteSessionForUserDTO): Promise<DeleteSessionForUserResponse> {
    let session: Session | EphemeralSession | null

    session = await this.sessionRepository.findOneByUuidAndUserUuid(dto.sessionUuid, dto.userUuid)
    if (session === null) {
      session = await this.ephemeralSessionRepository.findOneByUuidAndUserUuid(dto.sessionUuid, dto.userUuid)

      if (session === null) {
        return {
          success: false,
          errorMessage: 'No session exists with the provided identifier.',
        }
      }
    }

    await this.sessionService.createRevokedSession(session)

    await this.sessionRepository.deleteOneByUuid(dto.sessionUuid)

    await this.ephemeralSessionRepository.deleteOne(dto.sessionUuid, dto.userUuid)

    if (this.auditLogWriter !== undefined) {
      await this.auditLogWriter.write({
        actorUuid: dto.userUuid,
        action: AuditAction.SessionRevoked,
        targetType: 'session',
        targetUuid: dto.sessionUuid,
      })
    }

    return { success: true }
  }
}
