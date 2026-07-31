import 'reflect-metadata'

import { ProtocolVersion } from '@standardnotes/common'
import { DomainEventInterface } from '@standardnotes/domain-events'
import { PredicateAuthority, PredicateName, PredicateVerificationResult } from '@standardnotes/predicates'
import { KeyParamsData } from '@standardnotes/responses'
import { TimerInterface } from '@standardnotes/time'

import { InviteeIdentifierType } from '../SharedSubscription/InviteeIdentifierType'
import { DomainEventFactory } from './DomainEventFactory'

describe('DomainEventFactory', () => {
  let timer: TimerInterface

  const createFactory = () => new DomainEventFactory(timer)

  const keyParams: KeyParamsData = {
    identifier: 'test@test.te',
    pw_nonce: 'nonce',
    version: ProtocolVersion.V004,
  }

  beforeEach(() => {
    timer = {} as jest.Mocked<TimerInterface>
    timer.getUTCDate = jest.fn().mockReturnValue(new Date(1))
    timer.getTimestampInMicroseconds = jest.fn().mockReturnValue(123456789)
  })

  const expectEvent = (
    event: DomainEventInterface,
    expected: { type: string; userIdentifier: string; userIdentifierType: string; payload: unknown; target?: string },
  ) => {
    expect(event.type).toEqual(expected.type)
    expect(event.createdAt).toEqual(new Date(1))
    expect(event.meta).toEqual({
      correlation: {
        userIdentifier: expected.userIdentifier,
        userIdentifierType: expected.userIdentifierType,
      },
      origin: 'auth',
      ...(expected.target ? { target: expected.target } : {}),
    })
    expect(event.payload).toEqual(expected.payload)
  }

  it('should create a subscription state requested event correlated by email', () => {
    const dto = { userEmail: 'test@test.te' }

    expectEvent(createFactory().createSubscriptionStateRequestedEvent(dto), {
      type: 'SUBSCRIPTION_STATE_REQUESTED',
      userIdentifier: 'test@test.te',
      userIdentifierType: 'email',
      payload: dto,
    })
  })

  it('should create a file quota recalculation requested event', () => {
    const dto = { userUuid: '1-2-3' }

    expectEvent(createFactory().createFileQuotaRecalculationRequestedEvent(dto), {
      type: 'FILE_QUOTA_RECALCULATION_REQUESTED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create an account deletion verification requested event correlated by uuid, not by email', () => {
    const dto = { userUuid: '1-2-3', email: 'test@test.te' }

    expectEvent(createFactory().createAccountDeletionVerificationRequestedEvent(dto), {
      type: 'ACCOUNT_DELETION_VERIFICATION_REQUESTED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a session created event', () => {
    const dto = { userUuid: '1-2-3' }

    expectEvent(createFactory().createSessionCreatedEvent(dto), {
      type: 'SESSION_CREATED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a session refreshed event', () => {
    const dto = { userUuid: '1-2-3' }

    expectEvent(createFactory().createSessionRefreshedEvent(dto), {
      type: 'SESSION_REFRESHED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a statistic persistence requested event that correlates to no particular user', () => {
    const dto = { statisticMeasureName: 'register-to-subscription', value: 12, date: 123 }

    expectEvent(createFactory().createStatisticPersistenceRequestedEvent(dto), {
      type: 'STATISTIC_PERSISTENCE_REQUESTED',
      userIdentifier: '-',
      userIdentifierType: 'email',
      payload: dto,
    })
  })

  it('should create a mute emails setting changed event correlated by username', () => {
    const dto = { username: 'test@test.te', mute: true, emailSubscriptionRejectionLevel: 'marketing' }

    expectEvent(createFactory().createMuteEmailsSettingChangedEvent(dto), {
      type: 'MUTE_EMAILS_SETTING_CHANGED',
      userIdentifier: 'test@test.te',
      userIdentifierType: 'email',
      payload: dto,
    })
  })

  it('should create an exit discount apply requested event', () => {
    const dto = { userEmail: 'test@test.te', discountCode: 'EXIT20' }

    expectEvent(createFactory().createExitDiscountApplyRequestedEvent(dto), {
      type: 'EXIT_DISCOUNT_APPLY_REQUESTED',
      userIdentifier: 'test@test.te',
      userIdentifierType: 'email',
      payload: dto,
    })
  })

  it('should create a web socket message requested event', () => {
    const dto = { userUuid: '1-2-3', message: 'a message' }

    expectEvent(createFactory().createWebSocketMessageRequestedEvent(dto), {
      type: 'WEB_SOCKET_MESSAGE_REQUESTED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create an email requested event correlated by email address', () => {
    const dto = {
      userEmail: 'test@test.te',
      messageIdentifier: 'EMAIL_CHANGED',
      level: 'system',
      body: '<p>body</p>',
      subject: 'A subject',
      userUuid: '1-2-3',
    }

    expectEvent(createFactory().createEmailRequestedEvent(dto), {
      type: 'EMAIL_REQUESTED',
      userIdentifier: 'test@test.te',
      userIdentifierType: 'email',
      payload: dto,
    })
  })

  it('should create a predicate verified event that lifts the user uuid out of the payload', () => {
    const predicate = {
      jobUuid: '2-3-4',
      authority: PredicateAuthority.Auth,
      name: PredicateName.EmailBackupsEnabled,
    }

    const event = createFactory().createPredicateVerifiedEvent({
      userUuid: '1-2-3',
      predicate,
      predicateVerificationResult: PredicateVerificationResult.Affirmed,
    })

    expectEvent(event, {
      type: 'PREDICATE_VERIFIED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: { predicate, predicateVerificationResult: PredicateVerificationResult.Affirmed },
    })
    expect(event.payload).not.toHaveProperty('userUuid')
  })

  it('should create a shared subscription invitation canceled event correlated to the inviter', () => {
    const dto = {
      inviterEmail: 'inviter@test.te',
      inviterSubscriptionId: 3,
      inviterSubscriptionUuid: '4-5-6',
      inviteeIdentifier: 'invitee@test.te',
      inviteeIdentifierType: 'email' as InviteeIdentifierType,
      sharedSubscriptionInvitationUuid: '5-6-7',
    }

    expectEvent(createFactory().createSharedSubscriptionInvitationCanceledEvent(dto), {
      type: 'SHARED_SUBSCRIPTION_INVITATION_CANCELED',
      userIdentifier: 'inviter@test.te',
      userIdentifierType: 'email',
      payload: dto,
    })
  })

  it('should create a shared subscription invitation created event correlated to the inviter', () => {
    const dto = {
      inviterEmail: 'inviter@test.te',
      inviterSubscriptionId: 3,
      inviteeIdentifier: 'invitee@test.te',
      inviteeIdentifierType: 'email' as InviteeIdentifierType,
      sharedSubscriptionInvitationUuid: '5-6-7',
    }

    expectEvent(createFactory().createSharedSubscriptionInvitationCreatedEvent(dto), {
      type: 'SHARED_SUBSCRIPTION_INVITATION_CREATED',
      userIdentifier: 'inviter@test.te',
      userIdentifierType: 'email',
      payload: dto,
    })
  })

  it('should create a user disabled session user agent logging event', () => {
    const dto = { userUuid: '1-2-3', email: 'test@test.te' }

    expectEvent(createFactory().createUserDisabledSessionUserAgentLoggingEvent(dto), {
      type: 'USER_DISABLED_SESSION_USER_AGENT_LOGGING',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create an email backup requested event from positional arguments', () => {
    expectEvent(createFactory().createEmailBackupRequestedEvent('1-2-3', keyParams), {
      type: 'EMAIL_BACKUP_REQUESTED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: { userUuid: '1-2-3', keyParams },
    })
  })

  it('should create a nextcloud backup requested event carrying the destination credentials', () => {
    const dto = {
      userUuid: '1-2-3',
      requestUuid: '2-3-4',
      keyParams,
      nextcloudUrl: 'https://nextcloud.test',
      nextcloudFolder: 'backups',
      nextcloudAppPassword: 'app-password',
    }

    expectEvent(createFactory().createNextcloudBackupRequestedEvent(dto), {
      type: 'NEXTCLOUD_BACKUP_REQUESTED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
      target: 'syncing-server',
    })
  })

  it('should create an account deletion requested event carrying both subscriptions when present', () => {
    const dto = {
      userUuid: '1-2-3',
      email: 'test@test.te',
      userCreatedAtTimestamp: 123,
      regularSubscription: { uuid: '4-5-6', ownerUuid: '1-2-3' },
      sharedSubscription: { uuid: '5-6-7', ownerUuid: '2-3-4' },
    }

    expectEvent(createFactory().createAccountDeletionRequestedEvent(dto), {
      type: 'ACCOUNT_DELETION_REQUESTED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create an account deletion requested event without any subscription', () => {
    const dto = { userUuid: '1-2-3', email: 'test@test.te', userCreatedAtTimestamp: 123 }

    expectEvent(createFactory().createAccountDeletionRequestedEvent(dto), {
      type: 'ACCOUNT_DELETION_REQUESTED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a user registered event carrying the protocol version', () => {
    const dto = { userUuid: '1-2-3', email: 'test@test.te', protocolVersion: ProtocolVersion.V004 }

    expectEvent(createFactory().createUserRegisteredEvent(dto), {
      type: 'USER_REGISTERED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: dto,
    })
  })

  it('should create a user email changed event keeping the old and new address in order', () => {
    expectEvent(createFactory().createUserEmailChangedEvent('1-2-3', 'old@test.te', 'new@test.te'), {
      type: 'USER_EMAIL_CHANGED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: { userUuid: '1-2-3', fromEmail: 'old@test.te', toEmail: 'new@test.te' },
    })
  })

  it('should create a user roles changed event stamped with a microsecond timestamp', () => {
    expectEvent(createFactory().createUserRolesChangedEvent('1-2-3', 'test@test.te', ['CORE_USER', 'PLUS_USER']), {
      type: 'USER_ROLES_CHANGED',
      userIdentifier: '1-2-3',
      userIdentifierType: 'uuid',
      payload: {
        userUuid: '1-2-3',
        email: 'test@test.te',
        currentRoles: ['CORE_USER', 'PLUS_USER'],
        timestamp: 123456789,
      },
    })
    expect(timer.getTimestampInMicroseconds).toHaveBeenCalledTimes(1)
  })

  it('should stamp every event with the timer date at the moment of creation', () => {
    timer.getUTCDate = jest.fn().mockReturnValueOnce(new Date(1)).mockReturnValueOnce(new Date(2))

    const factory = createFactory()

    expect(factory.createSessionCreatedEvent({ userUuid: '1-2-3' }).createdAt).toEqual(new Date(1))
    expect(factory.createSessionCreatedEvent({ userUuid: '1-2-3' }).createdAt).toEqual(new Date(2))
  })
})
