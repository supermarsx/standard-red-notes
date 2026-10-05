import { DomainEventPublisherInterface, FileQuotaRecalculationRequestedEvent } from '@standardnotes/domain-events'
import { Logger } from 'winston'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { GetSharedSubscriptionForUser } from '../GetSharedSubscriptionForUser/GetSharedSubscriptionForUser'
import { ListSharedSubscriptionInvitations } from '../ListSharedSubscriptionInvitations/ListSharedSubscriptionInvitations'
import { FixStorageQuotaForUser } from './FixStorageQuotaForUser'
import { User } from '../../User/User'
import { Result } from '@standardnotes/domain-core'
import { UserSubscription } from '../../Subscription/UserSubscription'
import { InvitationStatus } from '../../SharedSubscription/InvitationStatus'
import { SharedSubscriptionInvitation } from '../../SharedSubscription/SharedSubscriptionInvitation'

describe('FixStorageQuotaForUser', () => {
  let userRepository: UserRepositoryInterface
  let getSharedSubscriptionForUser: GetSharedSubscriptionForUser
  let listSharedSubscriptionInvitations: ListSharedSubscriptionInvitations
  let domainEventFactory: DomainEventFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let logger: Logger

  const createUseCase = () =>
    new FixStorageQuotaForUser(
      userRepository,
      getSharedSubscriptionForUser,
      listSharedSubscriptionInvitations,
      domainEventFactory,
      domainEventPublisher,
      logger,
    )

  beforeEach(() => {
    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue({
      uuid: '00000000-0000-0000-0000-000000000000',
    } as jest.Mocked<User>)

    getSharedSubscriptionForUser = {} as jest.Mocked<GetSharedSubscriptionForUser>
    getSharedSubscriptionForUser.execute = jest.fn().mockReturnValue(
      Result.ok({
        uuid: '00000000-0000-0000-0000-000000000000',
      } as jest.Mocked<UserSubscription>),
    )

    listSharedSubscriptionInvitations = {} as jest.Mocked<ListSharedSubscriptionInvitations>
    listSharedSubscriptionInvitations.execute = jest.fn().mockReturnValue({
      invitations: [
        {
          uuid: '00000000-0000-0000-0000-000000000000',
          status: InvitationStatus.Accepted,
          inviteeIdentifier: 'test2@test.te',
        } as jest.Mocked<SharedSubscriptionInvitation>,
      ],
    })

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createFileQuotaRecalculationRequestedEvent = jest
      .fn()
      .mockReturnValue({} as jest.Mocked<FileQuotaRecalculationRequestedEvent>)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    logger = {} as jest.Mocked<Logger>
    logger.info = jest.fn()
  })

  it('should return error result if user cannot be found', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue(null)

    const useCase = createUseCase()

    const result = await useCase.execute({
      userEmail: 'test@test.te',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  /**
   * *** THE HEAL PATH REFUSED TO RUN EXACTLY WHERE IT WAS NEEDED. ***
   *
   * This test asserted that "fix quota" fails for an account with no
   * `user_subscriptions` row. On the default `included` entitlement mode that is
   * EVERY account, so the one command that re-derives a usage total from the files
   * actually on disk was unreachable on every default deployment — and a total
   * that cannot be re-derived is a total that drifts permanently once anything
   * misses an event.
   *
   * There is no subscription lookup left to refuse: the request is addressed to
   * the USER, the files service sums that owner's bytes on disk, and the
   * recalculated figure is written as the whole total under whatever scope the
   * write path resolves.
   */
  it('requests the recalculation for an account with no subscription row', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockReturnValue({
      uuid: '11111111-1111-4111-8111-111111111111',
      email: 'test@test.te',
    } as jest.Mocked<User>)
    listSharedSubscriptionInvitations.execute = jest.fn().mockReturnValue({ invitations: [] })

    const useCase = createUseCase()

    const result = await useCase.execute({
      userEmail: 'test@test.te',
    })

    expect(result.isFailed()).toBeFalsy()
    expect(domainEventFactory.createFileQuotaRecalculationRequestedEvent).toHaveBeenCalledWith({
      userUuid: '11111111-1111-4111-8111-111111111111',
    })
    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(1)
  })

  /**
   * *** NO PROVISIONAL ZERO, AND THIS IS THE TEST THAT HOLDS THAT LINE. ***
   *
   * The command used to write `FILE_UPLOAD_BYTES_USED = 0` before publishing,
   * because the recalculated total was ADDED. When the publish failed — which it
   * always does from the `srn-admin` CLI on a single container, a boot with no
   * event transport — the zero was the whole result: an account holding megabytes
   * reporting a confident 0. A fabricated zero reads as a measurement, so it is
   * worse than the absent figure it replaced, and the only safe outcome for a
   * correction that did not run is the previous figure, untouched.
   */
  it('writes nothing at all when the recalculation cannot be published', async () => {
    listSharedSubscriptionInvitations.execute = jest.fn().mockReturnValue({ invitations: [] })
    domainEventPublisher.publish = jest.fn().mockRejectedValue(new Error('Region is missing'))

    const useCase = createUseCase()

    await expect(useCase.execute({ userEmail: 'test@test.te' })).rejects.toThrow('Region is missing')
    // Nothing in this use case can write a setting any more — the dependency is
    // gone — and the assertion is on the PUBLISH having been the only side effect
    // attempted, so a reinstated zero would need a new dependency and would fail
    // the construction above rather than slipping past this test.
    expect(logger.info).not.toHaveBeenCalledWith('Requested storage quota recalculation for user', expect.anything())
  })

  it('should return error result if the invitee has no shared subscription', async () => {
    getSharedSubscriptionForUser.execute = jest.fn().mockReturnValue(Result.fail('test'))

    const useCase = createUseCase()

    const result = await useCase.execute({
      userEmail: 'test@test.te',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  it('should ask for recalculation for the user and all its shared subscriptions', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userEmail: 'test@test.te',
    })

    expect(result.isFailed()).toBeFalsy()
    expect(domainEventPublisher.publish).toHaveBeenCalledTimes(2)
  })

  it('should return error if the username is invalid', async () => {
    const useCase = createUseCase()

    const result = await useCase.execute({
      userEmail: '',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  it('should return error if the invitee username is invalid', async () => {
    listSharedSubscriptionInvitations.execute = jest.fn().mockReturnValue({
      invitations: [
        {
          uuid: '00000000-0000-0000-0000-000000000000',
          status: InvitationStatus.Accepted,
          inviteeIdentifier: '',
        } as jest.Mocked<SharedSubscriptionInvitation>,
      ],
    })

    const useCase = createUseCase()

    const result = await useCase.execute({
      userEmail: 'test@test.te',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  it('should return error if the invitee cannot be found', async () => {
    userRepository.findOneByUsernameOrEmail = jest
      .fn()
      .mockReturnValueOnce({
        uuid: '00000000-0000-0000-0000-000000000000',
      } as jest.Mocked<User>)
      .mockReturnValueOnce(null)

    const useCase = createUseCase()

    const result = await useCase.execute({
      userEmail: 'test@test.te',
    })

    expect(result.isFailed()).toBeTruthy()
  })

  it('should return error if the invitee is no longer a shared subscriber', async () => {
    getSharedSubscriptionForUser.execute = jest.fn().mockReturnValueOnce(Result.fail('test'))

    const useCase = createUseCase()

    const result = await useCase.execute({
      userEmail: 'test@test.te',
    })

    expect(result.isFailed()).toBeTruthy()
  })
})
