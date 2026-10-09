import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../../Domain/Event/DomainEventFactoryInterface'
import { User } from '../../Domain/User/User'
import { Role } from '../../Domain/Role/Role'
import { DomainEventTransportUnavailableError } from '../../Bootstrap/UndeliverableDomainEventPublisher'
import { WebSocketsClientService } from './WebSocketsClientService'

describe('WebSocketsClientService', () => {
  let domainEventFactory: DomainEventFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let logger: Logger
  let user: User

  const createService = () => new WebSocketsClientService(domainEventFactory, domainEventPublisher, logger)

  beforeEach(() => {
    user = {
      uuid: '1-2-3',
      email: 'operator@example.com',
      roles: Promise.resolve([{ name: 'ADMIN_USER' } as Role]),
    } as unknown as User

    domainEventFactory = {
      createUserRolesChangedEvent: jest.fn().mockReturnValue({ type: 'USER_ROLES_CHANGED' }),
      createWebSocketMessageRequestedEvent: jest.fn().mockReturnValue({ type: 'WEB_SOCKET_MESSAGE_REQUESTED' }),
    } as unknown as DomainEventFactoryInterface

    domainEventPublisher = { publish: jest.fn() } as unknown as DomainEventPublisherInterface

    logger = { debug: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger
  })

  it('publishes a websocket message request carrying the changed roles', async () => {
    await createService().sendUserRolesChangedEvent(user)

    expect(domainEventFactory.createUserRolesChangedEvent).toHaveBeenCalledWith('1-2-3', 'operator@example.com', [
      'ADMIN_USER',
    ])
    expect(domainEventPublisher.publish).toHaveBeenCalledWith({ type: 'WEB_SOCKET_MESSAGE_REQUESTED' })
    expect(logger.warn).not.toHaveBeenCalled()
  })

  /**
   * The grant is already committed by the time this nudge is requested, so a
   * deployment that simply has no transport reachable from this process must not
   * turn `srn-admin roles grant` into a failure.
   */
  it('tolerates a transport that this deployment cannot reach, and says so', async () => {
    domainEventPublisher.publish = jest
      .fn()
      .mockRejectedValue(new DomainEventTransportUnavailableError('WEB_SOCKET_MESSAGE_REQUESTED'))

    await expect(createService().sendUserRolesChangedEvent(user)).resolves.toBeUndefined()

    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect((logger.warn as jest.Mock).mock.calls[0][0]).toContain('no domain-event transport')
  })

  /** A configured broker that rejects is a real failure and must surface. */
  it('rethrows any other publish failure', async () => {
    domainEventPublisher.publish = jest.fn().mockRejectedValue(new Error('Region is missing'))

    await expect(createService().sendUserRolesChangedEvent(user)).rejects.toThrow('Region is missing')
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
