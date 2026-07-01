import 'reflect-metadata'

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
  let sessionService: SessionServiceInterface
  let auditLogWriter: AuditLogWriterInterface
  let webhookDispatcher: WebhookDispatcherInterface
  let session: Session
  let currentSession: Session

  const createUseCase = () =>
    new DeleteOtherSessionsForUser(sessionRepository, sessionService, auditLogWriter, webhookDispatcher)

  beforeEach(() => {
    session = {} as jest.Mocked<Session>
    session.uuid = '00000000-0000-0000-0000-000000000000'

    currentSession = {} as jest.Mocked<Session>
    currentSession.uuid = '00000000-0000-0000-0000-000000000001'

    sessionRepository = {} as jest.Mocked<SessionRepositoryInterface>
    sessionRepository.deleteAllByUserUuidExceptOne = jest.fn()
    sessionRepository.findAllByUserUuid = jest.fn().mockReturnValue([session, currentSession])

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
})
