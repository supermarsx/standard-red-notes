import 'reflect-metadata'

import { EphemeralSession } from '../Session/EphemeralSession'
import { EphemeralSessionRepositoryInterface } from '../Session/EphemeralSessionRepositoryInterface'
import { Session } from '../Session/Session'
import { SessionRepositoryInterface } from '../Session/SessionRepositoryInterface'
import { SessionServiceInterface } from '../Session/SessionServiceInterface'
import { AuditLogWriterInterface } from '../AuditLog/AuditLogWriterInterface'
import { AuditAction } from '../AuditLog/AuditAction'
import { WebhookDispatcherInterface } from '../Webhook/WebhookDispatcherInterface'
import { WebhookEvent } from '../Webhook/WebhookEvent'

import { DeleteOtherSessionsForUser } from './DeleteOtherSessionsForUser'

describe('DeleteOtherSessionsForUser', () => {
  let sessionRepository: SessionRepositoryInterface
  let ephemeralSessionRepository: EphemeralSessionRepositoryInterface
  let sessionService: SessionServiceInterface
  let auditLogWriter: AuditLogWriterInterface
  let webhookDispatcher: WebhookDispatcherInterface
  let session: Session
  let currentSession: Session

  const createUseCase = () =>
    new DeleteOtherSessionsForUser(
      sessionRepository,
      ephemeralSessionRepository,
      sessionService,
      auditLogWriter,
      webhookDispatcher,
    )

  beforeEach(() => {
    session = {} as jest.Mocked<Session>
    session.uuid = '00000000-0000-0000-0000-000000000000'

    currentSession = {} as jest.Mocked<Session>
    currentSession.uuid = '00000000-0000-0000-0000-000000000001'

    sessionRepository = {} as jest.Mocked<SessionRepositoryInterface>
    sessionRepository.deleteAllByUserUuidExceptOne = jest.fn()
    sessionRepository.findAllByUserUuid = jest.fn().mockReturnValue([session, currentSession])

    ephemeralSessionRepository = {} as jest.Mocked<EphemeralSessionRepositoryInterface>
    ephemeralSessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([])
    ephemeralSessionRepository.deleteOne = jest.fn()

    sessionService = {} as jest.Mocked<SessionServiceInterface>
    sessionService.createRevokedSession = jest.fn()

    auditLogWriter = {} as jest.Mocked<AuditLogWriterInterface>
    auditLogWriter.write = jest.fn()

    webhookDispatcher = {} as jest.Mocked<WebhookDispatcherInterface>
    webhookDispatcher.dispatch = jest.fn()
  })

  it('should delete all sessions except current for a given user', async () => {
    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      currentSessionUuid: '00000000-0000-0000-0000-000000000001',
      markAsRevoked: true,
    })
    expect(result.isFailed()).toBeFalsy()

    expect(sessionRepository.deleteAllByUserUuidExceptOne).toHaveBeenCalled()

    expect(sessionService.createRevokedSession).toHaveBeenCalledWith(session)
    expect(sessionService.createRevokedSession).not.toHaveBeenCalledWith(currentSession)
  })

  it('should audit + dispatch session.revoked for each terminated other session (not the current one)', async () => {
    await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      currentSessionUuid: '00000000-0000-0000-0000-000000000001',
      markAsRevoked: true,
    })

    expect(auditLogWriter.write).toHaveBeenCalledTimes(1)
    expect(auditLogWriter.write).toHaveBeenCalledWith({
      actorUuid: '00000000-0000-0000-0000-000000000000',
      action: AuditAction.SessionRevoked,
      targetType: 'session',
      targetUuid: session.uuid,
      metadata: { scope: 'other-sessions' },
    })

    expect(webhookDispatcher.dispatch).toHaveBeenCalledTimes(1)
    expect(webhookDispatcher.dispatch).toHaveBeenCalledWith(WebhookEvent.SessionRevoked, {
      userUuid: '00000000-0000-0000-0000-000000000000',
      metadata: expect.objectContaining({ sessionUuid: session.uuid, scope: 'other-sessions' }),
    })
  })

  it('should not fail the bulk revocation when the webhook dispatch throws', async () => {
    webhookDispatcher.dispatch = jest.fn().mockRejectedValue(new Error('network down'))

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      currentSessionUuid: '00000000-0000-0000-0000-000000000001',
      markAsRevoked: true,
    })

    expect(result.isFailed()).toBeFalsy()
  })

  it('should work without the optional audit/webhook hooks', async () => {
    auditLogWriter = undefined as unknown as AuditLogWriterInterface
    webhookDispatcher = undefined as unknown as WebhookDispatcherInterface

    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      currentSessionUuid: '00000000-0000-0000-0000-000000000001',
      markAsRevoked: true,
    })

    expect(result.isFailed()).toBeFalsy()
  })

  it('should delete all sessions except current for a given user without marking as revoked', async () => {
    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      currentSessionUuid: '00000000-0000-0000-0000-000000000001',
      markAsRevoked: false,
    })
    expect(result.isFailed()).toBeFalsy()

    expect(sessionRepository.deleteAllByUserUuidExceptOne).toHaveBeenCalled()

    expect(sessionService.createRevokedSession).not.toHaveBeenCalled()
  })

  it('should not delete any sessions if the user uuid is invalid', async () => {
    const result = await createUseCase().execute({
      userUuid: 'invalid',
      currentSessionUuid: '00000000-0000-0000-0000-000000000001',
      markAsRevoked: true,
    })
    expect(result.isFailed()).toBeTruthy()

    expect(sessionRepository.deleteAllByUserUuidExceptOne).not.toHaveBeenCalled()
    expect(sessionService.createRevokedSession).not.toHaveBeenCalled()
  })

  it('should not delete any sessions if the current session uuid is invalid', async () => {
    const result = await createUseCase().execute({
      userUuid: '00000000-0000-0000-0000-000000000000',
      currentSessionUuid: 'invalid',
      markAsRevoked: true,
    })
    expect(result.isFailed()).toBeTruthy()

    expect(sessionRepository.deleteAllByUserUuidExceptOne).not.toHaveBeenCalled()
    expect(sessionService.createRevokedSession).not.toHaveBeenCalled()
  })

  /**
   * Standard Red Notes: the bulk-revocation paths — "revoke all other sessions"
   * and every credential change — left EPHEMERAL sessions running, because they
   * live in their own store and only `sessionRepository` was swept. These assert
   * the sweep reaches that store too.
   */
  describe('ephemeral sessions', () => {
    let otherEphemeralSession: EphemeralSession
    let currentEphemeralSession: EphemeralSession

    beforeEach(() => {
      // Real instances, not object casts: a cast fails every `instanceof` so a
      // future ephemeral/persistent distinction would pass against a neutered fix.
      otherEphemeralSession = new EphemeralSession()
      otherEphemeralSession.uuid = '00000000-0000-0000-0000-00000000000e'
      otherEphemeralSession.userUuid = '00000000-0000-0000-0000-000000000000'

      currentEphemeralSession = new EphemeralSession()
      currentEphemeralSession.uuid = '00000000-0000-0000-0000-000000000001'
      currentEphemeralSession.userUuid = '00000000-0000-0000-0000-000000000000'

      ephemeralSessionRepository.findAllByUserUuid = jest
        .fn()
        .mockResolvedValue([otherEphemeralSession, currentEphemeralSession])
    })

    it("should delete the account's other ephemeral sessions", async () => {
      const result = await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        currentSessionUuid: '00000000-0000-0000-0000-000000000001',
        markAsRevoked: true,
      })
      expect(result.isFailed()).toBeFalsy()

      // Precondition: the store really was consulted for this user.
      expect(ephemeralSessionRepository.findAllByUserUuid).toHaveBeenCalledWith('00000000-0000-0000-0000-000000000000')

      expect(ephemeralSessionRepository.deleteOne).toHaveBeenCalledTimes(1)
      expect(ephemeralSessionRepository.deleteOne).toHaveBeenCalledWith(
        otherEphemeralSession.uuid,
        '00000000-0000-0000-0000-000000000000',
      )
    })

    it('should never delete the current session even when it is ephemeral', async () => {
      await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        currentSessionUuid: '00000000-0000-0000-0000-000000000001',
        markAsRevoked: true,
      })

      expect(ephemeralSessionRepository.deleteOne).not.toHaveBeenCalledWith(
        currentEphemeralSession.uuid,
        expect.anything(),
      )
      expect(sessionService.createRevokedSession).not.toHaveBeenCalledWith(currentEphemeralSession)
    })

    it('should mark a terminated ephemeral session as revoked when asked', async () => {
      await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        currentSessionUuid: '00000000-0000-0000-0000-000000000001',
        markAsRevoked: true,
      })

      expect(sessionService.createRevokedSession).toHaveBeenCalledWith(otherEphemeralSession)
    })

    it('should not mark a terminated ephemeral session as revoked when not asked', async () => {
      await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        currentSessionUuid: '00000000-0000-0000-0000-000000000001',
        markAsRevoked: false,
      })

      // Control: the deletion still happened, so this is not vacuously true.
      expect(ephemeralSessionRepository.deleteOne).toHaveBeenCalledTimes(1)
      expect(sessionService.createRevokedSession).not.toHaveBeenCalled()
    })

    it('should audit + dispatch session.revoked for a terminated ephemeral session', async () => {
      await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        currentSessionUuid: '00000000-0000-0000-0000-000000000001',
        markAsRevoked: true,
      })

      expect(auditLogWriter.write).toHaveBeenCalledWith({
        actorUuid: '00000000-0000-0000-0000-000000000000',
        action: AuditAction.SessionRevoked,
        targetType: 'session',
        targetUuid: otherEphemeralSession.uuid,
        metadata: { scope: 'other-sessions' },
      })
      expect(webhookDispatcher.dispatch).toHaveBeenCalledWith(WebhookEvent.SessionRevoked, {
        userUuid: '00000000-0000-0000-0000-000000000000',
        metadata: expect.objectContaining({ sessionUuid: otherEphemeralSession.uuid, scope: 'other-sessions' }),
      })
    })

    it('should sweep the persistent sessions before the cache-backed ephemeral store', async () => {
      const callOrder: string[] = []
      sessionRepository.deleteAllByUserUuidExceptOne = jest.fn().mockImplementation(async () => {
        callOrder.push('persistent')
      })
      ephemeralSessionRepository.findAllByUserUuid = jest.fn().mockImplementation(async () => {
        callOrder.push('ephemeral')

        return [otherEphemeralSession]
      })

      await createUseCase().execute({
        userUuid: '00000000-0000-0000-0000-000000000000',
        currentSessionUuid: '00000000-0000-0000-0000-000000000001',
        markAsRevoked: true,
      })

      expect(callOrder).toEqual(['persistent', 'ephemeral'])
    })

    it('should surface an ephemeral-store failure rather than report a sweep that did not happen', async () => {
      ephemeralSessionRepository.findAllByUserUuid = jest.fn().mockRejectedValue(new Error('cache down'))

      await expect(
        createUseCase().execute({
          userUuid: '00000000-0000-0000-0000-000000000000',
          currentSessionUuid: '00000000-0000-0000-0000-000000000001',
          markAsRevoked: true,
        }),
      ).rejects.toThrow('cache down')

      // The durable sweep still happened: the failure is loud, not a rollback.
      expect(sessionRepository.deleteAllByUserUuidExceptOne).toHaveBeenCalled()
    })
  })
})
