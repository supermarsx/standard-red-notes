import { inject, injectable, optional } from 'inversify'
import { Result, UseCaseInterface, Uuid } from '@standardnotes/domain-core'

import TYPES from '../../Bootstrap/Types'
import { EphemeralSession } from '../Session/EphemeralSession'
import { EphemeralSessionRepositoryInterface } from '../Session/EphemeralSessionRepositoryInterface'
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
    /**
     * Standard Red Notes: EPHEMERAL sessions were not terminated here at all.
     *
     * This use case backs the two emergency gestures a person reaches for after a
     * compromise: "revoke all other sessions" (`DELETE /v1/sessions/all`) and a
     * password/email change (ChangeCredentials calls it on every credential
     * change). Both only ever read `sessionRepository`, so an ephemeral session —
     * one created with `ephemeral: true`, which lives in its own store
     * (`EphemeralSessionRepository`, cache-backed) and is NOT a row in `sessions`
     * — survived both of them while still appearing in the account's session list
     * (`GetActiveSessionsForUser` concatenates both stores). Revoking one session
     * at a time DID handle ephemeral sessions (`DeleteSessionForUser`), so the gap
     * was only in the bulk paths: exactly the ones used to end an intrusion.
     *
     * Deliberately REQUIRED, and positioned exactly where the sibling
     * `DeleteSessionForUser` carries it rather than appended as a trailing
     * optional: every container branch binds `Auth_EphemeralSessionRepository`
     * (TypeORM cache and Redis alike), and an optional dependency is how this
     * sweep could silently become a no-op again — a security sweep that reports
     * success without running is worse than a construction error.
     */
    @inject(TYPES.Auth_EphemeralSessionRepository)
    private ephemeralSessionRepository: EphemeralSessionRepositoryInterface,
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

    // Sequenced AFTER the persistent sweep, never before: the ephemeral store is
    // cache-backed, so letting it run first would mean a cache outage could stop
    // the persistent revocation from happening at all. Running it second means an
    // outage can only ever fail LOUDLY (the error propagates) after the durable
    // sessions are already gone — it can never report a sweep that did not happen.
    const revokedEphemeralSessions = await this.deleteOtherEphemeralSessions(
      dto.userUuid,
      currentSessionUuid.value,
      dto.markAsRevoked,
    )

    const revokedSessions = sessions
      .filter((session: Session) => session.uuid !== currentSessionUuid.value)
      .concat(revokedEphemeralSessions)
    await this.recordRevocations(dto.userUuid, revokedSessions)

    return Result.ok()
  }

  /**
   * Terminate every ephemeral session for the account except the current one, and
   * return the ones terminated so they are audited/announced like any other
   * revocation. `EphemeralSessionRepositoryInterface` has no bulk delete, so this
   * deletes one at a time — the set is a person's open devices, not a crowd.
   */
  private async deleteOtherEphemeralSessions(
    userUuid: string,
    currentSessionUuid: string,
    markAsRevoked: boolean,
  ): Promise<EphemeralSession[]> {
    const ephemeralSessions = await this.ephemeralSessionRepository.findAllByUserUuid(userUuid)
    const otherEphemeralSessions = ephemeralSessions.filter(
      (session: EphemeralSession) => session.uuid !== currentSessionUuid,
    )

    for (const session of otherEphemeralSessions) {
      if (markAsRevoked) {
        await this.sessionService.createRevokedSession(session)
      }

      await this.ephemeralSessionRepository.deleteOne(session.uuid, userUuid)
    }

    return otherEphemeralSessions
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
