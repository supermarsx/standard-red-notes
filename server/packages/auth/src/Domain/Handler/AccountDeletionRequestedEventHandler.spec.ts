import { AccountDeletionRequestedEvent } from '@standardnotes/domain-events'
import { Uuid } from '@standardnotes/domain-core'
import { Logger } from 'winston'

import { EphemeralSessionRepositoryInterface } from '../Session/EphemeralSessionRepositoryInterface'
import { RevokedSessionRepositoryInterface } from '../Session/RevokedSessionRepositoryInterface'
import { SessionRepositoryInterface } from '../Session/SessionRepositoryInterface'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'

import { AccountDeletionRequestedEventHandler } from './AccountDeletionRequestedEventHandler'

describe('AccountDeletionRequestedEventHandler', () => {
  let userRepository: UserRepositoryInterface
  let sessionRepository: SessionRepositoryInterface
  let ephemeralSessionRepository: EphemeralSessionRepositoryInterface
  let revokedSessionRepository: RevokedSessionRepositoryInterface
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const user = { uuid: userUuid } as jest.Mocked<User>

  const session = { uuid: 'session-1' }
  const ephemeralSession = { uuid: 'ephemeral-1', userUuid }
  const revokedSession = { uuid: 'revoked-1' }

  const eventWith = (uuid: string) =>
    ({ payload: { userUuid: uuid } }) as unknown as jest.Mocked<AccountDeletionRequestedEvent>

  const createHandler = () =>
    new AccountDeletionRequestedEventHandler(
      userRepository,
      sessionRepository,
      ephemeralSessionRepository,
      revokedSessionRepository,
      logger,
    )

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(user)
    userRepository.remove = jest.fn().mockResolvedValue(undefined)

    sessionRepository = {} as jest.Mocked<SessionRepositoryInterface>
    sessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([session])
    sessionRepository.remove = jest.fn().mockResolvedValue(undefined)

    ephemeralSessionRepository = {} as jest.Mocked<EphemeralSessionRepositoryInterface>
    ephemeralSessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([ephemeralSession])
    ephemeralSessionRepository.deleteOne = jest.fn().mockResolvedValue(undefined)

    revokedSessionRepository = {} as jest.Mocked<RevokedSessionRepositoryInterface>
    revokedSessionRepository.findAllByUserUuid = jest.fn().mockResolvedValue([revokedSession])
    revokedSessionRepository.remove = jest.fn().mockResolvedValue(undefined)

    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
    logger.warn = jest.fn()
  })

  it('should do nothing if the user uuid in the event is malformed', async () => {
    await createHandler().handle(eventWith('not-a-uuid'))

    expect(userRepository.findOneByUuid).not.toHaveBeenCalled()
    expect(userRepository.remove).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('Could not find user.', { userId: 'not-a-uuid' })
  })

  it('should not remove any session if the user no longer exists', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(userUuid))

    expect(sessionRepository.findAllByUserUuid).not.toHaveBeenCalled()
    expect(userRepository.remove).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith('Could not find user.', { userId: userUuid })
  })

  it('should purge every session type before removing the user', async () => {
    await createHandler().handle(eventWith(userUuid))

    const lookedUp = (userRepository.findOneByUuid as jest.Mock).mock.calls[0][0] as Uuid
    expect(lookedUp.value).toEqual(userUuid)

    expect(sessionRepository.findAllByUserUuid).toHaveBeenCalledWith(userUuid)
    expect(sessionRepository.remove).toHaveBeenCalledWith(session)
    expect(ephemeralSessionRepository.deleteOne).toHaveBeenCalledWith(ephemeralSession.uuid, ephemeralSession.userUuid)
    expect(revokedSessionRepository.remove).toHaveBeenCalledWith(revokedSession)

    expect(userRepository.remove).toHaveBeenCalledWith(user)
    expect(logger.info).toHaveBeenCalledWith('Finished account cleanup.', { userId: userUuid })
  })
})
