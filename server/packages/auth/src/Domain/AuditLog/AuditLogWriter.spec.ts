import { Logger } from 'winston'

import { AuditLogEntry } from './AuditLogEntry'
import { AuditLogRepositoryInterface } from './AuditLogRepositoryInterface'
import { AuditLogWriter } from './AuditLogWriter'

describe('AuditLogWriter', () => {
  let auditLogRepository: AuditLogRepositoryInterface
  let logger: Logger

  const actorUuid = '00000000-0000-0000-0000-000000000000'

  const createWriter = () => new AuditLogWriter(auditLogRepository, logger)

  beforeEach(() => {
    auditLogRepository = {} as jest.Mocked<AuditLogRepositoryInterface>
    auditLogRepository.save = jest.fn().mockResolvedValue(undefined)

    logger = {} as jest.Mocked<Logger>
    logger.warn = jest.fn()
    logger.error = jest.fn()
  })

  it('should persist an entry defaulting the optional fields to null', async () => {
    await createWriter().write({ actorUuid, action: 'user.login' })

    expect(auditLogRepository.save).toHaveBeenCalledTimes(1)
    const saved = (auditLogRepository.save as jest.Mock).mock.calls[0][0] as AuditLogEntry
    expect(saved.props.action).toEqual('user.login')
    expect(saved.props.targetType).toBeNull()
    expect(saved.props.targetUuid).toBeNull()
    expect(saved.props.ip).toBeNull()
    expect(saved.props.metadata).toBeNull()
    expect(saved.props.createdAt).toBeInstanceOf(Date)
  })

  it('should persist the supplied optional fields untouched', async () => {
    await createWriter().write({
      actorUuid,
      action: 'session.revoke',
      targetType: 'session',
      targetUuid: 'session-1',
      ip: '10.0.0.1',
      metadata: { reason: 'admin' },
    })

    const saved = (auditLogRepository.save as jest.Mock).mock.calls[0][0] as AuditLogEntry
    expect(saved.props.targetType).toEqual('session')
    expect(saved.props.targetUuid).toEqual('session-1')
    expect(saved.props.ip).toEqual('10.0.0.1')
    expect(saved.props.metadata).toEqual({ reason: 'admin' })
  })

  it('should skip persisting and warn when the entry is invalid', async () => {
    await createWriter().write({ actorUuid, action: '' })

    expect(auditLogRepository.save).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('Could not build an audit-log entry.', {
      action: '',
    })
  })

  it('should swallow a repository failure so the audited action is never broken', async () => {
    auditLogRepository.save = jest.fn().mockRejectedValue(new Error('db down'))

    await expect(createWriter().write({ actorUuid, action: 'user.login' })).resolves.toBeUndefined()

    expect(logger.error).toHaveBeenCalledWith('Could not write audit log entry.', {
      action: 'user.login',
      errorType: 'Error',
      errorCode: undefined,
      status: undefined,
    })
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('db down')
  })
})
