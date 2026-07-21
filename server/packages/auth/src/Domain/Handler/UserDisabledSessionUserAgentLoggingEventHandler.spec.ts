import { UserDisabledSessionUserAgentLoggingEvent } from '@standardnotes/domain-events'

import { RevokedSessionRepositoryInterface } from '../Session/RevokedSessionRepositoryInterface'
import { SessionRepositoryInterface } from '../Session/SessionRepositoryInterface'

import { UserDisabledSessionUserAgentLoggingEventHandler } from './UserDisabledSessionUserAgentLoggingEventHandler'

describe('UserDisabledSessionUserAgentLoggingEventHandler', () => {
  let sessionRepository: SessionRepositoryInterface
  let revokedSessionRepository: RevokedSessionRepositoryInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'

  const event = { payload: { userUuid } } as jest.Mocked<UserDisabledSessionUserAgentLoggingEvent>

  const createHandler = () =>
    new UserDisabledSessionUserAgentLoggingEventHandler(sessionRepository, revokedSessionRepository)

  beforeEach(() => {
    sessionRepository = {} as jest.Mocked<SessionRepositoryInterface>
    sessionRepository.clearUserAgentByUserUuid = jest.fn().mockResolvedValue(undefined)

    revokedSessionRepository = {} as jest.Mocked<RevokedSessionRepositoryInterface>
    revokedSessionRepository.clearUserAgentByUserUuid = jest.fn().mockResolvedValue(undefined)
  })

  it('should clear the stored user agent from both live and revoked sessions', async () => {
    await createHandler().handle(event)

    expect(sessionRepository.clearUserAgentByUserUuid).toHaveBeenCalledWith(userUuid)
    expect(revokedSessionRepository.clearUserAgentByUserUuid).toHaveBeenCalledWith(userUuid)
  })
})
