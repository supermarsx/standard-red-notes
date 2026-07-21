import { DomainEventPublisherInterface, UserInvitedToSharedVaultEvent } from '@standardnotes/domain-events'
import { EmailLevel, Uuid } from '@standardnotes/domain-core'

import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { getBody, getSubject } from '../Email/UserInvitedToSharedVault'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'

import { UserInvitedToSharedVaultEventHandler } from './UserInvitedToSharedVaultEventHandler'

describe('UserInvitedToSharedVaultEventHandler', () => {
  let userRepository: UserRepositoryInterface
  let domainEventFactory: DomainEventFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const user = { uuid: userUuid, email: 'invitee@example.com' } as jest.Mocked<User>
  const emailRequestedEvent = { type: 'EMAIL_REQUESTED' }

  const eventWith = (inviteeUuid: string) =>
    ({ payload: { invite: { user_uuid: inviteeUuid } } }) as unknown as jest.Mocked<UserInvitedToSharedVaultEvent>

  const createHandler = () =>
    new UserInvitedToSharedVaultEventHandler(userRepository, domainEventFactory, domainEventPublisher)

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(user)

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createEmailRequestedEvent = jest.fn().mockReturnValue(emailRequestedEvent)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn().mockResolvedValue(undefined)
  })

  it('should not publish anything if the invitee uuid is not a uuid', async () => {
    await createHandler().handle(eventWith('not-a-uuid'))

    expect(userRepository.findOneByUuid).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('should not publish anything if the invitee has no account', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(userUuid))

    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('should request a system-level invitation email for the invitee', async () => {
    await createHandler().handle(eventWith(userUuid))

    const lookedUp = (userRepository.findOneByUuid as jest.Mock).mock.calls[0][0] as Uuid
    expect(lookedUp.value).toEqual(userUuid)

    expect(domainEventFactory.createEmailRequestedEvent).toHaveBeenCalledWith({
      body: getBody(),
      level: EmailLevel.LEVELS.System,
      subject: getSubject(),
      messageIdentifier: 'USER_INVITED_TO_SHARED_VAULT',
      userEmail: user.email,
      userUuid: user.uuid,
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledWith(emailRequestedEvent)
  })
})
