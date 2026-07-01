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

import { DeleteSessionForUser } from './DeleteSessionForUser'

describe('DeleteSessionForUser', () => {
  let sessionRepository: SessionRepositoryInterface
  let ephemeralSessionRepository: EphemeralSessionRepositoryInterface
  let sessionService: SessionServiceInterface
  let auditLogWriter: AuditLogWriterInterface
  let webhookDispatcher: WebhookDispatcherInterface
  let session: Session
  let ephemeralSession: EphemeralSession

  const createUseCase = () =>
    new DeleteSessionForUser(
      sessionRepository,
      ephemeralSessionRepository,
      sessionService,
      auditLogWriter,
      webhookDispatcher,
    )

  beforeEach(() => {
    session = {} as jest.Mocked<Session>
    session.uuid = '2-3-4'
    session.userUuid = '1-2-3'

    ephemeralSession = {} as jest.Mocked<EphemeralSession>
    ephemeralSession.uuid = '2-3-4'
    ephemeralSession.userUuid = '1-2-3'

    sessionRepository = {} as jest.Mocked<SessionRepositoryInterface>
    sessionRepository.deleteOneByUuid = jest.fn()
    sessionRepository.findOneByUuidAndUserUuid = jest.fn().mockReturnValue(session)

    ephemeralSessionRepository = {} as jest.Mocked<EphemeralSessionRepositoryInterface>
    ephemeralSessionRepository.deleteOne = jest.fn()
    ephemeralSessionRepository.findOneByUuidAndUserUuid = jest.fn().mockReturnValue(session)

    sessionService = {} as jest.Mocked<SessionServiceInterface>
    sessionService.createRevokedSession = jest.fn()

    auditLogWriter = {} as jest.Mocked<AuditLogWriterInterface>
    auditLogWriter.write = jest.fn()

    webhookDispatcher = {} as jest.Mocked<WebhookDispatcherInterface>
    webhookDispatcher.dispatch = jest.fn()
  })

  it('should delete a session for a given user', async () => {
    expect(await createUseCase().execute({ userUuid: '1-2-3', sessionUuid: '2-3-4' })).toEqual({ success: true })

    expect(sessionRepository.deleteOneByUuid).toHaveBeenCalledWith('2-3-4')
    expect(ephemeralSessionRepository.deleteOne).toHaveBeenCalledWith('2-3-4', '1-2-3')
    expect(sessionService.createRevokedSession).toHaveBeenCalledWith(session)
  })

  it('should write an audit entry and dispatch the session.revoked webhook', async () => {
    await createUseCase().execute({ userUuid: '1-2-3', sessionUuid: '2-3-4' })

    expect(auditLogWriter.write).toHaveBeenCalledWith({
      actorUuid: '1-2-3',
      action: AuditAction.SessionRevoked,
      targetType: 'session',
      targetUuid: '2-3-4',
    })

    expect(webhookDispatcher.dispatch).toHaveBeenCalledWith(WebhookEvent.SessionRevoked, {
      userUuid: '1-2-3',
      metadata: expect.objectContaining({ sessionUuid: '2-3-4' }),
    })
  })

  it('should not fail revocation when the webhook dispatch throws', async () => {
    webhookDispatcher.dispatch = jest.fn().mockRejectedValue(new Error('network down'))

    expect(await createUseCase().execute({ userUuid: '1-2-3', sessionUuid: '2-3-4' })).toEqual({ success: true })
  })

  it('should work without the optional audit/webhook hooks', async () => {
    auditLogWriter = undefined as unknown as AuditLogWriterInterface
    webhookDispatcher = undefined as unknown as WebhookDispatcherInterface

    expect(await createUseCase().execute({ userUuid: '1-2-3', sessionUuid: '2-3-4' })).toEqual({ success: true })
  })

  it('should delete an ephemeral session for a given user', async () => {
    sessionRepository.findOneByUuidAndUserUuid = jest.fn().mockReturnValue(null)

    expect(await createUseCase().execute({ userUuid: '1-2-3', sessionUuid: '2-3-4' })).toEqual({ success: true })

    expect(sessionRepository.deleteOneByUuid).toHaveBeenCalledWith('2-3-4')
    expect(ephemeralSessionRepository.deleteOne).toHaveBeenCalledWith('2-3-4', '1-2-3')
    expect(sessionService.createRevokedSession).toHaveBeenCalledWith(session)
  })

  it('should not delete a session if it does not exist for a given user', async () => {
    sessionRepository.findOneByUuidAndUserUuid = jest.fn().mockReturnValue(null)
    ephemeralSessionRepository.findOneByUuidAndUserUuid = jest.fn().mockReturnValue(null)

    expect(await createUseCase().execute({ userUuid: '1-2-3', sessionUuid: '2-3-4' })).toEqual({
      success: false,
      errorMessage: 'No session exists with the provided identifier.',
    })

    expect(sessionRepository.deleteOneByUuid).not.toHaveBeenCalled()
    expect(ephemeralSessionRepository.deleteOne).not.toHaveBeenCalled()
    expect(sessionService.createRevokedSession).not.toHaveBeenCalled()
  })
})
