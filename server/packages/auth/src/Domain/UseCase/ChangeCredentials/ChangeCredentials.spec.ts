import 'reflect-metadata'

import { DomainEventPublisherInterface, UserEmailChangedEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'

import { AuthResponseFactoryInterface } from '../../Auth/AuthResponseFactoryInterface'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'

import { AuthResponseFactoryResolverInterface } from '../../Auth/AuthResponseFactoryResolverInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'

import { ChangeCredentials } from './ChangeCredentials'
import { Result, Username } from '@standardnotes/domain-core'
import { DeleteOtherSessionsForUser } from '../DeleteOtherSessionsForUser'
import { ApiVersion } from '../../Api/ApiVersion'
import { Session } from '../../Session/Session'
import { Logger } from 'winston'

describe('ChangeCredentials', () => {
  let userRepository: UserRepositoryInterface
  let authResponseFactoryResolver: AuthResponseFactoryResolverInterface
  let authResponseFactory: AuthResponseFactoryInterface
  let domainEventPublisher: DomainEventPublisherInterface
  let domainEventFactory: DomainEventFactoryInterface
  let timer: TimerInterface
  let user: User
  let deleteOtherSessionsForUser: DeleteOtherSessionsForUser
  let logger: Logger
  const initialEncryptedPassword = '$2a$11$K3g6XoTau8VmLJcai1bB0eD9/YvBSBRtBhMprJOaVZ0U3SgasZH3a'
  const userUuid = '123e4567-e89b-42d3-a456-426614174000'

  const createUseCase = () =>
    new ChangeCredentials(
      userRepository,
      authResponseFactoryResolver,
      domainEventPublisher,
      domainEventFactory,
      timer,
      deleteOtherSessionsForUser,
      logger,
    )

  beforeEach(() => {
    logger = {} as jest.Mocked<Logger>
    logger.error = jest.fn()

    authResponseFactory = {} as jest.Mocked<AuthResponseFactoryInterface>
    authResponseFactory.createResponse = jest
      .fn()
      .mockReturnValue({ response: { foo: 'bar' }, session: { uuid: '1-2-3' } as jest.Mocked<Session> })

    authResponseFactoryResolver = {} as jest.Mocked<AuthResponseFactoryResolverInterface>
    authResponseFactoryResolver.resolveAuthResponseFactoryVersion = jest.fn().mockReturnValue(authResponseFactory)

    user = {} as jest.Mocked<User>
    user.encryptedPassword = initialEncryptedPassword
    user.version = '003'
    user.uuid = userUuid
    user.email = 'test@test.te'

    userRepository = {} as jest.Mocked<UserRepositoryInterface>
    userRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery = jest
      .fn()
      .mockImplementation(({ user }: { user: User }) => Promise.resolve(user))
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(user)
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue(null)

    domainEventPublisher = {} as jest.Mocked<DomainEventPublisherInterface>
    domainEventPublisher.publish = jest.fn()

    domainEventFactory = {} as jest.Mocked<DomainEventFactoryInterface>
    domainEventFactory.createUserEmailChangedEvent = jest.fn().mockReturnValue({} as jest.Mocked<UserEmailChangedEvent>)

    timer = {} as jest.Mocked<TimerInterface>
    timer.getUTCDate = jest.fn().mockReturnValue(new Date(1))

    deleteOtherSessionsForUser = {} as jest.Mocked<DeleteOtherSessionsForUser>
    deleteOtherSessionsForUser.execute = jest.fn().mockReturnValue(Result.ok())
  })

  const expectAtomicTransition = (expectedUser: Record<string, unknown>) => {
    if (expectedUser.version === undefined) {
      expectedUser.version = '003'
    }
    expect(userRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery).toHaveBeenCalledWith({
      user: expectedUser,
      expectedEncryptedPassword: initialEncryptedPassword,
      expectedProtocolVersion: '003',
    })
  }

  it('should change password', async () => {
    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
      kpCreated: '123',
      kpOrigination: 'password-change',
    })

    expect(result.isFailed()).toBeFalsy()

    expectAtomicTransition({
      encryptedPassword: expect.any(String),
      pwNonce: 'asdzxc',
      kpCreated: '123',
      email: 'test@test.te',
      uuid: userUuid,
      kpOrigination: 'password-change',
      updatedAt: new Date(1),
    })
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(domainEventFactory.createUserEmailChangedEvent).not.toHaveBeenCalled()
    expect(deleteOtherSessionsForUser.execute).toHaveBeenCalled()
  })

  it('should not change password if api version is invalid', async () => {
    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: 'invalid',
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
      kpCreated: '123',
      kpOrigination: 'password-change',
    })

    expect(result.isFailed()).toBeTruthy()
    expect(userRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery).not.toHaveBeenCalled()
  })

  it('should change password on legacy users', async () => {
    authResponseFactory.createResponse = jest
      .fn()
      .mockReturnValue({ legacyResponse: { foo: 'bar' }, session: { uuid: '1-2-3' } as jest.Mocked<Session> })

    authResponseFactoryResolver.resolveAuthResponseFactoryVersion = jest.fn().mockReturnValue(authResponseFactory)

    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20161215,
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
      kpCreated: '123',
      kpOrigination: 'password-change',
    })

    expect(result.isFailed()).toBeFalsy()

    expectAtomicTransition({
      encryptedPassword: expect.any(String),
      pwNonce: 'asdzxc',
      kpCreated: '123',
      email: 'test@test.te',
      uuid: userUuid,
      kpOrigination: 'password-change',
      updatedAt: new Date(1),
    })
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(domainEventFactory.createUserEmailChangedEvent).not.toHaveBeenCalled()
    expect(deleteOtherSessionsForUser.execute).toHaveBeenCalled()
  })

  it('should change email', async () => {
    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      newEmail: 'new@test.te',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
      kpCreated: '123',
      kpOrigination: 'password-change',
    })
    expect(result.isFailed()).toBeFalsy()

    expectAtomicTransition({
      encryptedPassword: expect.any(String),
      email: 'new@test.te',
      uuid: userUuid,
      pwNonce: 'asdzxc',
      kpCreated: '123',
      kpOrigination: 'password-change',
      updatedAt: new Date(1),
    })
    expect(domainEventFactory.createUserEmailChangedEvent).toHaveBeenCalledWith(userUuid, 'test@test.te', 'new@test.te')
    expect(domainEventPublisher.publish).toHaveBeenCalled()
    expect(deleteOtherSessionsForUser.execute).toHaveBeenCalled()
  })

  it('should not change email if already taken', async () => {
    userRepository.findOneByUsernameOrEmail = jest.fn().mockResolvedValue({} as jest.Mocked<User>)

    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      newEmail: 'new@test.te',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
      kpCreated: '123',
      kpOrigination: 'password-change',
    })
    expect(result.isFailed()).toBeTruthy()
    expect(result.getError()).toEqual('The email you entered is already taken. Please try again.')

    expect(userRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery).not.toHaveBeenCalled()
    expect(domainEventFactory.createUserEmailChangedEvent).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('should not change email if the new email is invalid', async () => {
    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      newEmail: '',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
      kpCreated: '123',
      kpOrigination: 'password-change',
    })
    expect(result.isFailed()).toBeTruthy()
    expect(result.getError()).toEqual('Username cannot be empty')

    expect(userRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery).not.toHaveBeenCalled()
    expect(domainEventFactory.createUserEmailChangedEvent).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('should not change email if the user is not found', async () => {
    userRepository.findOneByUuid = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      newEmail: '',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
      kpCreated: '123',
      kpOrigination: 'password-change',
    })

    expect(result.isFailed()).toBeTruthy()
    expect(result.getError()).toEqual('User not found.')

    expect(userRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery).not.toHaveBeenCalled()
    expect(domainEventFactory.createUserEmailChangedEvent).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
  })

  it('should not change password if current password is incorrect', async () => {
    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'test123',
      newPassword: 'test234',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
    })
    expect(result.isFailed()).toBeTruthy()
    expect(result.getError()).toEqual('The current password you entered is incorrect. Please try again.')

    expect(userRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery).not.toHaveBeenCalled()
  })

  it('aborts before mutating or saving credentials when recovery escrow deletion fails', async () => {
    userRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery = jest
      .fn()
      .mockRejectedValue(new Error('database unavailable'))

    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
      protocolVersion: '004',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toMatch(/invalidate account recovery/i)
    expect(authResponseFactory.createResponse).not.toHaveBeenCalled()
  })

  it('treats an absent recovery escrow as a successful idempotent deletion', async () => {
    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
    })

    expect(result.isFailed()).toBe(false)
    expect(userRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery).toHaveBeenCalledTimes(1)
  })

  it('rejects a concurrent credential winner without creating a session or events', async () => {
    userRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery = jest.fn().mockResolvedValue(null)

    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
    })

    expect(result.isFailed()).toBe(true)
    expect(result.getError()).toMatch(/credentials changed.*sign in again/i)
    expect(authResponseFactory.createResponse).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(deleteOtherSessionsForUser.execute).not.toHaveBeenCalled()
  })

  it('should update protocol version while changing password', async () => {
    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
      protocolVersion: '004',
    })
    expect(result.isFailed()).toBeFalsy()

    expectAtomicTransition({
      encryptedPassword: expect.any(String),
      pwNonce: 'asdzxc',
      version: '004',
      email: 'test@test.te',
      uuid: userUuid,
      updatedAt: new Date(1),
    })
  })

  it('should not delete other sessions for user if neither passoword nor email are changed', async () => {
    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'qweqwe123123',
      newPassword: 'qweqwe123123',
      newEmail: undefined,
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
      kpCreated: '123',
      kpOrigination: 'password-change',
    })
    expect(result.isFailed()).toBeFalsy()

    expectAtomicTransition({
      encryptedPassword: expect.any(String),
      email: 'test@test.te',
      uuid: userUuid,
      pwNonce: 'asdzxc',
      kpCreated: '123',
      kpOrigination: 'password-change',
      updatedAt: new Date(1),
    })
    expect(domainEventFactory.createUserEmailChangedEvent).not.toHaveBeenCalled()
    expect(domainEventPublisher.publish).not.toHaveBeenCalled()
    expect(deleteOtherSessionsForUser.execute).not.toHaveBeenCalled()
  })

  it('should not delete other sessions for user if the caller does not support sessions', async () => {
    authResponseFactory.createResponse = jest.fn().mockReturnValue({ response: { foo: 'bar' } })

    const result = await createUseCase().execute({
      userUuid,
      username: Username.create('test@test.te').getValue(),
      apiVersion: ApiVersion.VERSIONS.v20200115,
      currentPassword: 'qweqwe123123',
      newPassword: 'test234',
      pwNonce: 'asdzxc',
      updatedWithUserAgent: 'Google Chrome',
      kpCreated: '123',
      kpOrigination: 'password-change',
    })

    expect(result.isFailed()).toBeFalsy()

    expectAtomicTransition({
      encryptedPassword: expect.any(String),
      pwNonce: 'asdzxc',
      kpCreated: '123',
      email: 'test@test.te',
      uuid: userUuid,
      kpOrigination: 'password-change',
      updatedAt: new Date(1),
    })

    expect(deleteOtherSessionsForUser.execute).not.toHaveBeenCalled()
  })
})
