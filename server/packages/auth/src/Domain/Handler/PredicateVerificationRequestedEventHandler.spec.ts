import { DomainEventPublisherInterface, PredicateVerificationRequestedEvent } from '@standardnotes/domain-events'
import { PredicateVerificationResult } from '@standardnotes/predicates'
import { Logger } from 'winston'

import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { User } from '../User/User'
import { UserRepositoryInterface } from '../User/UserRepositoryInterface'
import { VerifyPredicate } from '../UseCase/VerifyPredicate/VerifyPredicate'

import { PredicateVerificationRequestedEventHandler } from './PredicateVerificationRequestedEventHandler'

describe('PredicateVerificationRequestedEventHandler', () => {
  let verifyPredicate: VerifyPredicate
  let userRepository: UserRepositoryInterface
  let domainEventFactory: DomainEventFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let logger: Logger

  const userUuid = '00000000-0000-0000-0000-000000000000'
  const userEmail = 'user@example.com'
  const predicate = { name: 'subscription-active' }
  const predicateVerifiedEvent = { type: 'PREDICATE_VERIFIED' }

  const eventWith = (userIdentifier: string, userIdentifierType: string) =>
    ({
      payload: { predicate },
      meta: { correlation: { userIdentifier, userIdentifierType } },
    }) as unknown as jest.Mocked<PredicateVerificationRequestedEvent>

  const createHandler = () =>
    new PredicateVerificationRequestedEventHandler(
      verifyPredicate,
      userRepository,
      domainEventFactory,
      domainEventPublisher,
      logger,
    )

  beforeEach(() => {
    verifyPredicate = {} as jest.Mocked<VerifyPredicate>
    verifyPredicate.execute = jest
      .fn()
      .mockResolvedValue({ predicateVerificationResult: PredicateVerificationResult.Affirmed })

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue({ uuid: userUuid } as jest.Mocked<User>)

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createPredicateVerifiedEvent = jest.fn().mockReturnValue(predicateVerifiedEvent)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn().mockResolvedValue(undefined)

    logger = {} as jest.Mocked<Logger>
    logger.debug = jest.fn()
  })

  it('should verify against the correlated uuid directly when the identifier is not an email', async () => {
    await createHandler().handle(eventWith(userUuid, 'uuid'))

    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
    expect(verifyPredicate.execute).toHaveBeenCalledWith({ predicate, userUuid })
    expect(domainEventFactory.createPredicateVerifiedEvent).toHaveBeenCalledWith({
      predicate,
      predicateVerificationResult: PredicateVerificationResult.Affirmed,
      userUuid,
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledWith(predicateVerifiedEvent)
  })

  it("should resolve an email identifier to the account's uuid before verifying", async () => {
    await createHandler().handle(eventWith(userEmail, 'email'))

    expect(userRepository.findOneByUsernameOrEmail).toHaveBeenCalledTimes(1)
    expect(verifyPredicate.execute).toHaveBeenCalledWith({ predicate, userUuid })
  })

  it('should publish an undetermined result without verifying if the email has no account', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

    await createHandler().handle(eventWith(userEmail, 'email'))

    expect(verifyPredicate.execute).not.toHaveBeenCalled()
    expect(domainEventFactory.createPredicateVerifiedEvent).toHaveBeenCalledWith({
      predicate,
      predicateVerificationResult: PredicateVerificationResult.CouldNotBeDetermined,
      userUuid: userEmail,
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledWith(predicateVerifiedEvent)
  })

  it('should publish nothing if the email identifier is not a valid username', async () => {
    await createHandler().handle(eventWith('', 'email'))

    expect(userRepository.findOneByUsernameOrEmail).not.toHaveBeenCalled()
    expect(verifyPredicate.execute).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })
})
