import * as bcrypt from 'bcryptjs'
import { DomainEventPublisherInterface, UserEmailChangedEvent } from '@standardnotes/domain-events'
import { TimerInterface } from '@standardnotes/time'
import { EmailLevel, Result, UseCaseInterface, Username, Uuid } from '@standardnotes/domain-core'
import { ProtocolVersion } from '@standardnotes/common'

import { AuthResponseFactoryResolverInterface } from '../../Auth/AuthResponseFactoryResolverInterface'
import { User } from '../../User/User'
import { UserRepositoryInterface } from '../../User/UserRepositoryInterface'
import { ChangeCredentialsDTO } from './ChangeCredentialsDTO'
import { DomainEventFactoryInterface } from '../../Event/DomainEventFactoryInterface'
import { DeleteOtherSessionsForUser } from '../DeleteOtherSessionsForUser'
import { Session } from '../../Session/Session'
import { getBody, getSubject } from '../../Email/UserEmailChanged'
import { Logger } from 'winston'
import { AuthResponseCreationResult } from '../../Auth/AuthResponseCreationResult'
import { ApiVersion } from '../../Api/ApiVersion'

export class ChangeCredentials implements UseCaseInterface<AuthResponseCreationResult> {
  constructor(
    private userRepository: UserRepositoryInterface,
    private authResponseFactoryResolver: AuthResponseFactoryResolverInterface,
    private domainEventPublisher: DomainEventPublisherInterface,
    private domainEventFactory: DomainEventFactoryInterface,
    private timer: TimerInterface,
    private deleteOtherSessionsForUserUseCase: DeleteOtherSessionsForUser,
    private logger: Logger,
  ) {}

  async execute(dto: ChangeCredentialsDTO): Promise<Result<AuthResponseCreationResult>> {
    const apiVersionOrError = ApiVersion.create(dto.apiVersion)
    if (apiVersionOrError.isFailed()) {
      return Result.fail(apiVersionOrError.getError())
    }
    const apiVersion = apiVersionOrError.getValue()

    if (!dto.currentPassword || !dto.newPassword || !dto.pwNonce) {
      return Result.fail('The credential change request is missing required parameters.')
    }
    if (dto.protocolVersion && !Object.values(ProtocolVersion).includes(dto.protocolVersion as ProtocolVersion)) {
      return Result.fail('The credential change request contains an unsupported protocol version.')
    }

    const userUuidOrError = Uuid.create(dto.userUuid)
    if (userUuidOrError.isFailed()) {
      return Result.fail('User not found.')
    }
    const user = await this.userRepository.findOneByUuid(userUuidOrError.getValue())
    if (!user) {
      return Result.fail('User not found.')
    }

    if (!(await bcrypt.compare(dto.currentPassword, user.encryptedPassword))) {
      return Result.fail('The current password you entered is incorrect. Please try again.')
    }

    const existingEmailAddress = user.email
    let validatedNewEmail: string | undefined
    if (dto.newEmail !== undefined) {
      const newUsernameOrError = Username.create(dto.newEmail)
      if (newUsernameOrError.isFailed()) {
        return Result.fail(newUsernameOrError.getError())
      }
      const newUsername = newUsernameOrError.getValue()

      const existingUser = await this.userRepository.findOneByUsernameOrEmail(newUsername)
      if (existingUser !== null) {
        return Result.fail('The email you entered is already taken. Please try again.')
      }
      validatedNewEmail = newUsername.value
    }

    const expectedEncryptedPassword = user.encryptedPassword
    const expectedProtocolVersion = user.version ?? null
    const encryptedPassword = await bcrypt.hash(dto.newPassword, User.PASSWORD_HASH_COST)

    user.encryptedPassword = encryptedPassword

    let userEmailChangedEvent: UserEmailChangedEvent | undefined = undefined
    if (validatedNewEmail !== undefined) {
      userEmailChangedEvent = this.domainEventFactory.createUserEmailChangedEvent(
        user.uuid,
        user.email,
        validatedNewEmail,
      )

      user.email = validatedNewEmail
    }

    user.pwNonce = dto.pwNonce
    if (dto.protocolVersion) {
      user.version = dto.protocolVersion
    }
    if (dto.kpCreated) {
      user.kpCreated = dto.kpCreated
    }
    if (dto.kpOrigination) {
      user.kpOrigination = dto.kpOrigination
    }
    user.updatedAt = this.timer.getUTCDate()

    let updatedUser: User | null
    try {
      updatedUser = await this.userRepository.compareAndSwapCredentialsAndInvalidateAccountRecovery({
        user,
        expectedEncryptedPassword,
        expectedProtocolVersion,
      })
    } catch {
      return Result.fail('Could not invalidate account recovery before changing credentials.')
    }
    if (updatedUser === null) {
      return Result.fail('Credentials changed while this request was in progress. Please sign in again.')
    }

    if (userEmailChangedEvent !== undefined) {
      await this.domainEventPublisher.publish(userEmailChangedEvent)

      await this.sendEmailChangedNotification(existingEmailAddress, updatedUser.email)
    }

    const authResponseFactory = this.authResponseFactoryResolver.resolveAuthResponseFactoryVersion(apiVersion)

    const authResponse = await authResponseFactory.createResponse({
      user: updatedUser,
      apiVersion,
      userAgent: dto.updatedWithUserAgent,
      ephemeralSession: false,
      readonlyAccess: false,
      snjs: dto.snjs,
      application: dto.application,
    })

    if (authResponse.session) {
      await this.deleteOtherSessionsForUserIfNeeded(user.uuid, authResponse.session, dto)
    }

    return Result.ok(authResponse)
  }

  private async deleteOtherSessionsForUserIfNeeded(
    userUuid: string,
    session: Session,
    dto: ChangeCredentialsDTO,
  ): Promise<void> {
    const passwordHasChanged = dto.newPassword !== dto.currentPassword
    const userEmailChanged = dto.newEmail !== undefined

    if (passwordHasChanged || userEmailChanged) {
      await this.deleteOtherSessionsForUserUseCase.execute({
        userUuid,
        currentSessionUuid: session.uuid,
        markAsRevoked: false,
      })
    }
  }

  private async sendEmailChangedNotification(oldEmail: string, newEmail: string): Promise<void> {
    try {
      await this.domainEventPublisher.publish(
        this.domainEventFactory.createEmailRequestedEvent({
          userEmail: oldEmail,
          level: EmailLevel.LEVELS.System,
          body: getBody(newEmail),
          messageIdentifier: 'EMAIL_CHANGED',
          subject: getSubject(),
        }),
      )
    } catch (error) {
      this.logger.error(`Could not publish email changed request for email: ${(error as Error).message}`)
    }
  }
}
