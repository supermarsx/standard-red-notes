import * as winston from 'winston'
import AgentKeepAlive from 'agentkeepalive'
import Redis from 'ioredis'
import { SNSClient } from '@aws-sdk/client-sns'
import axios, { AxiosInstance } from 'axios'
import { SQSClient, SQSClientConfig } from '@aws-sdk/client-sqs'
import { S3Client } from '@aws-sdk/client-s3'
import { Container } from 'inversify'
import {
  DomainEventHandlerInterface,
  DomainEventMessageHandlerInterface,
  DomainEventPublisherInterface,
  DomainEventSubscriberInterface,
} from '@standardnotes/domain-events'
import { TimerInterface, Timer } from '@standardnotes/time'
import { UAParser } from 'ua-parser-js'
type UAParserInstance = InstanceType<typeof UAParser>

import { Env } from './Env'
import { createS3ClientConfig } from './S3ClientConfigFactory'
import TYPES from './Types'
import { createSafeLogFormat } from '../Domain/Logging/SafeLog'
import { AuthenticateUser } from '../Domain/UseCase/AuthenticateUser'
import { Repository } from 'typeorm'
import { AppDataSource } from './DataSource'
import { User } from '../Domain/User/User'
import { Session } from '../Domain/Session/Session'
import { SessionService } from '../Domain/Session/SessionService'
import { TypeORMSessionRepository } from '../Infra/TypeORM/TypeORMSessionRepository'
import { TypeORMUserRepository } from '../Infra/TypeORM/TypeORMUserRepository'
import { SessionProjector } from '../Projection/SessionProjector'
import { RefreshSessionToken } from '../Domain/UseCase/RefreshSessionToken'
import { KeyParamsFactory } from '../Domain/User/KeyParamsFactory'
import { SignIn } from '../Domain/UseCase/SignIn'
import { VerifyMFA } from '../Domain/UseCase/VerifyMFA'
import { UserProjector } from '../Projection/UserProjector'
import { AuthResponseFactory20161215 } from '../Domain/Auth/AuthResponseFactory20161215'
import { AuthResponseFactory20190520 } from '../Domain/Auth/AuthResponseFactory20190520'
import { AuthResponseFactory20200115 } from '../Domain/Auth/AuthResponseFactory20200115'
import { AuthResponseFactoryResolver } from '../Domain/Auth/AuthResponseFactoryResolver'
import { ClearLoginAttempts } from '../Domain/UseCase/ClearLoginAttempts'
import { IncreaseLoginAttempts } from '../Domain/UseCase/IncreaseLoginAttempts'
import { GetUserKeyParams } from '../Domain/UseCase/GetUserKeyParams/GetUserKeyParams'
import { RedisEphemeralSessionRepository } from '../Infra/Redis/RedisEphemeralSessionRepository'
import { GetActiveSessionsForUser } from '../Domain/UseCase/GetActiveSessionsForUser'
import { DeleteOtherSessionsForUser } from '../Domain/UseCase/DeleteOtherSessionsForUser'
import { DeleteSessionForUser } from '../Domain/UseCase/DeleteSessionForUser'
import { Register } from '../Domain/UseCase/Register'
import { TypeORMRevokedSessionRepository } from '../Infra/TypeORM/TypeORMRevokedSessionRepository'
import { AuthenticationMethodResolver } from '../Domain/Auth/AuthenticationMethodResolver'
import { RevokedSession } from '../Domain/Session/RevokedSession'
import { DomainEventFactory } from '../Domain/Event/DomainEventFactory'
import { AuthenticateRequest } from '../Domain/UseCase/AuthenticateRequest'
import { Role } from '../Domain/Role/Role'
import { Permission } from '../Domain/Permission/Permission'
import { RoleProjector } from '../Projection/RoleProjector'
import { PermissionProjector } from '../Projection/PermissionProjector'
import { TypeORMRoleRepository } from '../Infra/TypeORM/TypeORMRoleRepository'
import { TypeORMPermissionRepository } from '../Infra/TypeORM/TypeORMPermissionRepository'
import { Setting } from '../Domain/Setting/Setting'
import { TypeORMSettingRepository } from '../Infra/TypeORM/TypeORMSettingRepository'
import { CrypterInterface } from '../Domain/Encryption/CrypterInterface'
import { CrypterNode } from '../Domain/Encryption/CrypterNode'
import { CryptoNode } from '@standardnotes/sncrypto-node'
import { GetSetting } from '../Domain/UseCase/GetSetting/GetSetting'
import { GetAccountRecoveryEscrow } from '../Domain/UseCase/GetAccountRecoveryEscrow/GetAccountRecoveryEscrow'
import { AccountDeletionRequestedEventHandler } from '../Domain/Handler/AccountDeletionRequestedEventHandler'
import { SubscriptionPurchasedEventHandler } from '../Domain/Handler/SubscriptionPurchasedEventHandler'
import { SubscriptionRenewedEventHandler } from '../Domain/Handler/SubscriptionRenewedEventHandler'
import { SubscriptionRefundedEventHandler } from '../Domain/Handler/SubscriptionRefundedEventHandler'
import { SubscriptionExpiredEventHandler } from '../Domain/Handler/SubscriptionExpiredEventHandler'
import { DeleteAccount } from '../Domain/UseCase/DeleteAccount/DeleteAccount'
import { DeleteSetting } from '../Domain/UseCase/DeleteSetting/DeleteSetting'
import { GetMfaSecret } from '../Domain/UseCase/GetMfaSecret/GetMfaSecret'
import { ValidateMfaToken } from '../Domain/UseCase/ValidateMfaToken/ValidateMfaToken'
import { UserSubscription } from '../Domain/Subscription/UserSubscription'
import { TypeORMUserSubscriptionRepository } from '../Infra/TypeORM/TypeORMUserSubscriptionRepository'
import { WebSocketsClientService } from '../Infra/WebSockets/WebSocketsClientService'
import { RoleService } from '../Domain/Role/RoleService'
import { ClientServiceInterface } from '../Domain/Client/ClientServiceInterface'
import { RoleServiceInterface } from '../Domain/Role/RoleServiceInterface'
import { GetUserFeatures } from '../Domain/UseCase/GetUserFeatures/GetUserFeatures'
import { RoleToSubscriptionMapInterface } from '../Domain/Role/RoleToSubscriptionMapInterface'
import { RoleToSubscriptionMap } from '../Domain/Role/RoleToSubscriptionMap'
import { FeatureServiceInterface } from '../Domain/Feature/FeatureServiceInterface'
import { FeatureService } from '../Domain/Feature/FeatureService'
import { ExtensionKeyGrantedEventHandler } from '../Domain/Handler/ExtensionKeyGrantedEventHandler'
import {
  DirectCallDomainEventPublisher,
  DirectCallEventMessageHandler,
  SQSDomainEventSubscriber,
  SQSEventMessageHandler,
} from '@standardnotes/domain-events-infra'
import { GetUserSubscription } from '../Domain/UseCase/GetUserSubscription/GetUserSubscription'
import { ChangeCredentials } from '../Domain/UseCase/ChangeCredentials/ChangeCredentials'
import { SubscriptionReassignedEventHandler } from '../Domain/Handler/SubscriptionReassignedEventHandler'
import { UserSubscriptionRepositoryInterface } from '../Domain/Subscription/UserSubscriptionRepositoryInterface'
import { CreateSubscriptionToken } from '../Domain/UseCase/CreateSubscriptionToken/CreateSubscriptionToken'
import { SubscriptionTokenRepositoryInterface } from '../Domain/Subscription/SubscriptionTokenRepositoryInterface'
import { RedisSubscriptionTokenRepository } from '../Infra/Redis/RedisSubscriptionTokenRepository'
import { AuthenticateSubscriptionToken } from '../Domain/UseCase/AuthenticateSubscriptionToken/AuthenticateSubscriptionToken'
import { OfflineSetting } from '../Domain/Setting/OfflineSetting'
import { OfflineSettingServiceInterface } from '../Domain/Setting/OfflineSettingServiceInterface'
import { OfflineSettingService } from '../Domain/Setting/OfflineSettingService'
import { OfflineSettingRepositoryInterface } from '../Domain/Setting/OfflineSettingRepositoryInterface'
import { SettingRepositoryInterface } from '../Domain/Setting/SettingRepositoryInterface'
import { TypeORMOfflineSettingRepository } from '../Infra/TypeORM/TypeORMOfflineSettingRepository'
import { OfflineUserSubscription } from '../Domain/Subscription/OfflineUserSubscription'
import { OfflineUserSubscriptionRepositoryInterface } from '../Domain/Subscription/OfflineUserSubscriptionRepositoryInterface'
import { TypeORMOfflineUserSubscriptionRepository } from '../Infra/TypeORM/TypeORMOfflineUserSubscriptionRepository'
import { OfflineSubscriptionTokenRepositoryInterface } from '../Domain/Auth/OfflineSubscriptionTokenRepositoryInterface'
import { RedisOfflineSubscriptionTokenRepository } from '../Infra/Redis/RedisOfflineSubscriptionTokenRepository'
import { CreateOfflineSubscriptionToken } from '../Domain/UseCase/CreateOfflineSubscriptionToken/CreateOfflineSubscriptionToken'
import { AuthenticateOfflineSubscriptionToken } from '../Domain/UseCase/AuthenticateOfflineSubscriptionToken/AuthenticateOfflineSubscriptionToken'
import { SubscriptionCancelledEventHandler } from '../Domain/Handler/SubscriptionCancelledEventHandler'
import { ContentDecoder, ContentDecoderInterface, ProtocolVersion } from '@standardnotes/common'
import { GetUserOfflineSubscription } from '../Domain/UseCase/GetUserOfflineSubscription/GetUserOfflineSubscription'
import { SettingsAssociationServiceInterface } from '../Domain/Setting/SettingsAssociationServiceInterface'
import { SettingsAssociationService } from '../Domain/Setting/SettingsAssociationService'
import { SubscriptionSyncRequestedEventHandler } from '../Domain/Handler/SubscriptionSyncRequestedEventHandler'
import {
  CrossServiceTokenData,
  DeterministicSelector,
  OfflineUserTokenData,
  SelectorInterface,
  SessionTokenData,
  TokenDecoder,
  TokenDecoderInterface,
  TokenEncoder,
  TokenEncoderInterface,
  ValetTokenData,
  WebSocketConnectionTokenData,
} from '@standardnotes/security'
import { FileUploadedEventHandler } from '../Domain/Handler/FileUploadedEventHandler'
import { CreateValetToken } from '../Domain/UseCase/CreateValetToken/CreateValetToken'
import { FileRemovedEventHandler } from '../Domain/Handler/FileRemovedEventHandler'
import { UserDisabledSessionUserAgentLoggingEventHandler } from '../Domain/Handler/UserDisabledSessionUserAgentLoggingEventHandler'
import { SettingCrypterInterface } from '../Domain/Setting/SettingCrypterInterface'
import { SettingCrypter } from '../Domain/Setting/SettingCrypter'
import { SharedSubscriptionInvitationRepositoryInterface } from '../Domain/SharedSubscription/SharedSubscriptionInvitationRepositoryInterface'
import { TypeORMSharedSubscriptionInvitationRepository } from '../Infra/TypeORM/TypeORMSharedSubscriptionInvitationRepository'
import { InviteToSharedSubscription } from '../Domain/UseCase/InviteToSharedSubscription/InviteToSharedSubscription'
import { SharedSubscriptionInvitation } from '../Domain/SharedSubscription/SharedSubscriptionInvitation'
import { AcceptSharedSubscriptionInvitation } from '../Domain/UseCase/AcceptSharedSubscriptionInvitation/AcceptSharedSubscriptionInvitation'
import { DeclineSharedSubscriptionInvitation } from '../Domain/UseCase/DeclineSharedSubscriptionInvitation/DeclineSharedSubscriptionInvitation'
import { CancelSharedSubscriptionInvitation } from '../Domain/UseCase/CancelSharedSubscriptionInvitation/CancelSharedSubscriptionInvitation'
import { TypeORMInviteEventOutbox } from '../Infra/TypeORM/TypeORMInviteEventOutbox'
import { TypeORMInviteEventOutboxRepository } from '../Infra/TypeORM/TypeORMInviteEventOutboxRepository'
import { AuthInviteEventTransactionContext } from '../Infra/TypeORM/AuthInviteEventTransactionContext'
import { authInviteTransactionAwareORMRepository } from '../Infra/TypeORM/AuthInviteTransactionAwareORMRepository'
import { AuthInviteTransactionAwareDomainEventPublisher } from '../Infra/TypeORM/AuthInviteTransactionAwareDomainEventPublisher'
import { InviteEventOutboxRepositoryInterface } from '../Domain/Invite/InviteEventOutboxRepositoryInterface'
import { InviteEventOutboxDispatcher } from '../Domain/Invite/InviteEventOutboxDispatcher'
import { AuthInviteRealtimeOutboxProducer } from '../Domain/Invite/AuthInviteRealtimeOutboxProducer'
import { AuthInviteMutationTransactionRunner } from '../Domain/Invite/AuthInviteMutationTransactionRunner'
import { AuthInviteAffectedUserResolver } from '../Domain/Invite/AuthInviteAffectedUserResolver'
import { SharedSubscriptionInvitationCreatedEventHandler } from '../Domain/Handler/SharedSubscriptionInvitationCreatedEventHandler'
import { SubscriptionSettingRepositoryInterface } from '../Domain/Setting/SubscriptionSettingRepositoryInterface'
import { TypeORMSubscriptionSettingRepository } from '../Infra/TypeORM/TypeORMSubscriptionSettingRepository'
import { ListSharedSubscriptionInvitations } from '../Domain/UseCase/ListSharedSubscriptionInvitations/ListSharedSubscriptionInvitations'
import { SubscriptionSettingsAssociationService } from '../Domain/Setting/SubscriptionSettingsAssociationService'
import { SubscriptionSettingsAssociationServiceInterface } from '../Domain/Setting/SubscriptionSettingsAssociationServiceInterface'
import { HeapProfiler } from '../Domain/Profiler/HeapProfiler'
import { PKCERepositoryInterface } from '../Domain/User/PKCERepositoryInterface'
import { LockRepositoryInterface } from '../Domain/User/LockRepositoryInterface'
import { RedisPKCERepository } from '../Infra/Redis/RedisPKCERepository'
import { RoleRepositoryInterface } from '../Domain/Role/RoleRepositoryInterface'
import { PermissionRepositoryInterface } from '../Domain/Permission/PermissionRepositoryInterface'
import { RevokedSessionRepositoryInterface } from '../Domain/Session/RevokedSessionRepositoryInterface'
import { SessionRepositoryInterface } from '../Domain/Session/SessionRepositoryInterface'
import { UserRepositoryInterface } from '../Domain/User/UserRepositoryInterface'
import { AuthController } from '../Controller/AuthController'
import { VerifyPredicate } from '../Domain/UseCase/VerifyPredicate/VerifyPredicate'
import { PredicateVerificationRequestedEventHandler } from '../Domain/Handler/PredicateVerificationRequestedEventHandler'
import { SubscriptionInvitesController } from '../Controller/SubscriptionInvitesController'
import { CreateCrossServiceToken } from '../Domain/UseCase/CreateCrossServiceToken/CreateCrossServiceToken'
import { resolveCrossServiceTokenVersionConfig } from '../Domain/Auth/CrossServiceTokenVersionConfig'
import { ProcessUserRequest } from '../Domain/UseCase/ProcessUserRequest/ProcessUserRequest'
import { UserRequestsController } from '../Controller/UserRequestsController'
import { EmailSubscriptionUnsubscribedEventHandler } from '../Domain/Handler/EmailSubscriptionUnsubscribedEventHandler'
import { EmailRequestedEventHandler } from '../Domain/Handler/EmailRequestedEventHandler'
import { SessionTraceRepositoryInterface } from '../Domain/Session/SessionTraceRepositoryInterface'
import { TypeORMSessionTraceRepository } from '../Infra/TypeORM/TypeORMSessionTraceRepository'
import {
  CacheEntry,
  CacheEntryRepositoryInterface,
  ControllerContainer,
  ControllerContainerInterface,
  MapperInterface,
  PinnedHttpTransport,
  RuntimeLogLevelApplier,
  ServerSettingsLogLevelResolver,
  SharedVaultUser,
  isRedisClusterTopology,
} from '@standardnotes/domain-core'
import { SessionTracePersistenceMapper } from '../Mapping/SessionTracePersistenceMapper'
import { SessionTrace } from '../Domain/Session/SessionTrace'
import { TypeORMSessionTrace } from '../Infra/TypeORM/TypeORMSessionTrace'
import { TraceSession } from '../Domain/UseCase/TraceSession/TraceSession'
import { CleanupSessionTraces } from '../Domain/UseCase/CleanupSessionTraces/CleanupSessionTraces'
import { PersistStatistics } from '../Domain/UseCase/PersistStatistics/PersistStatistics'
import { TypeORMAuthenticator } from '../Infra/TypeORM/TypeORMAuthenticator'
import { Authenticator } from '../Domain/Authenticator/Authenticator'
import { AuthenticatorPersistenceMapper } from '../Mapping/AuthenticatorPersistenceMapper'
import { AuthenticatorChallenge } from '../Domain/Authenticator/AuthenticatorChallenge'
import { TypeORMAuthenticatorChallenge } from '../Infra/TypeORM/TypeORMAuthenticatorChallenge'
import { AuthenticatorChallengePersistenceMapper } from '../Mapping/AuthenticatorChallengePersistenceMapper'
import { AuthenticatorRepositoryInterface } from '../Domain/Authenticator/AuthenticatorRepositoryInterface'
import { TypeORMAuthenticatorRepository } from '../Infra/TypeORM/TypeORMAuthenticatorRepository'
import { AuthenticatorChallengeRepositoryInterface } from '../Domain/Authenticator/AuthenticatorChallengeRepositoryInterface'
import { TypeORMAuthenticatorChallengeRepository } from '../Infra/TypeORM/TypeORMAuthenticatorChallengeRepository'
import { MagicLinkToken } from '../Domain/MagicLink/MagicLinkToken'
import { TypeORMMagicLinkToken } from '../Infra/TypeORM/TypeORMMagicLinkToken'
import { MagicLinkTokenPersistenceMapper } from '../Mapping/MagicLinkTokenPersistenceMapper'
import { MagicLinkTokenRepositoryInterface } from '../Domain/MagicLink/MagicLinkTokenRepositoryInterface'
import { TypeORMMagicLinkTokenRepository } from '../Infra/TypeORM/TypeORMMagicLinkTokenRepository'
import { EmailConfirmationToken } from '../Domain/EmailConfirmation/EmailConfirmationToken'
import { TypeORMEmailConfirmationToken } from '../Infra/TypeORM/TypeORMEmailConfirmationToken'
import { EmailConfirmationTokenPersistenceMapper } from '../Mapping/EmailConfirmationTokenPersistenceMapper'
import { EmailConfirmationTokenRepositoryInterface } from '../Domain/EmailConfirmation/EmailConfirmationTokenRepositoryInterface'
import { TypeORMEmailConfirmationTokenRepository } from '../Infra/TypeORM/TypeORMEmailConfirmationTokenRepository'
import { SendEmailConfirmation } from '../Domain/UseCase/SendEmailConfirmation/SendEmailConfirmation'
import { SignupInviteLink } from '../Domain/SignupInvite/SignupInviteLink'
import { TypeORMSignupInviteLink } from '../Infra/TypeORM/TypeORMSignupInviteLink'
import { SignupInviteLinkPersistenceMapper } from '../Mapping/SignupInviteLinkPersistenceMapper'
import { SignupInviteLinkRepositoryInterface } from '../Domain/SignupInvite/SignupInviteLinkRepositoryInterface'
import { TypeORMSignupInviteLinkRepository } from '../Infra/TypeORM/TypeORMSignupInviteLinkRepository'
import { SignupInviteUse } from '../Domain/SignupInvite/SignupInviteUse'
import { TypeORMSignupInviteUse } from '../Infra/TypeORM/TypeORMSignupInviteUse'
import { SignupInviteUsePersistenceMapper } from '../Mapping/SignupInviteUsePersistenceMapper'
import { SignupInviteUseRepositoryInterface } from '../Domain/SignupInvite/SignupInviteUseRepositoryInterface'
import { TypeORMSignupInviteUseRepository } from '../Infra/TypeORM/TypeORMSignupInviteUseRepository'
import { ConsumeSignupInvite } from '../Domain/UseCase/ConsumeSignupInvite/ConsumeSignupInvite'
import { CreateSignupInviteLink } from '../Domain/UseCase/CreateSignupInviteLink/CreateSignupInviteLink'
import { ListSignupInviteLinks } from '../Domain/UseCase/ListSignupInviteLinks/ListSignupInviteLinks'
import { RevokeSignupInviteLink } from '../Domain/UseCase/RevokeSignupInviteLink/RevokeSignupInviteLink'
import { ListPendingUsers } from '../Domain/UseCase/ListPendingUsers/ListPendingUsers'
import { ApproveUser } from '../Domain/UseCase/ApproveUser/ApproveUser'
import { RejectUser } from '../Domain/UseCase/RejectUser/RejectUser'
import { SendApprovalNotification } from '../Domain/UseCase/SendApprovalNotification/SendApprovalNotification'
import { VerifyEmailConfirmation } from '../Domain/UseCase/VerifyEmailConfirmation/VerifyEmailConfirmation'
import { ResendEmailConfirmation } from '../Domain/UseCase/ResendEmailConfirmation/ResendEmailConfirmation'
import { EmailSenderInterface } from '../Domain/Email/EmailSenderInterface'
import {
  createAuthEmailSender,
  emailQueueProducerOptionsFromEnvironment,
  maximumRawAttachmentBytesForQueue,
  parseEmailAttachmentMaximumBytes,
} from '../Domain/Email/QueuedEmailSender'
import { SmtpEmailSender } from '../Domain/Email/SmtpEmailSender'
import { BackupAttachmentStorageInterface } from '../Domain/Email/BackupAttachmentStorageInterface'
import { EmailBackupStateRepositoryInterface } from '../Domain/Email/EmailBackupStateRepositoryInterface'
import { FSOrS3BackupAttachmentStorage } from '../Infra/Backup/FSOrS3BackupAttachmentStorage'
import { TypeORMEmailBackupStateRepository } from '../Infra/TypeORM/TypeORMEmailBackupStateRepository'
import { GenerateMagicLinkCode } from '../Domain/UseCase/GenerateMagicLinkCode/GenerateMagicLinkCode'
import { VerifyMagicLinkCode } from '../Domain/UseCase/VerifyMagicLinkCode/VerifyMagicLinkCode'
import { MagicLinkController } from '../Controller/MagicLinkController'
import { BaseMagicLinkController } from '../Infra/InversifyExpressUtils/Base/BaseMagicLinkController'
import { GenerateAuthenticatorRegistrationOptions } from '../Domain/UseCase/GenerateAuthenticatorRegistrationOptions/GenerateAuthenticatorRegistrationOptions'
import { VerifyAuthenticatorRegistrationResponse } from '../Domain/UseCase/VerifyAuthenticatorRegistrationResponse/VerifyAuthenticatorRegistrationResponse'
import { GenerateAuthenticatorAuthenticationOptions } from '../Domain/UseCase/GenerateAuthenticatorAuthenticationOptions/GenerateAuthenticatorAuthenticationOptions'
import { VerifyAuthenticatorAuthenticationResponse } from '../Domain/UseCase/VerifyAuthenticatorAuthenticationResponse/VerifyAuthenticatorAuthenticationResponse'
import { AuthenticatorsController } from '../Controller/AuthenticatorsController'
import { ListAuthenticators } from '../Domain/UseCase/ListAuthenticators/ListAuthenticators'
import { AuthenticatorHttpProjection } from '../Infra/Http/Projection/AuthenticatorHttpProjection'
import { AuthenticatorHttpMapper } from '../Mapping/AuthenticatorHttpMapper'
import { DeleteAuthenticator } from '../Domain/UseCase/DeleteAuthenticator/DeleteAuthenticator'
import { AppPassword } from '../Domain/AppPassword/AppPassword'
import { TypeORMAppPassword } from '../Infra/TypeORM/TypeORMAppPassword'
import { AppPasswordPersistenceMapper } from '../Mapping/AppPasswordPersistenceMapper'
import { AppPasswordRepositoryInterface } from '../Domain/AppPassword/AppPasswordRepositoryInterface'
import { TypeORMAppPasswordRepository } from '../Infra/TypeORM/TypeORMAppPasswordRepository'
import { AppPasswordHttpProjection } from '../Infra/Http/Projection/AppPasswordHttpProjection'
import { AppPasswordHttpMapper } from '../Mapping/AppPasswordHttpMapper'
import { CreateAppPassword } from '../Domain/UseCase/CreateAppPassword/CreateAppPassword'
import { ListAppPasswords } from '../Domain/UseCase/ListAppPasswords/ListAppPasswords'
import { DeleteAppPassword } from '../Domain/UseCase/DeleteAppPassword/DeleteAppPassword'
import { RevokeAppPassword } from '../Domain/UseCase/RevokeAppPassword/RevokeAppPassword'
import { VerifyAppPassword } from '../Domain/UseCase/VerifyAppPassword/VerifyAppPassword'
import { AppPasswordsController } from '../Controller/AppPasswordsController'
import { BaseAppPasswordsController } from '../Infra/InversifyExpressUtils/Base/BaseAppPasswordsController'
import { BaseMeInviteLinksController } from '../Infra/InversifyExpressUtils/Base/BaseMeInviteLinksController'
import { McpToken } from '../Domain/McpToken/McpToken'
import { TypeORMMcpToken } from '../Infra/TypeORM/TypeORMMcpToken'
import { McpTokenPersistenceMapper } from '../Mapping/McpTokenPersistenceMapper'
import { McpTokenRepositoryInterface } from '../Domain/McpToken/McpTokenRepositoryInterface'
import { TypeORMMcpTokenRepository } from '../Infra/TypeORM/TypeORMMcpTokenRepository'
import { McpTokenHttpProjection } from '../Infra/Http/Projection/McpTokenHttpProjection'
import { McpTokenHttpMapper } from '../Mapping/McpTokenHttpMapper'
import { CreateMcpToken } from '../Domain/UseCase/CreateMcpToken/CreateMcpToken'
import { ListMcpTokens } from '../Domain/UseCase/ListMcpTokens/ListMcpTokens'
import { DeleteMcpToken } from '../Domain/UseCase/DeleteMcpToken/DeleteMcpToken'
import { AuthenticateWithMcpToken } from '../Domain/UseCase/AuthenticateWithMcpToken/AuthenticateWithMcpToken'
import { GetMcpTokenKeys } from '../Domain/UseCase/GetMcpTokenKeys/GetMcpTokenKeys'
import { McpTokensController } from '../Controller/McpTokensController'
import { BaseMcpTokensController } from '../Infra/InversifyExpressUtils/Base/BaseMcpTokensController'
import { Webhook } from '../Domain/Webhook/Webhook'
import { TypeORMWebhook } from '../Infra/TypeORM/TypeORMWebhook'
import { WebhookPersistenceMapper } from '../Mapping/WebhookPersistenceMapper'
import { WebhookRepositoryInterface } from '../Domain/Webhook/WebhookRepositoryInterface'
import { TypeORMWebhookRepository } from '../Infra/TypeORM/TypeORMWebhookRepository'
import { WebhookHttpProjection } from '../Infra/Http/Projection/WebhookHttpProjection'
import { WebhookHttpMapper } from '../Mapping/WebhookHttpMapper'
import { WebhookDispatcherInterface } from '../Domain/Webhook/WebhookDispatcherInterface'
import { WebhookDispatcher } from '../Infra/Http/WebhookDispatcher'
import { RegisterWebhook } from '../Domain/UseCase/RegisterWebhook/RegisterWebhook'
import { ListWebhooks } from '../Domain/UseCase/ListWebhooks/ListWebhooks'
import { DeleteWebhook } from '../Domain/UseCase/DeleteWebhook/DeleteWebhook'
import { WebhooksController } from '../Controller/WebhooksController'
import { BaseWebhooksController } from '../Infra/InversifyExpressUtils/Base/BaseWebhooksController'
import { WebhookItemDeletedEventHandler } from '../Domain/Handler/WebhookItemDeletedEventHandler'
import { WebhookItemsChangedEventHandler } from '../Domain/Handler/WebhookItemsChangedEventHandler'
import { AuditLogEntry } from '../Domain/AuditLog/AuditLogEntry'
import { TypeORMAuditLogEntry } from '../Infra/TypeORM/TypeORMAuditLogEntry'
import { AuditLogEntryPersistenceMapper } from '../Mapping/AuditLogEntryPersistenceMapper'
import { AuditLogEntryHttpProjection } from '../Infra/Http/Projection/AuditLogEntryHttpProjection'
import { AuditLogEntryHttpMapper } from '../Mapping/AuditLogEntryHttpMapper'
import { AuditLogRepositoryInterface } from '../Domain/AuditLog/AuditLogRepositoryInterface'
import { TypeORMAuditLogRepository } from '../Infra/TypeORM/TypeORMAuditLogRepository'
import { AuditLogWriterInterface } from '../Domain/AuditLog/AuditLogWriterInterface'
import { AuditLogWriter } from '../Domain/AuditLog/AuditLogWriter'
import { QueryAuditLog } from '../Domain/UseCase/QueryAuditLog/QueryAuditLog'
import { Share } from '../Domain/Share/Share'
import { TypeORMShare } from '../Infra/TypeORM/TypeORMShare'
import { SharePersistenceMapper } from '../Mapping/SharePersistenceMapper'
import { ShareRepositoryInterface } from '../Domain/Share/ShareRepositoryInterface'
import { TypeORMShareRepository } from '../Infra/TypeORM/TypeORMShareRepository'
import { ShareHttpProjection } from '../Infra/Http/Projection/ShareHttpProjection'
import { ShareHttpMapper } from '../Mapping/ShareHttpMapper'
import { CreateShare } from '../Domain/UseCase/CreateShare/CreateShare'
import { ListShares } from '../Domain/UseCase/ListShares/ListShares'
import { RevokeShare } from '../Domain/UseCase/RevokeShare/RevokeShare'
import { GetShare } from '../Domain/UseCase/GetShare/GetShare'
import { SharesController } from '../Controller/SharesController'
import { Group } from '../Domain/Group/Group'
import { TypeORMGroup } from '../Infra/TypeORM/TypeORMGroup'
import { TypeORMGroupRole } from '../Infra/TypeORM/TypeORMGroupRole'
import { TypeORMUserGroup } from '../Infra/TypeORM/TypeORMUserGroup'
import { GroupPersistenceMapper } from '../Mapping/GroupPersistenceMapper'
import { GroupRepositoryInterface } from '../Domain/Group/GroupRepositoryInterface'
import { TypeORMGroupRepository } from '../Infra/TypeORM/TypeORMGroupRepository'
import { GroupHttpProjection } from '../Infra/Http/Projection/GroupHttpProjection'
import { GroupHttpMapper } from '../Mapping/GroupHttpMapper'
import { CreateGroup } from '../Domain/UseCase/CreateGroup/CreateGroup'
import { ListGroups } from '../Domain/UseCase/ListGroups/ListGroups'
import { DeleteGroup } from '../Domain/UseCase/DeleteGroup/DeleteGroup'
import { AddUserToGroup } from '../Domain/UseCase/AddUserToGroup/AddUserToGroup'
import { RemoveUserFromGroup } from '../Domain/UseCase/RemoveUserFromGroup/RemoveUserFromGroup'
import { SetGroupRoles } from '../Domain/UseCase/SetGroupRoles/SetGroupRoles'
import { ListGroupMembers } from '../Domain/UseCase/ListGroupMembers/ListGroupMembers'
import { GetUserEffectivePermissions } from '../Domain/UseCase/GetUserEffectivePermissions/GetUserEffectivePermissions'
import { ListRolesWithPermissions } from '../Domain/UseCase/ListRolesWithPermissions/ListRolesWithPermissions'
import { SetRolePermissions } from '../Domain/UseCase/SetRolePermissions/SetRolePermissions'
import { CreateCustomRole } from '../Domain/UseCase/CreateCustomRole/CreateCustomRole'
import { DeleteCustomRole } from '../Domain/UseCase/DeleteCustomRole/DeleteCustomRole'
import { GetPermissionCatalog } from '../Domain/UseCase/GetPermissionCatalog/GetPermissionCatalog'
import { GetRoleHolders } from '../Domain/UseCase/GetRoleHolders/GetRoleHolders'
import { ResolveRoleSetPermissions } from '../Domain/UseCase/ResolveRoleSetPermissions/ResolveRoleSetPermissions'
import { BaseSharesController } from '../Infra/InversifyExpressUtils/Base/BaseSharesController'
import { DeadManSwitch } from '../Domain/DeadManSwitch/DeadManSwitch'
import { DeadManSwitchRepositoryInterface } from '../Domain/DeadManSwitch/DeadManSwitchRepositoryInterface'
import { DeadManSwitchPersistenceMapper } from '../Mapping/DeadManSwitchPersistenceMapper'
import { DeadManSwitchHttpProjection } from '../Infra/Http/Projection/DeadManSwitchHttpProjection'
import { DeadManSwitchHttpMapper } from '../Mapping/DeadManSwitchHttpMapper'
import { TypeORMDeadManSwitch } from '../Infra/TypeORM/TypeORMDeadManSwitch'
import { TypeORMDeadManSwitchRepository } from '../Infra/TypeORM/TypeORMDeadManSwitchRepository'
import { CreateDeadManSwitch } from '../Domain/UseCase/CreateDeadManSwitch/CreateDeadManSwitch'
import { ListDeadManSwitches } from '../Domain/UseCase/ListDeadManSwitches/ListDeadManSwitches'
import { CheckInDeadManSwitch } from '../Domain/UseCase/CheckInDeadManSwitch/CheckInDeadManSwitch'
import { DeleteDeadManSwitch } from '../Domain/UseCase/DeleteDeadManSwitch/DeleteDeadManSwitch'
import { TriggerDueDeadManSwitches } from '../Domain/UseCase/TriggerDueDeadManSwitches/TriggerDueDeadManSwitches'
import { DeadManSwitchesController } from '../Controller/DeadManSwitchesController'
import { BaseDeadManSwitchesController } from '../Infra/InversifyExpressUtils/Base/BaseDeadManSwitchesController'
import { EmailReminder } from '../Domain/EmailReminder/EmailReminder'
import { EmailReminderRepositoryInterface } from '../Domain/EmailReminder/EmailReminderRepositoryInterface'
import { EmailReminderPersistenceMapper } from '../Mapping/EmailReminderPersistenceMapper'
import { EmailReminderHttpProjection } from '../Infra/Http/Projection/EmailReminderHttpProjection'
import { EmailReminderHttpMapper } from '../Mapping/EmailReminderHttpMapper'
import { TypeORMEmailReminder } from '../Infra/TypeORM/TypeORMEmailReminder'
import { TypeORMEmailReminderRepository } from '../Infra/TypeORM/TypeORMEmailReminderRepository'
import { CreateEmailReminder } from '../Domain/UseCase/CreateEmailReminder/CreateEmailReminder'
import { ListEmailReminders } from '../Domain/UseCase/ListEmailReminders/ListEmailReminders'
import { DeleteEmailReminder } from '../Domain/UseCase/DeleteEmailReminder/DeleteEmailReminder'
import { TriggerDueEmailReminders } from '../Domain/UseCase/TriggerDueEmailReminders/TriggerDueEmailReminders'
import { EmailRemindersController } from '../Controller/EmailRemindersController'
import { BaseEmailRemindersController } from '../Infra/InversifyExpressUtils/Base/BaseEmailRemindersController'
import { TrustedDevice } from '../Domain/TrustedDevice/TrustedDevice'
import { TrustedDeviceRepositoryInterface } from '../Domain/TrustedDevice/TrustedDeviceRepositoryInterface'
import { TrustedDevicePersistenceMapper } from '../Mapping/TrustedDevicePersistenceMapper'
import { TrustedDeviceHttpProjection } from '../Infra/Http/Projection/TrustedDeviceHttpProjection'
import { TrustedDeviceHttpMapper } from '../Mapping/TrustedDeviceHttpMapper'
import { TypeORMTrustedDevice } from '../Infra/TypeORM/TypeORMTrustedDevice'
import { TypeORMTrustedDeviceRepository } from '../Infra/TypeORM/TypeORMTrustedDeviceRepository'
import { CreateTrustedDevice } from '../Domain/UseCase/CreateTrustedDevice/CreateTrustedDevice'
import { ListTrustedDevices } from '../Domain/UseCase/ListTrustedDevices/ListTrustedDevices'
import { DeleteTrustedDevice } from '../Domain/UseCase/DeleteTrustedDevice/DeleteTrustedDevice'
import { VerifyTrustedDevice } from '../Domain/UseCase/VerifyTrustedDevice/VerifyTrustedDevice'
import { TrustedDevicesController } from '../Controller/TrustedDevicesController'
import { BaseTrustedDevicesController } from '../Infra/InversifyExpressUtils/Base/BaseTrustedDevicesController'
import { PendingMfaApproval } from '../Domain/PendingMfaApproval/PendingMfaApproval'
import { PendingMfaApprovalRepositoryInterface } from '../Domain/PendingMfaApproval/PendingMfaApprovalRepositoryInterface'
import { PendingMfaApprovalPersistenceMapper } from '../Mapping/PendingMfaApprovalPersistenceMapper'
import { PendingMfaApprovalHttpProjection } from '../Infra/Http/Projection/PendingMfaApprovalHttpProjection'
import { PendingMfaApprovalHttpMapper } from '../Mapping/PendingMfaApprovalHttpMapper'
import { TypeORMPendingMfaApproval } from '../Infra/TypeORM/TypeORMPendingMfaApproval'
import { TypeORMPendingMfaApprovalRepository } from '../Infra/TypeORM/TypeORMPendingMfaApprovalRepository'
import { CreatePendingMfaApproval } from '../Domain/UseCase/CreatePendingMfaApproval/CreatePendingMfaApproval'
import { ResolvePendingMfaApproval } from '../Domain/UseCase/ResolvePendingMfaApproval/ResolvePendingMfaApproval'
import { GetPendingMfaApprovalStatus } from '../Domain/UseCase/GetPendingMfaApprovalStatus/GetPendingMfaApprovalStatus'
import { ListPendingMfaApprovals } from '../Domain/UseCase/ListPendingMfaApprovals/ListPendingMfaApprovals'
import { PendingMfaApprovalsController } from '../Controller/PendingMfaApprovalsController'
import { BasePendingMfaApprovalsController } from '../Infra/InversifyExpressUtils/Base/BasePendingMfaApprovalsController'
import { GenerateRecoveryCodes } from '../Domain/UseCase/GenerateRecoveryCodes/GenerateRecoveryCodes'
import { SignInWithRecoveryCodes } from '../Domain/UseCase/SignInWithRecoveryCodes/SignInWithRecoveryCodes'
import { GetUserKeyParamsRecovery } from '../Domain/UseCase/GetUserKeyParamsRecovery/GetUserKeyParamsRecovery'
import { CleanupExpiredSessions } from '../Domain/UseCase/CleanupExpiredSessions/CleanupExpiredSessions'
import { TypeORMCacheEntry } from '../Infra/TypeORM/TypeORMCacheEntry'
import { TypeORMCacheEntryRepository } from '../Infra/TypeORM/TypeORMCacheEntryRepository'
import { CacheEntryPersistenceMapper } from '../Mapping/CacheEntryPersistenceMapper'
import { TypeORMLockRepository } from '../Infra/TypeORM/TypeORMLockRepository'
import { EphemeralSessionRepositoryInterface } from '../Domain/Session/EphemeralSessionRepositoryInterface'
import { TypeORMEphemeralSessionRepository } from '../Infra/TypeORM/TypeORMEphemeralSessionRepository'
import { TypeORMOfflineSubscriptionTokenRepository } from '../Infra/TypeORM/TypeORMOfflineSubscriptionTokenRepository'
import { TypeORMPKCERepository } from '../Infra/TypeORM/TypeORMPKCERepository'
import { TypeORMSubscriptionTokenRepository } from '../Infra/TypeORM/TypeORMSubscriptionTokenRepository'
import { SessionMiddleware } from '../Infra/InversifyExpressUtils/Middleware/SessionMiddleware'
import { ApiGatewayOfflineAuthMiddleware } from '../Infra/InversifyExpressUtils/Middleware/ApiGatewayOfflineAuthMiddleware'
import { OfflineUserAuthMiddleware } from '../Infra/InversifyExpressUtils/Middleware/OfflineUserAuthMiddleware'
import { LockMiddleware } from '../Infra/InversifyExpressUtils/Middleware/LockMiddleware'
import { RequiredCrossServiceTokenMiddleware } from '../Infra/InversifyExpressUtils/Middleware/RequiredCrossServiceTokenMiddleware'
import { OptionalCrossServiceTokenMiddleware } from '../Infra/InversifyExpressUtils/Middleware/OptionalCrossServiceTokenMiddleware'
import { BaseSettingsController } from '../Infra/InversifyExpressUtils/Base/BaseSettingsController'
import { BaseAdminController } from '../Infra/InversifyExpressUtils/Base/BaseAdminController'
import { BaseAuthController } from '../Infra/InversifyExpressUtils/Base/BaseAuthController'
import { BaseAuthenticatorsController } from '../Infra/InversifyExpressUtils/Base/BaseAuthenticatorsController'
import { BaseFeaturesController } from '../Infra/InversifyExpressUtils/Base/BaseFeaturesController'
import { BaseOfflineController } from '../Infra/InversifyExpressUtils/Base/BaseOfflineController'
import { BaseSessionController } from '../Infra/InversifyExpressUtils/Base/BaseSessionController'
import { BaseSubscriptionInvitesController } from '../Infra/InversifyExpressUtils/Base/BaseSubscriptionInvitesController'
import { BaseSubscriptionSettingsController } from '../Infra/InversifyExpressUtils/Base/BaseSubscriptionSettingsController'
import { BaseSubscriptionTokensController } from '../Infra/InversifyExpressUtils/Base/BaseSubscriptionTokensController'
import { BaseUserRequestsController } from '../Infra/InversifyExpressUtils/Base/BaseUserRequestsController'
import { BaseUsersController } from '../Infra/InversifyExpressUtils/Base/BaseUsersController'
import { BaseValetTokenController } from '../Infra/InversifyExpressUtils/Base/BaseValetTokenController'
import { BaseWebSocketsController } from '../Infra/InversifyExpressUtils/Base/BaseWebSocketsController'
import { BaseSessionsController } from '../Infra/InversifyExpressUtils/Base/BaseSessionsController'
import { Transform } from 'stream'
import { ActivatePremiumFeatures } from '../Domain/UseCase/ActivatePremiumFeatures/ActivatePremiumFeatures'
import { PaymentsAccountDeletedEventHandler } from '../Domain/Handler/PaymentsAccountDeletedEventHandler'
import { UpdateStorageQuotaUsedForUser } from '../Domain/UseCase/UpdateStorageQuotaUsedForUser/UpdateStorageQuotaUsedForUser'
import { SharedVaultFileUploadedEventHandler } from '../Domain/Handler/SharedVaultFileUploadedEventHandler'
import { SharedVaultFileRemovedEventHandler } from '../Domain/Handler/SharedVaultFileRemovedEventHandler'
import { SharedVaultFileMovedEventHandler } from '../Domain/Handler/SharedVaultFileMovedEventHandler'
import { TypeORMSharedVaultUser } from '../Infra/TypeORM/TypeORMSharedVaultUser'
import { SharedVaultUserPersistenceMapper } from '../Mapping/SharedVaultUserPersistenceMapper'
import { SharedVaultUserRepositoryInterface } from '../Domain/SharedVault/SharedVaultUserRepositoryInterface'
import { TypeORMSharedVaultUserRepository } from '../Infra/TypeORM/TypeORMSharedVaultUserRepository'
import { AddSharedVaultUser } from '../Domain/UseCase/AddSharedVaultUser/AddSharedVaultUser'
import { RemoveSharedVaultUser } from '../Domain/UseCase/RemoveSharedVaultUser/RemoveSharedVaultUser'
import { UserAddedToSharedVaultEventHandler } from '../Domain/Handler/UserAddedToSharedVaultEventHandler'
import { UserRemovedFromSharedVaultEventHandler } from '../Domain/Handler/UserRemovedFromSharedVaultEventHandler'
import { DesignateSurvivor } from '../Domain/UseCase/DesignateSurvivor/DesignateSurvivor'
import { UserDesignatedAsSurvivorInSharedVaultEventHandler } from '../Domain/Handler/UserDesignatedAsSurvivorInSharedVaultEventHandler'
import { DisableEmailSettingBasedOnEmailSubscription } from '../Domain/UseCase/DisableEmailSettingBasedOnEmailSubscription/DisableEmailSettingBasedOnEmailSubscription'
import { DomainEventFactoryInterface } from '../Domain/Event/DomainEventFactoryInterface'
import { KeyParamsFactoryInterface } from '../Domain/User/KeyParamsFactoryInterface'
import { TypeORMSubscriptionSetting } from '../Infra/TypeORM/TypeORMSubscriptionSetting'
import { SetSettingValue } from '../Domain/UseCase/SetSettingValue/SetSettingValue'
import { SetUserBanStatus } from '../Domain/UseCase/SetUserBanStatus/SetUserBanStatus'
import { SetUserSuspension } from '../Domain/UseCase/SetUserSuspension/SetUserSuspension'
import { ApplyDefaultSubscriptionSettings } from '../Domain/UseCase/ApplyDefaultSubscriptionSettings/ApplyDefaultSubscriptionSettings'
import { GetSubscriptionSetting } from '../Domain/UseCase/GetSubscriptionSetting/GetSubscriptionSetting'
import { SetSubscriptionSettingValue } from '../Domain/UseCase/SetSubscriptionSettingValue/SetSubscriptionSettingValue'
import { GetSettings } from '../Domain/UseCase/GetSettings/GetSettings'
import { GetSubscriptionSettings } from '../Domain/UseCase/GetSubscriptionSettings/GetSubscriptionSettings'
import { GetAllSettingsForUser } from '../Domain/UseCase/GetAllSettingsForUser/GetAllSettingsForUser'
import { GetRegularSubscriptionForUser } from '../Domain/UseCase/GetRegularSubscriptionForUser/GetRegularSubscriptionForUser'
import { GetSharedSubscriptionForUser } from '../Domain/UseCase/GetSharedSubscriptionForUser/GetSharedSubscriptionForUser'
import { GetSharedOrRegularSubscriptionForUser } from '../Domain/UseCase/GetSharedOrRegularSubscriptionForUser/GetSharedOrRegularSubscriptionForUser'
import { ProjectorInterface } from '../Projection/ProjectorInterface'
import { SettingHttpRepresentation } from '../Mapping/Http/SettingHttpRepresentation'
import { SubscriptionSetting } from '../Domain/Setting/SubscriptionSetting'
import { SubscriptionSettingHttpRepresentation } from '../Mapping/Http/SubscriptionSettingHttpRepresentation'
import { SettingHttpMapper } from '../Mapping/Http/SettingHttpMapper'
import { SubscriptionSettingHttpMapper } from '../Mapping/Http/SubscriptionSettingHttpMapper'
import { TypeORMSetting } from '../Infra/TypeORM/TypeORMSetting'
import { TypeORMNextcloudBackupStateRepository } from '../Infra/TypeORM/TypeORMNextcloudBackupStateRepository'
import { SettingPersistenceMapper } from '../Mapping/Persistence/SettingPersistenceMapper'
import { SubscriptionSettingPersistenceMapper } from '../Mapping/Persistence/SubscriptionSettingPersistenceMapper'
import { ApplyDefaultSettings } from '../Domain/UseCase/ApplyDefaultSettings/ApplyDefaultSettings'
import { AuthResponseFactoryResolverInterface } from '../Domain/Auth/AuthResponseFactoryResolverInterface'
import { UserInvitedToSharedVaultEventHandler } from '../Domain/Handler/UserInvitedToSharedVaultEventHandler'
import { TriggerPostSettingUpdateActions } from '../Domain/UseCase/TriggerPostSettingUpdateActions/TriggerPostSettingUpdateActions'
import { TriggerEmailBackupForUser } from '../Domain/UseCase/TriggerEmailBackupForUser/TriggerEmailBackupForUser'
import { TriggerEmailBackupForAllUsers } from '../Domain/UseCase/TriggerEmailBackupForAllUsers/TriggerEmailBackupForAllUsers'
import { ReconcilePendingEmailBackupForUser } from '../Domain/UseCase/ReconcilePendingEmailBackupForUser/ReconcilePendingEmailBackupForUser'
import { TriggerNextcloudBackupForUser } from '../Domain/UseCase/TriggerNextcloudBackupForUser/TriggerNextcloudBackupForUser'
import { TriggerNextcloudBackupForAllUsers } from '../Domain/UseCase/TriggerNextcloudBackupForAllUsers/TriggerNextcloudBackupForAllUsers'
import { NextcloudBackupStateStore } from '../Domain/Setting/NextcloudBackupStateStore'
import { NextcloudBackupCompletedEventHandler } from '../Domain/Handler/NextcloudBackupCompletedEventHandler'
import { ServerSettingsOverlayReader } from '../Infra/FS/ServerSettingsOverlayReader'
import { ProofOfWorkChallengeRepositoryInterface } from '../Domain/ProofOfWork/ProofOfWorkChallengeRepositoryInterface'
import { ProofOfWorkConfig } from '../Domain/ProofOfWork/ProofOfWorkConfig'
import { ProofOfWorkConfigResolverInterface } from '../Domain/ProofOfWork/ProofOfWorkConfigResolverInterface'
import { ProofOfWorkGate } from '../Domain/ProofOfWork/ProofOfWorkGate'
import { RequestProofOfWorkChallenge } from '../Domain/UseCase/RequestProofOfWorkChallenge/RequestProofOfWorkChallenge'
import { VerifyProofOfWork } from '../Domain/UseCase/VerifyProofOfWork/VerifyProofOfWork'
import { RedisProofOfWorkChallengeRepository } from '../Infra/Redis/RedisProofOfWorkChallengeRepository'
import { TypeORMProofOfWorkChallengeRepository } from '../Infra/TypeORM/TypeORMProofOfWorkChallengeRepository'
import { clampDifficulty, EnvProofOfWorkConfigResolver } from '../Infra/ProofOfWork/EnvProofOfWorkConfigResolver'
import { RegistrationConfigResolverInterface } from '../Domain/Registration/RegistrationConfigResolverInterface'
import {
  EnvRegistrationConfigResolver,
  registrationBaselineFromEnv,
} from '../Infra/Registration/EnvRegistrationConfigResolver'
import { SignupLimitsConfigResolverInterface } from '../Domain/Registration/SignupLimitsConfigResolverInterface'
import {
  EnvSignupLimitsConfigResolver,
  signupLimitsBaselineFromEnv,
} from '../Infra/Registration/EnvSignupLimitsConfigResolver'
import { SignupRateLimiterInterface } from '../Domain/Registration/SignupRateLimiterInterface'
import { RedisSignupRateLimiter } from '../Infra/Registration/RedisSignupRateLimiter'
import { CSVFileReaderInterface } from '../Domain/CSV/CSVFileReaderInterface'
import { S3CsvFileReader } from '../Infra/S3/S3CsvFileReader'
import { DeleteAccountsFromCSVFile } from '../Domain/UseCase/DeleteAccountsFromCSVFile/DeleteAccountsFromCSVFile'
import { AccountDeletionVerificationPassedEventHandler } from '../Domain/Handler/AccountDeletionVerificationPassedEventHandler'
import { RenewSharedSubscriptions } from '../Domain/UseCase/RenewSharedSubscriptions/RenewSharedSubscriptions'
import { FixStorageQuotaForUser } from '../Domain/UseCase/FixStorageQuotaForUser/FixStorageQuotaForUser'
import { FileQuotaRecalculatedEventHandler } from '../Domain/Handler/FileQuotaRecalculatedEventHandler'
import { SessionServiceInterface } from '../Domain/Session/SessionServiceInterface'
import { SubscriptionStateFetchedEventHandler } from '../Domain/Handler/SubscriptionStateFetchedEventHandler'
import { CaptchaServerInterface } from '../Domain/HumanVerification/CaptchaServerInterface'
import { VerifyHumanInteraction } from '../Domain/UseCase/VerifyHumanInteraction/VerifyHumanInteraction'
import { HttpCaptchaServer } from '../Infra/Http/HumanVerification/HttpCaptchaServer'
import { CookieFactoryInterface } from '../Domain/Auth/Cookies/CookieFactoryInterface'
import { CookieFactory } from '../Domain/Auth/Cookies/CookieFactory'
import { RedisLockRepository } from '../Infra/Redis/RedisLockRepository'
import { RedisIpEscalationChecker } from '../Infra/Redis/RedisIpEscalationChecker'
import { RedisMfaSecretRepository } from '../Infra/Redis/RedisMfaSecretRepository'
import { TypeORMMfaSecretRepository } from '../Infra/TypeORM/TypeORMMfaSecretRepository'
import { MfaSecretRepositoryInterface } from '../Domain/Mfa/MfaSecretRepositoryInterface'
import { DeleteSessionByToken } from '../Domain/UseCase/DeleteSessionByToken/DeleteSessionByToken'
import { GetSessionFromToken } from '../Domain/UseCase/GetSessionFromToken/GetSessionFromToken'
import { CooldownSessionTokens } from '../Domain/UseCase/CooldownSessionTokens/CooldownSessionTokens'
import { SessionTokensCooldownRepositoryInterface } from '../Domain/Session/SessionTokensCooldownRepositoryInterface'
import { RedisSessionTokensCooldownRepository } from '../Infra/Redis/RedisSessionTokensCooldownRepository'
import { InMemorySessionTokensCooldownRepository } from '../Infra/InMemory/InMemorySessionTokensCooldownRepository'
import { GetCooldownSessionTokens } from '../Domain/UseCase/GetCooldownSessionTokens/GetCooldownSessionTokens'
import { VerifyUserServerPassword } from '../Domain/UseCase/VerifyUserServerPassword/VerifyUserServerPassword'
import {
  buildSnsClientConfig,
  buildSnsDomainEventPublisher,
  LazyDomainEventPublisher,
} from './LazyDomainEventPublisher'
import {
  isValidDedicatedNextcloudBackupTopicArn,
  UnavailableNextcloudBackupDomainEventPublisher,
} from './NextcloudBackupDomainEventPublisher'

export class ContainerConfigLoader {
  // Standard Red Notes: 'cli' is an additive lean-boot mode for the srn-admin
  // bin. It behaves exactly like 'worker' (no migrations) except that it skips
  // constructing the SNS/SQS/S3 clients and the SQS event subscriber, which the
  // CLI never uses (domain-event publishing stays functional through a lazy
  // publisher — see LazyDomainEventPublisher). 'server'/'worker' behavior is
  // unchanged.
  constructor(private mode: 'server' | 'worker' | 'cli' = 'server') {}

  async load(configuration?: {
    controllerConatiner?: ControllerContainerInterface
    directCallDomainEventPublisher?: DirectCallDomainEventPublisher
    logger?: Transform
    environmentOverrides?: { [name: string]: string }
    container?: Container
  }): Promise<Container> {
    const directCallDomainEventPublisher =
      configuration?.directCallDomainEventPublisher ?? new DirectCallDomainEventPublisher()

    const env: Env = new Env(configuration?.environmentOverrides)
    env.load()

    const container = configuration?.container ?? new Container()

    const winstonFormatters = [winston.format.splat(), createSafeLogFormat(), winston.format.json()]

    let logger: winston.Logger
    if (configuration?.logger) {
      logger = configuration.logger as winston.Logger
    } else {
      logger = winston.createLogger({
        level: env.get('LOG_LEVEL', true) || 'info',
        format: winston.format.combine(...winstonFormatters),
        transports: [new winston.transports.Console({ level: env.get('LOG_LEVEL', true) || 'info' })],
        defaultMeta: { service: `auth:${this.mode}` },
      })
    }
    container.bind<winston.Logger>(TYPES.Auth_Logger).toConstantValue(logger)

    // Server and worker processes own their logger and poll the shared overlay.
    // The short-lived CLI does not poll, and home-server injects a named logger
    // covered by its one grouped poller.
    if (this.mode !== 'cli' && !configuration?.logger) {
      new RuntimeLogLevelApplier(
        logger,
        new ServerSettingsLogLevelResolver(
          env.get('SERVER_SETTINGS_PATH', true) || undefined,
          env.get('LOG_LEVEL', true) || undefined,
        ),
      ).start()
    }

    container.bind<CryptoNode>(TYPES.Auth_CryptoNode).toConstantValue(new CryptoNode())

    const appDataSource = new AppDataSource({ env, runMigrations: this.mode === 'server' })
    await appDataSource.initialize()

    logger.debug('Database initialized')

    const isConfiguredForHomeServer = env.get('MODE', true) === 'home-server'
    const isConfiguredForSelfHosting = env.get('MODE', true) === 'self-hosted'
    const isConfiguredForHomeServerOrSelfHosting = isConfiguredForHomeServer || isConfiguredForSelfHosting
    // Standard Red Notes: lean CLI boot (see constructor comment).
    const isConfiguredForCli = this.mode === 'cli'
    const isConfiguredForInMemoryCache = env.get('CACHE_TYPE', true) === 'memory'
    const captchaServerUrl = env.get('CAPTCHA_SERVER_URL', true)
    const captchaUIUrl = env.get('CAPTCHA_UI_URL', true)

    // Standard Red Notes: how long (in days) a "trusted device" may bypass the
    // interactive second factor before the user must complete 2FA again.
    // Defaults to 30 days. Trust never bypasses the account password.
    const trustedDeviceDurationDays = +(env.get('AUTH_TRUSTED_DEVICE_DURATION_DAYS', true) || '30')

    // Standard Red Notes: how long (in seconds) a push-MFA approval request
    // remains actionable before the new device must fall back to interactive
    // TOTP. Short by design. Defaults to 120 seconds.
    const pendingMfaApprovalTtlSeconds = +(env.get('AUTH_MFA_APPROVAL_TTL_SECONDS', true) || '120')

    container
      .bind<boolean>(TYPES.Auth_IS_CONFIGURED_FOR_HOME_SERVER_OR_SELF_HOSTING)
      .toConstantValue(isConfiguredForHomeServerOrSelfHosting)

    if (!isConfiguredForInMemoryCache) {
      const redisUrl = env.get('REDIS_URL')
      const isRedisInClusterMode = redisUrl.indexOf(',') > 0
      // Standard Red Notes: bounded exponential reconnection backoff (cap 5s) plus
      // an explicit per-request retry ceiling so a brief Redis blip self-heals
      // instead of wedging the process. No BullMQ here, so a finite
      // maxRetriesPerRequest is safe. Connection target/secrets are unchanged.
      const redisRetryStrategy = (times: number): number => Math.min(times * 200, 5000)
      let redis
      if (isRedisInClusterMode) {
        redis = new Redis.Cluster(redisUrl.split(','), {
          clusterRetryStrategy: redisRetryStrategy,
          redisOptions: { maxRetriesPerRequest: 20 },
        })
      } else {
        redis = new Redis(redisUrl, {
          maxRetriesPerRequest: 20,
          retryStrategy: redisRetryStrategy,
        })
      }

      container.bind(TYPES.Auth_Redis).toConstantValue(redis)
    }

    container.bind<TimerInterface>(TYPES.Auth_Timer).toConstantValue(new Timer())

    // Standard Red Notes: the CLI never consumes events and only rarely
    // publishes one, so 'cli' mode skips constructing the SNS/SQS/S3 clients
    // (publishing stays available lazily — see the DomainEventPublisher
    // binding below).
    if (!isConfiguredForHomeServer && !isConfiguredForCli) {
      const snsClient = new SNSClient(buildSnsClientConfig(env))
      container.bind<SNSClient>(TYPES.Auth_SNS).toConstantValue(snsClient)

      const sqsConfig: SQSClientConfig = {
        region: env.get('SQS_AWS_REGION', true),
      }
      if (env.get('SQS_ENDPOINT', true)) {
        sqsConfig.endpoint = env.get('SQS_ENDPOINT', true)
      }
      if (env.get('SQS_ACCESS_KEY_ID', true) && env.get('SQS_SECRET_ACCESS_KEY', true)) {
        sqsConfig.credentials = {
          accessKeyId: env.get('SQS_ACCESS_KEY_ID', true),
          secretAccessKey: env.get('SQS_SECRET_ACCESS_KEY', true),
        }
      }
      const sqsClient = new SQSClient(sqsConfig)
      container.bind<SQSClient>(TYPES.Auth_SQS).toConstantValue(sqsClient)

      const s3Config = createS3ClientConfig({
        accessKeyId: env.get('S3_ACCESS_KEY_ID', true),
        endpoint: env.get('S3_ENDPOINT', true),
        region: env.get('S3_AWS_REGION', true),
        secretAccessKey: env.get('S3_SECRET_ACCESS_KEY', true),
      })
      container.bind<S3Client>(TYPES.Auth_S3).toConstantValue(new S3Client(s3Config))

      container
        .bind<CSVFileReaderInterface>(TYPES.Auth_CSVFileReader)
        .toConstantValue(
          new S3CsvFileReader(env.get('S3_AUTH_SCRIPTS_DATA_BUCKET', true), container.get<S3Client>(TYPES.Auth_S3)),
        )

      if (env.get('PROFILER_ENABLED', true) === 'true') {
        const s3BucketName = env.get('S3_PROFILER_BUCKET_NAME', true)

        container
          .bind<HeapProfiler>(TYPES.Auth_HeapProfiler)
          .toConstantValue(
            new HeapProfiler(
              container.get<winston.Logger>(TYPES.Auth_Logger),
              container.get<S3Client>(TYPES.Auth_S3),
              s3BucketName,
            ),
          )
        logger.debug('Heap profiler configured')
      }
    }

    container.bind(TYPES.Auth_SNS_TOPIC_ARN).toConstantValue(env.get('SNS_TOPIC_ARN', true))

    // Standard Red Notes: lean CLI boot — many use-case bindings eagerly resolve
    // the publisher at load time, but only fix-quota ever publishes. In 'cli'
    // mode the SNS client + publisher are built on the FIRST publish so boot
    // skips them while publishing stays correct.
    let domainEventPublisher: DomainEventPublisherInterface
    if (isConfiguredForHomeServer) {
      domainEventPublisher = directCallDomainEventPublisher
    } else if (isConfiguredForCli) {
      domainEventPublisher = new LazyDomainEventPublisher(() =>
        buildSnsDomainEventPublisher(new SNSClient(buildSnsClientConfig(env)), env.get('SNS_TOPIC_ARN', true), env),
      )
    } else {
      domainEventPublisher = buildSnsDomainEventPublisher(
        container.get(TYPES.Auth_SNS),
        container.get(TYPES.Auth_SNS_TOPIC_ARN),
        env,
      )
    }
    const authInviteEventTransactionContext = new AuthInviteEventTransactionContext()
    container
      .bind<AuthInviteEventTransactionContext>(TYPES.Auth_InviteEventTransactionContext)
      .toConstantValue(authInviteEventTransactionContext)
    container
      .bind<DomainEventPublisherInterface>(TYPES.Auth_RawDomainEventPublisher)
      .toConstantValue(domainEventPublisher)
    container
      .bind<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher)
      .toConstantValue(
        new AuthInviteTransactionAwareDomainEventPublisher(domainEventPublisher, authInviteEventTransactionContext),
      )

    const nextcloudBackupTopicArn = env.get('NEXTCLOUD_BACKUP_SNS_TOPIC_ARN', true)
    let nextcloudBackupDomainEventPublisher: DomainEventPublisherInterface
    if (isConfiguredForHomeServer) {
      // Direct-call mode has no broker queues and therefore no credential fan-out.
      nextcloudBackupDomainEventPublisher = directCallDomainEventPublisher
    } else if (!isValidDedicatedNextcloudBackupTopicArn(nextcloudBackupTopicArn, env.get('SNS_TOPIC_ARN', true))) {
      logger.error(
        'Scheduled Nextcloud backup delivery is unavailable: configure a dedicated NEXTCLOUD_BACKUP_SNS_TOPIC_ARN distinct from SNS_TOPIC_ARN.',
      )
      nextcloudBackupDomainEventPublisher = new UnavailableNextcloudBackupDomainEventPublisher()
    } else if (isConfiguredForCli) {
      nextcloudBackupDomainEventPublisher = new LazyDomainEventPublisher(() =>
        buildSnsDomainEventPublisher(new SNSClient(buildSnsClientConfig(env)), nextcloudBackupTopicArn, env),
      )
    } else {
      nextcloudBackupDomainEventPublisher = buildSnsDomainEventPublisher(
        container.get(TYPES.Auth_SNS),
        nextcloudBackupTopicArn,
        env,
      )
    }
    container
      .bind<DomainEventPublisherInterface>(TYPES.Auth_NextcloudBackupDomainEventPublisher)
      .toConstantValue(nextcloudBackupDomainEventPublisher)

    // Mapping
    container
      .bind<MapperInterface<SessionTrace, TypeORMSessionTrace>>(TYPES.Auth_SessionTracePersistenceMapper)
      .toConstantValue(new SessionTracePersistenceMapper(container.get<TimerInterface>(TYPES.Auth_Timer)))
    container
      .bind<MapperInterface<Authenticator, TypeORMAuthenticator>>(TYPES.Auth_AuthenticatorPersistenceMapper)
      .toConstantValue(new AuthenticatorPersistenceMapper())
    container
      .bind<MapperInterface<Authenticator, AuthenticatorHttpProjection>>(TYPES.Auth_AuthenticatorHttpMapper)
      .toConstantValue(new AuthenticatorHttpMapper())
    container
      .bind<MapperInterface<AppPassword, TypeORMAppPassword>>(TYPES.Auth_AppPasswordPersistenceMapper)
      .toConstantValue(new AppPasswordPersistenceMapper())
    container
      .bind<MapperInterface<AppPassword, AppPasswordHttpProjection>>(TYPES.Auth_AppPasswordHttpMapper)
      .toConstantValue(new AppPasswordHttpMapper())
    container
      .bind<MapperInterface<McpToken, TypeORMMcpToken>>(TYPES.Auth_McpTokenPersistenceMapper)
      .toConstantValue(new McpTokenPersistenceMapper())
    container
      .bind<MapperInterface<McpToken, McpTokenHttpProjection>>(TYPES.Auth_McpTokenHttpMapper)
      .toConstantValue(new McpTokenHttpMapper())
    container
      .bind<MapperInterface<Webhook, TypeORMWebhook>>(TYPES.Auth_WebhookPersistenceMapper)
      .toConstantValue(new WebhookPersistenceMapper())
    container
      .bind<MapperInterface<Webhook, WebhookHttpProjection>>(TYPES.Auth_WebhookHttpMapper)
      .toConstantValue(new WebhookHttpMapper())
    container
      .bind<MapperInterface<AuditLogEntry, TypeORMAuditLogEntry>>(TYPES.Auth_AuditLogEntryPersistenceMapper)
      .toConstantValue(new AuditLogEntryPersistenceMapper())
    container
      .bind<MapperInterface<AuditLogEntry, AuditLogEntryHttpProjection>>(TYPES.Auth_AuditLogEntryHttpMapper)
      .toConstantValue(new AuditLogEntryHttpMapper())
    container
      .bind<MapperInterface<Share, TypeORMShare>>(TYPES.Auth_SharePersistenceMapper)
      .toConstantValue(new SharePersistenceMapper())
    container
      .bind<MapperInterface<Share, ShareHttpProjection>>(TYPES.Auth_ShareHttpMapper)
      .toConstantValue(new ShareHttpMapper())
    container
      .bind<MapperInterface<Group, TypeORMGroup>>(TYPES.Auth_GroupPersistenceMapper)
      .toConstantValue(new GroupPersistenceMapper())
    container
      .bind<MapperInterface<Group, GroupHttpProjection>>(TYPES.Auth_GroupHttpMapper)
      .toConstantValue(new GroupHttpMapper())
    container
      .bind<MapperInterface<DeadManSwitch, TypeORMDeadManSwitch>>(TYPES.Auth_DeadManSwitchPersistenceMapper)
      .toConstantValue(new DeadManSwitchPersistenceMapper())
    container
      .bind<MapperInterface<DeadManSwitch, DeadManSwitchHttpProjection>>(TYPES.Auth_DeadManSwitchHttpMapper)
      .toConstantValue(new DeadManSwitchHttpMapper())
    container
      .bind<MapperInterface<EmailReminder, TypeORMEmailReminder>>(TYPES.Auth_EmailReminderPersistenceMapper)
      .toConstantValue(new EmailReminderPersistenceMapper())
    container
      .bind<MapperInterface<EmailReminder, EmailReminderHttpProjection>>(TYPES.Auth_EmailReminderHttpMapper)
      .toConstantValue(new EmailReminderHttpMapper())
    container
      .bind<MapperInterface<TrustedDevice, TypeORMTrustedDevice>>(TYPES.Auth_TrustedDevicePersistenceMapper)
      .toConstantValue(new TrustedDevicePersistenceMapper())
    container
      .bind<MapperInterface<TrustedDevice, TrustedDeviceHttpProjection>>(TYPES.Auth_TrustedDeviceHttpMapper)
      .toConstantValue(new TrustedDeviceHttpMapper())
    container
      .bind<MapperInterface<PendingMfaApproval, TypeORMPendingMfaApproval>>(
        TYPES.Auth_PendingMfaApprovalPersistenceMapper,
      )
      .toConstantValue(new PendingMfaApprovalPersistenceMapper())
    container
      .bind<MapperInterface<PendingMfaApproval, PendingMfaApprovalHttpProjection>>(
        TYPES.Auth_PendingMfaApprovalHttpMapper,
      )
      .toConstantValue(new PendingMfaApprovalHttpMapper())
    container
      .bind<MapperInterface<AuthenticatorChallenge, TypeORMAuthenticatorChallenge>>(
        TYPES.Auth_AuthenticatorChallengePersistenceMapper,
      )
      .toConstantValue(new AuthenticatorChallengePersistenceMapper())
    container
      .bind<MapperInterface<MagicLinkToken, TypeORMMagicLinkToken>>(TYPES.Auth_MagicLinkTokenPersistenceMapper)
      .toConstantValue(new MagicLinkTokenPersistenceMapper())
    container
      .bind<MapperInterface<EmailConfirmationToken, TypeORMEmailConfirmationToken>>(
        TYPES.Auth_EmailConfirmationTokenPersistenceMapper,
      )
      .toConstantValue(new EmailConfirmationTokenPersistenceMapper())
    container
      .bind<MapperInterface<SignupInviteLink, TypeORMSignupInviteLink>>(TYPES.Auth_SignupInviteLinkPersistenceMapper)
      .toConstantValue(new SignupInviteLinkPersistenceMapper())
    container
      .bind<MapperInterface<SignupInviteUse, TypeORMSignupInviteUse>>(TYPES.Auth_SignupInviteUsePersistenceMapper)
      .toConstantValue(new SignupInviteUsePersistenceMapper())
    container
      .bind<MapperInterface<CacheEntry, TypeORMCacheEntry>>(TYPES.Auth_CacheEntryPersistenceMapper)
      .toConstantValue(new CacheEntryPersistenceMapper())
    container
      .bind<MapperInterface<SharedVaultUser, TypeORMSharedVaultUser>>(TYPES.Auth_SharedVaultUserPersistenceMapper)
      .toConstantValue(new SharedVaultUserPersistenceMapper())
    container
      .bind<MapperInterface<Setting, SettingHttpRepresentation>>(TYPES.Auth_SettingHttpMapper)
      .toConstantValue(new SettingHttpMapper())
    container
      .bind<MapperInterface<SubscriptionSetting, SubscriptionSettingHttpRepresentation>>(
        TYPES.Auth_SubscriptionSettingHttpMapper,
      )
      .toConstantValue(new SubscriptionSettingHttpMapper())
    container
      .bind<MapperInterface<Setting, TypeORMSetting>>(TYPES.Auth_SettingPersistenceMapper)
      .toConstantValue(new SettingPersistenceMapper())
    container
      .bind<MapperInterface<SubscriptionSetting, TypeORMSubscriptionSetting>>(
        TYPES.Auth_SubscriptionSettingPersistenceMapper,
      )
      .toConstantValue(new SubscriptionSettingPersistenceMapper())

    // ORM
    container
      .bind<Repository<OfflineSetting>>(TYPES.Auth_ORMOfflineSettingRepository)
      .toConstantValue(appDataSource.getRepository(OfflineSetting))
    container
      .bind<Repository<OfflineUserSubscription>>(TYPES.Auth_ORMOfflineUserSubscriptionRepository)
      .toConstantValue(appDataSource.getRepository(OfflineUserSubscription))
    container
      .bind<Repository<RevokedSession>>(TYPES.Auth_ORMRevokedSessionRepository)
      .toConstantValue(appDataSource.getRepository(RevokedSession))
    container
      .bind<Repository<Role>>(TYPES.Auth_ORMRoleRepository)
      .toConstantValue(
        authInviteTransactionAwareORMRepository(
          appDataSource.getRepository(Role),
          Role,
          authInviteEventTransactionContext,
        ),
      )
    container
      .bind<Repository<Permission>>(TYPES.Auth_ORMPermissionRepository)
      .toConstantValue(appDataSource.getRepository(Permission))
    container
      .bind<Repository<Session>>(TYPES.Auth_ORMSessionRepository)
      .toConstantValue(appDataSource.getRepository(Session))
    container
      .bind<Repository<TypeORMSetting>>(TYPES.Auth_ORMSettingRepository)
      .toConstantValue(
        authInviteTransactionAwareORMRepository(
          appDataSource.getRepository(TypeORMSetting),
          TypeORMSetting,
          authInviteEventTransactionContext,
        ),
      )
    container
      .bind<Repository<SharedSubscriptionInvitation>>(TYPES.Auth_ORMSharedSubscriptionInvitationRepository)
      .toConstantValue(
        authInviteTransactionAwareORMRepository(
          appDataSource.getRepository(SharedSubscriptionInvitation),
          SharedSubscriptionInvitation,
          authInviteEventTransactionContext,
        ),
      )
    container
      .bind<Repository<TypeORMSubscriptionSetting>>(TYPES.Auth_ORMSubscriptionSettingRepository)
      .toConstantValue(
        authInviteTransactionAwareORMRepository(
          appDataSource.getRepository(TypeORMSubscriptionSetting),
          TypeORMSubscriptionSetting,
          authInviteEventTransactionContext,
        ),
      )
    container
      .bind<Repository<User>>(TYPES.Auth_ORMUserRepository)
      .toConstantValue(
        authInviteTransactionAwareORMRepository(
          appDataSource.getRepository(User),
          User,
          authInviteEventTransactionContext,
        ),
      )
    container
      .bind<Repository<UserSubscription>>(TYPES.Auth_ORMUserSubscriptionRepository)
      .toConstantValue(
        authInviteTransactionAwareORMRepository(
          appDataSource.getRepository(UserSubscription),
          UserSubscription,
          authInviteEventTransactionContext,
        ),
      )
    container
      .bind<Repository<TypeORMInviteEventOutbox>>(TYPES.Auth_ORMInviteEventOutboxRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMInviteEventOutbox))
    container
      .bind<Repository<TypeORMSessionTrace>>(TYPES.Auth_ORMSessionTraceRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMSessionTrace))
    container
      .bind<Repository<TypeORMAuthenticator>>(TYPES.Auth_ORMAuthenticatorRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMAuthenticator))
    container
      .bind<Repository<TypeORMAppPassword>>(TYPES.Auth_ORMAppPasswordRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMAppPassword))
    container
      .bind<Repository<TypeORMMcpToken>>(TYPES.Auth_ORMMcpTokenRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMMcpToken))
    container
      .bind<Repository<TypeORMWebhook>>(TYPES.Auth_ORMWebhookRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMWebhook))
    container
      .bind<Repository<TypeORMAuditLogEntry>>(TYPES.Auth_ORMAuditLogRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMAuditLogEntry))
    container
      .bind<Repository<TypeORMShare>>(TYPES.Auth_ORMShareRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMShare))
    container
      .bind<Repository<TypeORMGroup>>(TYPES.Auth_ORMGroupRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMGroup))
    container
      .bind<Repository<TypeORMGroupRole>>(TYPES.Auth_ORMGroupRoleRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMGroupRole))
    container
      .bind<Repository<TypeORMUserGroup>>(TYPES.Auth_ORMUserGroupRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMUserGroup))
    container
      .bind<Repository<TypeORMDeadManSwitch>>(TYPES.Auth_ORMDeadManSwitchRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMDeadManSwitch))
    container
      .bind<Repository<TypeORMEmailReminder>>(TYPES.Auth_ORMEmailReminderRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMEmailReminder))
    container
      .bind<Repository<TypeORMTrustedDevice>>(TYPES.Auth_ORMTrustedDeviceRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMTrustedDevice))
    container
      .bind<Repository<TypeORMPendingMfaApproval>>(TYPES.Auth_ORMPendingMfaApprovalRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMPendingMfaApproval))
    container
      .bind<Repository<TypeORMAuthenticatorChallenge>>(TYPES.Auth_ORMAuthenticatorChallengeRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMAuthenticatorChallenge))
    container
      .bind<Repository<TypeORMMagicLinkToken>>(TYPES.Auth_ORMMagicLinkTokenRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMMagicLinkToken))
    container
      .bind<Repository<TypeORMEmailConfirmationToken>>(TYPES.Auth_ORMEmailConfirmationTokenRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMEmailConfirmationToken))
    container
      .bind<Repository<TypeORMSignupInviteLink>>(TYPES.Auth_ORMSignupInviteLinkRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMSignupInviteLink))
    container
      .bind<Repository<TypeORMSignupInviteUse>>(TYPES.Auth_ORMSignupInviteUseRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMSignupInviteUse))
    container
      .bind<Repository<TypeORMCacheEntry>>(TYPES.Auth_ORMCacheEntryRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMCacheEntry))
    container
      .bind<Repository<TypeORMSharedVaultUser>>(TYPES.Auth_ORMSharedVaultUserRepository)
      .toConstantValue(appDataSource.getRepository(TypeORMSharedVaultUser))

    // Repositories
    container.bind<SessionRepositoryInterface>(TYPES.Auth_SessionRepository).to(TypeORMSessionRepository)
    container
      .bind<RevokedSessionRepositoryInterface>(TYPES.Auth_RevokedSessionRepository)
      .to(TypeORMRevokedSessionRepository)
    container.bind<UserRepositoryInterface>(TYPES.Auth_UserRepository).to(TypeORMUserRepository)
    container
      .bind<SettingRepositoryInterface>(TYPES.Auth_SettingRepository)
      .toConstantValue(
        new TypeORMSettingRepository(
          container.get<Repository<TypeORMSetting>>(TYPES.Auth_ORMSettingRepository),
          container.get<MapperInterface<Setting, TypeORMSetting>>(TYPES.Auth_SettingPersistenceMapper),
        ),
      )
    container
      .bind<SubscriptionSettingRepositoryInterface>(TYPES.Auth_SubscriptionSettingRepository)
      .toConstantValue(
        new TypeORMSubscriptionSettingRepository(
          container.get<Repository<TypeORMSubscriptionSetting>>(TYPES.Auth_ORMSubscriptionSettingRepository),
          container.get<MapperInterface<SubscriptionSetting, TypeORMSubscriptionSetting>>(
            TYPES.Auth_SubscriptionSettingPersistenceMapper,
          ),
        ),
      )
    container
      .bind<OfflineSettingRepositoryInterface>(TYPES.Auth_OfflineSettingRepository)
      .to(TypeORMOfflineSettingRepository)
    container.bind<RoleRepositoryInterface>(TYPES.Auth_RoleRepository).to(TypeORMRoleRepository)
    container.bind<PermissionRepositoryInterface>(TYPES.Auth_PermissionRepository).to(TypeORMPermissionRepository)
    container
      .bind<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository)
      .to(TypeORMUserSubscriptionRepository)
    container
      .bind<OfflineUserSubscriptionRepositoryInterface>(TYPES.Auth_OfflineUserSubscriptionRepository)
      .to(TypeORMOfflineUserSubscriptionRepository)
    container
      .bind<SharedSubscriptionInvitationRepositoryInterface>(TYPES.Auth_SharedSubscriptionInvitationRepository)
      .to(TypeORMSharedSubscriptionInvitationRepository)
    container
      .bind<InviteEventOutboxRepositoryInterface>(TYPES.Auth_InviteEventOutboxRepository)
      .toConstantValue(
        new TypeORMInviteEventOutboxRepository(
          container.get<Repository<TypeORMInviteEventOutbox>>(TYPES.Auth_ORMInviteEventOutboxRepository),
          authInviteEventTransactionContext,
        ),
      )
    container
      .bind<InviteEventOutboxDispatcher>(TYPES.Auth_InviteEventOutboxDispatcher)
      .toConstantValue(
        new InviteEventOutboxDispatcher(
          container.get<InviteEventOutboxRepositoryInterface>(TYPES.Auth_InviteEventOutboxRepository),
          container.get<DomainEventPublisherInterface>(TYPES.Auth_RawDomainEventPublisher),
          { logger: container.get<winston.Logger>(TYPES.Auth_Logger) },
        ),
      )
    container
      .bind<AuthInviteRealtimeOutboxProducer>(TYPES.Auth_InviteRealtimeOutboxProducer)
      .toConstantValue(
        new AuthInviteRealtimeOutboxProducer(
          container.get<InviteEventOutboxRepositoryInterface>(TYPES.Auth_InviteEventOutboxRepository),
          authInviteEventTransactionContext,
        ),
      )
    container
      .bind<AuthInviteMutationTransactionRunner>(TYPES.Auth_InviteMutationTransactionRunner)
      .toConstantValue(
        new AuthInviteMutationTransactionRunner(
          appDataSource.dataSource,
          authInviteEventTransactionContext,
          container.get<InviteEventOutboxDispatcher>(TYPES.Auth_InviteEventOutboxDispatcher),
        ),
      )
    container
      .bind<AuthInviteAffectedUserResolver>(TYPES.Auth_InviteAffectedUserResolver)
      .toConstantValue(
        new AuthInviteAffectedUserResolver(container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository)),
      )
    if (!isConfiguredForCli) {
      const inviteEventOutboxDispatcher = container.get<InviteEventOutboxDispatcher>(
        TYPES.Auth_InviteEventOutboxDispatcher,
      )
      inviteEventOutboxDispatcher.start()
      // The dispatcher polls for both the server and the worker process, so its
      // shutdown belongs with the start rather than in a single bin entrypoint.
      // `once` keeps repeated container loads (home-server, tests) from stacking
      // listeners; awaiting stop() lets an in-flight publish finish before the
      // data source it writes through is torn down.
      const stopInviteEventOutboxDispatcher = (): void => {
        void inviteEventOutboxDispatcher.stop()
      }
      process.once('SIGTERM', stopInviteEventOutboxDispatcher)
      process.once('SIGINT', stopInviteEventOutboxDispatcher)
    }
    container
      .bind<SessionTraceRepositoryInterface>(TYPES.Auth_SessionTraceRepository)
      .toConstantValue(
        new TypeORMSessionTraceRepository(
          container.get<Repository<TypeORMSessionTrace>>(TYPES.Auth_ORMSessionTraceRepository),
          container.get<MapperInterface<SessionTrace, TypeORMSessionTrace>>(TYPES.Auth_SessionTracePersistenceMapper),
          container.get<TimerInterface>(TYPES.Auth_Timer),
        ),
      )
    container
      .bind<AuthenticatorRepositoryInterface>(TYPES.Auth_AuthenticatorRepository)
      .toConstantValue(
        new TypeORMAuthenticatorRepository(
          container.get(TYPES.Auth_ORMAuthenticatorRepository),
          container.get(TYPES.Auth_AuthenticatorPersistenceMapper),
        ),
      )
    container
      .bind<AppPasswordRepositoryInterface>(TYPES.Auth_AppPasswordRepository)
      .toConstantValue(
        new TypeORMAppPasswordRepository(
          container.get(TYPES.Auth_ORMAppPasswordRepository),
          container.get(TYPES.Auth_AppPasswordPersistenceMapper),
        ),
      )
    container
      .bind<McpTokenRepositoryInterface>(TYPES.Auth_McpTokenRepository)
      .toConstantValue(
        new TypeORMMcpTokenRepository(
          container.get(TYPES.Auth_ORMMcpTokenRepository),
          container.get(TYPES.Auth_McpTokenPersistenceMapper),
        ),
      )
    container
      .bind<WebhookRepositoryInterface>(TYPES.Auth_WebhookRepository)
      .toConstantValue(
        new TypeORMWebhookRepository(
          container.get(TYPES.Auth_ORMWebhookRepository),
          container.get(TYPES.Auth_WebhookPersistenceMapper),
        ),
      )
    container
      .bind<AuditLogRepositoryInterface>(TYPES.Auth_AuditLogRepository)
      .toConstantValue(
        new TypeORMAuditLogRepository(
          container.get(TYPES.Auth_ORMAuditLogRepository),
          container.get(TYPES.Auth_AuditLogEntryPersistenceMapper),
        ),
      )
    container
      .bind<AuditLogWriterInterface>(TYPES.Auth_AuditLogWriter)
      .toConstantValue(
        new AuditLogWriter(
          container.get(TYPES.Auth_AuditLogRepository),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<ShareRepositoryInterface>(TYPES.Auth_ShareRepository)
      .toConstantValue(
        new TypeORMShareRepository(
          container.get(TYPES.Auth_ORMShareRepository),
          container.get(TYPES.Auth_SharePersistenceMapper),
        ),
      )
    container
      .bind<GroupRepositoryInterface>(TYPES.Auth_GroupRepository)
      .toConstantValue(
        new TypeORMGroupRepository(
          container.get(TYPES.Auth_ORMGroupRepository),
          container.get(TYPES.Auth_ORMGroupRoleRepository),
          container.get(TYPES.Auth_ORMUserGroupRepository),
          container.get(TYPES.Auth_GroupPersistenceMapper),
        ),
      )
    container
      .bind<DeadManSwitchRepositoryInterface>(TYPES.Auth_DeadManSwitchRepository)
      .toConstantValue(
        new TypeORMDeadManSwitchRepository(
          container.get(TYPES.Auth_ORMDeadManSwitchRepository),
          container.get(TYPES.Auth_DeadManSwitchPersistenceMapper),
        ),
      )
    container
      .bind<EmailReminderRepositoryInterface>(TYPES.Auth_EmailReminderRepository)
      .toConstantValue(
        new TypeORMEmailReminderRepository(
          container.get(TYPES.Auth_ORMEmailReminderRepository),
          container.get(TYPES.Auth_EmailReminderPersistenceMapper),
        ),
      )
    container
      .bind<TrustedDeviceRepositoryInterface>(TYPES.Auth_TrustedDeviceRepository)
      .toConstantValue(
        new TypeORMTrustedDeviceRepository(
          container.get(TYPES.Auth_ORMTrustedDeviceRepository),
          container.get(TYPES.Auth_TrustedDevicePersistenceMapper),
        ),
      )
    container
      .bind<PendingMfaApprovalRepositoryInterface>(TYPES.Auth_PendingMfaApprovalRepository)
      .toConstantValue(
        new TypeORMPendingMfaApprovalRepository(
          container.get(TYPES.Auth_ORMPendingMfaApprovalRepository),
          container.get(TYPES.Auth_PendingMfaApprovalPersistenceMapper),
        ),
      )
    container
      .bind<AuthenticatorChallengeRepositoryInterface>(TYPES.Auth_AuthenticatorChallengeRepository)
      .toConstantValue(
        new TypeORMAuthenticatorChallengeRepository(
          container.get(TYPES.Auth_ORMAuthenticatorChallengeRepository),
          container.get(TYPES.Auth_AuthenticatorChallengePersistenceMapper),
        ),
      )
    container
      .bind<MagicLinkTokenRepositoryInterface>(TYPES.Auth_MagicLinkTokenRepository)
      .toConstantValue(
        new TypeORMMagicLinkTokenRepository(
          container.get(TYPES.Auth_ORMMagicLinkTokenRepository),
          container.get(TYPES.Auth_MagicLinkTokenPersistenceMapper),
        ),
      )
    container
      .bind<EmailConfirmationTokenRepositoryInterface>(TYPES.Auth_EmailConfirmationTokenRepository)
      .toConstantValue(
        new TypeORMEmailConfirmationTokenRepository(
          container.get(TYPES.Auth_ORMEmailConfirmationTokenRepository),
          container.get(TYPES.Auth_EmailConfirmationTokenPersistenceMapper),
        ),
      )
    container
      .bind<SignupInviteLinkRepositoryInterface>(TYPES.Auth_SignupInviteLinkRepository)
      .toConstantValue(
        new TypeORMSignupInviteLinkRepository(
          container.get(TYPES.Auth_ORMSignupInviteLinkRepository),
          container.get(TYPES.Auth_SignupInviteLinkPersistenceMapper),
        ),
      )
    container
      .bind<SignupInviteUseRepositoryInterface>(TYPES.Auth_SignupInviteUseRepository)
      .toConstantValue(
        new TypeORMSignupInviteUseRepository(
          container.get(TYPES.Auth_ORMSignupInviteUseRepository),
          container.get(TYPES.Auth_SignupInviteUsePersistenceMapper),
        ),
      )
    container
      .bind<CacheEntryRepositoryInterface>(TYPES.Auth_CacheEntryRepository)
      .toConstantValue(
        new TypeORMCacheEntryRepository(
          container.get(TYPES.Auth_ORMCacheEntryRepository),
          container.get(TYPES.Auth_CacheEntryPersistenceMapper),
        ),
      )
    container
      .bind<SharedVaultUserRepositoryInterface>(TYPES.Auth_SharedVaultUserRepository)
      .toConstantValue(
        new TypeORMSharedVaultUserRepository(
          container.get<Repository<TypeORMSharedVaultUser>>(TYPES.Auth_ORMSharedVaultUserRepository),
          container.get<MapperInterface<SharedVaultUser, TypeORMSharedVaultUser>>(
            TYPES.Auth_SharedVaultUserPersistenceMapper,
          ),
        ),
      )

    // Projectors
    container.bind<SessionProjector>(TYPES.Auth_SessionProjector).to(SessionProjector)
    container.bind<UserProjector>(TYPES.Auth_UserProjector).to(UserProjector)
    container.bind<RoleProjector>(TYPES.Auth_RoleProjector).to(RoleProjector)
    container.bind<PermissionProjector>(TYPES.Auth_PermissionProjector).to(PermissionProjector)

    // env vars
    container.bind(TYPES.Auth_JWT_SECRET).toConstantValue(env.get('JWT_SECRET'))
    container.bind(TYPES.Auth_LEGACY_JWT_SECRET).toConstantValue(env.get('LEGACY_JWT_SECRET', true))
    container.bind(TYPES.Auth_AUTH_JWT_SECRET).toConstantValue(env.get('AUTH_JWT_SECRET'))
    container
      .bind(TYPES.Auth_AUTH_JWT_TTL)
      .toConstantValue(env.get('AUTH_JWT_TTL', true) ? +env.get('AUTH_JWT_TTL') : 60_000)
    container.bind(TYPES.Auth_VALET_TOKEN_SECRET).toConstantValue(env.get('VALET_TOKEN_SECRET', true))
    container
      .bind(TYPES.Auth_VALET_TOKEN_TTL)
      .toConstantValue(env.get('VALET_TOKEN_TTL', true) ? +env.get('VALET_TOKEN_TTL', true) : 7200)
    container
      .bind(TYPES.Auth_WEB_SOCKET_CONNECTION_TOKEN_SECRET)
      .toConstantValue(env.get('WEB_SOCKET_CONNECTION_TOKEN_SECRET', true))
    container.bind(TYPES.Auth_ENCRYPTION_SERVER_KEY).toConstantValue(env.get('ENCRYPTION_SERVER_KEY'))
    container
      .bind(TYPES.Auth_ACCESS_TOKEN_AGE)
      .toConstantValue(env.get('ACCESS_TOKEN_AGE', true) ? +env.get('ACCESS_TOKEN_AGE', true) : 5184000)
    container
      .bind(TYPES.Auth_REFRESH_TOKEN_AGE)
      .toConstantValue(env.get('REFRESH_TOKEN_AGE', true) ? +env.get('REFRESH_TOKEN_AGE', true) : 31556926)
    container
      .bind(TYPES.Auth_MAX_LOGIN_ATTEMPTS)
      .toConstantValue(env.get('MAX_LOGIN_ATTEMPTS', true) ? +env.get('MAX_LOGIN_ATTEMPTS', true) : 6)
    container
      .bind(TYPES.Auth_MAX_CAPTCHA_LOGIN_ATTEMPTS)
      .toConstantValue(env.get('MAX_CAPTCHA_LOGIN_ATTEMPTS', true) ? +env.get('MAX_CAPTCHA_LOGIN_ATTEMPTS', true) : 6)
    container
      .bind(TYPES.Auth_FAILED_LOGIN_LOCKOUT)
      .toConstantValue(env.get('FAILED_LOGIN_LOCKOUT', true) ? +env.get('FAILED_LOGIN_LOCKOUT', true) : 3600)
    container
      .bind(TYPES.Auth_FAILED_LOGIN_CAPTCHA_LOCKOUT)
      .toConstantValue(
        env.get('FAILED_LOGIN_CAPTCHA_LOCKOUT', true) ? +env.get('FAILED_LOGIN_CAPTCHA_LOCKOUT', true) : 86400,
      )
    container.bind(TYPES.Auth_PSEUDO_KEY_PARAMS_KEY).toConstantValue(env.get('PSEUDO_KEY_PARAMS_KEY'))
    container
      .bind(TYPES.Auth_EPHEMERAL_SESSION_AGE)
      .toConstantValue(env.get('EPHEMERAL_SESSION_AGE', true) ? +env.get('EPHEMERAL_SESSION_AGE', true) : 259200)
    // Tolerance (in seconds) added to the configured access-token age when deciding
    // whether a session's access expiration is "longer than current configuration".
    // Prevents freshly created sessions from being treated as stale right after issuance.
    container
      .bind(TYPES.Auth_SESSION_FRESHNESS_BUFFER)
      .toConstantValue(env.get('SESSION_FRESHNESS_BUFFER', true) ? +env.get('SESSION_FRESHNESS_BUFFER', true) : 10)
    // How long (in seconds) the previous access/refresh tokens remain accepted after a
    // session refresh, so concurrent in-flight requests during a refresh don't 401.
    container
      .bind(TYPES.Auth_COOLDOWN_SESSION_TOKENS_TTL)
      .toConstantValue(
        env.get('COOLDOWN_SESSION_TOKENS_TTL', true) ? +env.get('COOLDOWN_SESSION_TOKENS_TTL', true) : 120,
      )
    container.bind(TYPES.Auth_REDIS_URL).toConstantValue(env.get('REDIS_URL', true))
    container
      .bind(TYPES.Auth_DISABLE_USER_REGISTRATION)
      .toConstantValue(env.get('DISABLE_USER_REGISTRATION', true) === 'true')
    // Standard Red Notes: operator switch for "multiple accounts per email"
    // (workspaces). Default OFF. When OFF the workspace concept is invisible and
    // behavior is identical to before; the users.workspace_identifier column
    // simply defaults to 'default' at the DB level.
    container
      .bind<boolean>(TYPES.Auth_WORKSPACES_PER_EMAIL_ENABLED)
      .toConstantValue(env.get('WORKSPACES_PER_EMAIL_ENABLED', true) === 'true')
    container.bind(TYPES.Auth_SNS_AWS_REGION).toConstantValue(env.get('SNS_AWS_REGION', true))
    container.bind(TYPES.Auth_SQS_QUEUE_URL).toConstantValue(env.get('SQS_QUEUE_URL', true))
    container.bind(TYPES.Auth_VERSION).toConstantValue(env.get('VERSION', true) ?? 'development')
    container
      .bind(TYPES.Auth_SESSION_TRACE_DAYS_TTL)
      .toConstantValue(env.get('SESSION_TRACE_DAYS_TTL', true) ? +env.get('SESSION_TRACE_DAYS_TTL', true) : 90)
    container
      .bind(TYPES.Auth_U2F_RELYING_PARTY_NAME)
      .toConstantValue(env.get('U2F_RELYING_PARTY_NAME', true) ?? 'Standard Notes')
    container
      .bind(TYPES.Auth_U2F_RELYING_PARTY_ID)
      .toConstantValue(env.get('U2F_RELYING_PARTY_ID', true) ?? 'app.standardnotes.com')
    container
      .bind(TYPES.Auth_U2F_EXPECTED_ORIGIN)
      .toConstantValue(
        env.get('U2F_EXPECTED_ORIGIN', true)
          ? env.get('U2F_EXPECTED_ORIGIN', true).split(',')
          : ['https://app.standardnotes.com'],
      )
    container
      .bind(TYPES.Auth_U2F_REQUIRE_USER_VERIFICATION)
      .toConstantValue(env.get('U2F_REQUIRE_USER_VERIFICATION', true) === 'true')
    container.bind(TYPES.Auth_SMTP_HOST).toConstantValue(env.get('SMTP_HOST', true))
    container.bind(TYPES.Auth_SMTP_PORT).toConstantValue(env.get('SMTP_PORT', true) ? +env.get('SMTP_PORT', true) : 587)
    container.bind(TYPES.Auth_SMTP_USER).toConstantValue(env.get('SMTP_USER', true))
    container.bind(TYPES.Auth_SMTP_PASS).toConstantValue(env.get('SMTP_PASS', true))
    container.bind(TYPES.Auth_SMTP_FROM).toConstantValue(env.get('SMTP_FROM', true))
    const smtpSecureValue = env.get('SMTP_SECURE', true)
    const smtpTlsMode = ['true', '1', 'yes', 'on'].includes((env.get('SMTP_ALLOW_INSECURE', true) || '').toLowerCase())
      ? ('insecure' as const)
      : smtpSecureValue
        ? ['true', '1', 'yes', 'on'].includes(smtpSecureValue.toLowerCase())
          ? ('implicit' as const)
          : ('starttls' as const)
        : undefined
    const emailDeliveryOverlayReader = new ServerSettingsOverlayReader(
      env.get('SERVER_SETTINGS_PATH', true) || undefined,
    )
    container.bind(TYPES.Auth_FILE_UPLOAD_PATH).toConstantValue(env.get('FILE_UPLOAD_PATH', true))
    container.bind(TYPES.Auth_S3_BACKUP_BUCKET_NAME).toConstantValue(env.get('S3_BACKUP_BUCKET_NAME', true))
    const emailAttachmentMaximumBytes = parseEmailAttachmentMaximumBytes(
      env.get('EMAIL_ATTACHMENT_MAX_BYTE_SIZE', true),
    )
    container.bind<number>(TYPES.Auth_EMAIL_ATTACHMENT_MAX_BYTE_SIZE).toConstantValue(emailAttachmentMaximumBytes)
    // Standard Red Notes: operator switch for scheduled email backups. Default OFF.
    // The trigger job additionally requires SMTP to be configured before it will
    // generate/send anything (see TriggerEmailBackupForAllUsers).
    container
      .bind<boolean>(TYPES.Auth_EMAIL_BACKUPS_ENABLED)
      .toConstantValue(env.get('EMAIL_BACKUPS_ENABLED', true) === 'true')
    // Standard Red Notes: operator switch for scheduled Nextcloud (WebDAV) backups.
    // Default OFF. Per-user completeness (URL + app password + frequency) is enforced
    // in TriggerNextcloudBackupForUser; this switch is the instance-wide kill switch.
    container
      .bind<boolean>(TYPES.Auth_NEXTCLOUD_BACKUPS_ENABLED)
      .toConstantValue(env.get('NEXTCLOUD_BACKUPS_ENABLED', true) === 'true')
    // Standard Red Notes: operator switch for scheduled email reminders. Default OFF.
    // The trigger job additionally requires SMTP to be configured and the per-user
    // EMAIL_REMINDERS_ENABLED setting before it will send anything.
    container
      .bind<boolean>(TYPES.Auth_EMAIL_REMINDERS_ENABLED)
      .toConstantValue(env.get('EMAIL_REMINDERS_ENABLED', true) === 'true')
    // "No outgoing-email records" mode. When ON, a sent reminder's row is DELETED
    // (no sent-history kept) and the recipient/message are not logged. Default OFF.
    container
      .bind<boolean>(TYPES.Auth_EMAIL_REMINDER_NO_RECORDS)
      .toConstantValue(env.get('EMAIL_REMINDER_NO_RECORDS', true) === 'true')
    // Standard Red Notes: operator-configurable cap on the number of server-stored
    // email reminders per user (bounds persisted rows + reminder-cron scan work).
    // Default 100. A value <= 0 disables the cap (unlimited, prior behaviour).
    container
      .bind<number>(TYPES.Auth_MAX_EMAIL_REMINDERS_PER_USER)
      .toConstantValue(
        env.get('MAX_EMAIL_REMINDERS_PER_USER', true) ? +env.get('MAX_EMAIL_REMINDERS_PER_USER', true) : 100,
      )
    const emailLogger = container.get<winston.Logger>(TYPES.Auth_Logger)
    const stableEmailQueueSecret =
      env.get('EMAIL_DELIVERY_ENCRYPTION_KEY', true) || container.get<string>(TYPES.Auth_ENCRYPTION_SERVER_KEY)
    const emailQueueProducerOptions = emailQueueProducerOptionsFromEnvironment({
      maxAttempts: env.get('EMAIL_QUEUE_MAX_ATTEMPTS', true) || undefined,
      retentionMs: env.get('EMAIL_QUEUE_RETENTION_MS', true) || undefined,
      maxJobBytes: env.get('EMAIL_QUEUE_MAX_JOB_BYTES', true) || undefined,
      maxTotalBytes: env.get('EMAIL_QUEUE_MAX_TOTAL_BYTES', true) || undefined,
    })
    const emailQueueRedis = container.isBound(TYPES.Auth_Redis) ? container.get<Redis>(TYPES.Auth_Redis) : undefined
    if (
      emailQueueRedis &&
      !isRedisClusterTopology(emailQueueRedis as unknown as { nodes?(role?: string): unknown[] }) &&
      emailAttachmentMaximumBytes > maximumRawAttachmentBytesForQueue(emailQueueProducerOptions.maxJobBytes)
    ) {
      throw new Error(
        'EMAIL_ATTACHMENT_MAX_BYTE_SIZE is too large for EMAIL_QUEUE_MAX_JOB_BYTES after queue encoding overhead.',
      )
    }
    const legacyAccountSmtpSender = new SmtpEmailSender(
      {
        host: container.get(TYPES.Auth_SMTP_HOST),
        port: container.get(TYPES.Auth_SMTP_PORT),
        user: container.get(TYPES.Auth_SMTP_USER),
        pass: container.get(TYPES.Auth_SMTP_PASS),
        from: container.get(TYPES.Auth_SMTP_FROM),
        tlsMode: smtpTlsMode,
      },
      emailLogger,
      () => emailDeliveryOverlayReader.emailDelivery(),
    )
    container.bind<EmailSenderInterface>(TYPES.Auth_EmailSender).toConstantValue(
      createAuthEmailSender({
        redis: emailQueueRedis,
        stableServerEncryptionSecret: stableEmailQueueSecret,
        legacySmtpSender: legacyAccountSmtpSender,
        logger: emailLogger,
        defaultSource: 'account',
        producerOptions: emailQueueProducerOptions,
      }),
    )
    container
      .bind<BackupAttachmentStorageInterface>(TYPES.Auth_BackupAttachmentStorage)
      .toConstantValue(
        new FSOrS3BackupAttachmentStorage(
          container.get(TYPES.Auth_FILE_UPLOAD_PATH),
          container.get(TYPES.Auth_S3_BACKUP_BUCKET_NAME),
          container.isBound(TYPES.Auth_S3) ? container.get<S3Client>(TYPES.Auth_S3) : undefined,
          container.get<number>(TYPES.Auth_EMAIL_ATTACHMENT_MAX_BYTE_SIZE),
        ),
      )
    // Standard Red Notes: a dedicated sender for email reminders so operators can
    // use a distinct From address. Sender resolution: EMAIL_REMINDER_FROM if set,
    // otherwise fall back to the shared SMTP_FROM. Same SMTP transport/credentials.
    const legacyReminderSmtpSender = new SmtpEmailSender(
      {
        host: container.get(TYPES.Auth_SMTP_HOST),
        port: container.get(TYPES.Auth_SMTP_PORT),
        user: container.get(TYPES.Auth_SMTP_USER),
        pass: container.get(TYPES.Auth_SMTP_PASS),
        from: env.get('EMAIL_REMINDER_FROM', true) || container.get(TYPES.Auth_SMTP_FROM),
        tlsMode: smtpTlsMode,
      },
      emailLogger,
      () => emailDeliveryOverlayReader.emailDelivery(),
    )
    container.bind<EmailSenderInterface>(TYPES.Auth_EmailReminderSender).toConstantValue(
      createAuthEmailSender({
        redis: emailQueueRedis,
        stableServerEncryptionSecret: stableEmailQueueSecret,
        legacySmtpSender: legacyReminderSmtpSender,
        logger: emailLogger,
        defaultSource: 'reminder',
        producerOptions: emailQueueProducerOptions,
      }),
    )
    container
      .bind(TYPES.Auth_READONLY_USERS)
      .toConstantValue(env.get('READONLY_USERS', true) ? env.get('READONLY_USERS', true).split(',') : [])
    container.bind(TYPES.Auth_CAPTCHA_SERVER_URL).toConstantValue(captchaServerUrl)
    container.bind(TYPES.Auth_CAPTCHA_UI_URL).toConstantValue(captchaUIUrl)
    container.bind<boolean>(TYPES.Auth_HUMAN_VERIFICATION_ENABLED).toConstantValue(!!captchaServerUrl && !!captchaUIUrl)
    container.bind<boolean>(TYPES.Auth_FORCE_LEGACY_SESSIONS).toConstantValue(env.get('E2E_TESTING', true) === 'true')

    if (isConfiguredForInMemoryCache) {
      container
        .bind<PKCERepositoryInterface>(TYPES.Auth_PKCERepository)
        .toConstantValue(
          new TypeORMPKCERepository(
            container.get(TYPES.Auth_CacheEntryRepository),
            container.get(TYPES.Auth_Logger),
            container.get(TYPES.Auth_Timer),
          ),
        )
      container
        .bind<ProofOfWorkChallengeRepositoryInterface>(TYPES.Auth_ProofOfWorkChallengeRepository)
        .toConstantValue(
          new TypeORMProofOfWorkChallengeRepository(
            container.get(TYPES.Auth_CacheEntryRepository),
            container.get(TYPES.Auth_Timer),
          ),
        )
      container
        .bind<LockRepositoryInterface>(TYPES.Auth_LockRepository)
        .toConstantValue(
          new TypeORMLockRepository(
            container.get(TYPES.Auth_CacheEntryRepository),
            container.get(TYPES.Auth_Timer),
            container.get(TYPES.Auth_MAX_LOGIN_ATTEMPTS),
            container.get(TYPES.Auth_FAILED_LOGIN_LOCKOUT),
            container.get(TYPES.Auth_FAILED_LOGIN_CAPTCHA_LOCKOUT),
          ),
        )
      container
        .bind<EphemeralSessionRepositoryInterface>(TYPES.Auth_EphemeralSessionRepository)
        .toConstantValue(
          new TypeORMEphemeralSessionRepository(
            container.get(TYPES.Auth_CacheEntryRepository),
            container.get(TYPES.Auth_EPHEMERAL_SESSION_AGE),
            container.get(TYPES.Auth_Timer),
          ),
        )
      container
        .bind<OfflineSubscriptionTokenRepositoryInterface>(TYPES.Auth_OfflineSubscriptionTokenRepository)
        .toConstantValue(
          new TypeORMOfflineSubscriptionTokenRepository(
            container.get(TYPES.Auth_CacheEntryRepository),
            container.get(TYPES.Auth_Timer),
          ),
        )
      container
        .bind<SubscriptionTokenRepositoryInterface>(TYPES.Auth_SubscriptionTokenRepository)
        .toConstantValue(
          new TypeORMSubscriptionTokenRepository(
            container.get(TYPES.Auth_CacheEntryRepository),
            container.get(TYPES.Auth_Timer),
          ),
        )
      container
        .bind<SessionTokensCooldownRepositoryInterface>(TYPES.Auth_SessionTokensCooldownRepository)
        .toConstantValue(new InMemorySessionTokensCooldownRepository(container.get<winston.Logger>(TYPES.Auth_Logger)))
      container
        .bind<MfaSecretRepositoryInterface>(TYPES.Auth_MfaSecretRepository)
        .toConstantValue(
          new TypeORMMfaSecretRepository(
            container.get(TYPES.Auth_CacheEntryRepository),
            container.get(TYPES.Auth_Timer),
          ),
        )
    } else {
      container.bind<PKCERepositoryInterface>(TYPES.Auth_PKCERepository).to(RedisPKCERepository)
      container
        .bind<ProofOfWorkChallengeRepositoryInterface>(TYPES.Auth_ProofOfWorkChallengeRepository)
        .to(RedisProofOfWorkChallengeRepository)
      container
        .bind<LockRepositoryInterface>(TYPES.Auth_LockRepository)
        .toConstantValue(
          new RedisLockRepository(
            container.get<Redis>(TYPES.Auth_Redis),
            container.get<number>(TYPES.Auth_MAX_LOGIN_ATTEMPTS),
            container.get<number>(TYPES.Auth_FAILED_LOGIN_LOCKOUT),
            container.get<number>(TYPES.Auth_FAILED_LOGIN_CAPTCHA_LOCKOUT),
          ),
        )
      container.bind<MfaSecretRepositoryInterface>(TYPES.Auth_MfaSecretRepository).to(RedisMfaSecretRepository)
      container
        .bind<EphemeralSessionRepositoryInterface>(TYPES.Auth_EphemeralSessionRepository)
        .to(RedisEphemeralSessionRepository)
      container
        .bind<OfflineSubscriptionTokenRepositoryInterface>(TYPES.Auth_OfflineSubscriptionTokenRepository)
        .to(RedisOfflineSubscriptionTokenRepository)
      container
        .bind<SubscriptionTokenRepositoryInterface>(TYPES.Auth_SubscriptionTokenRepository)
        .to(RedisSubscriptionTokenRepository)
      container
        .bind<SessionTokensCooldownRepositoryInterface>(TYPES.Auth_SessionTokensCooldownRepository)
        .toConstantValue(new RedisSessionTokensCooldownRepository(container.get<Redis>(TYPES.Auth_Redis)))
    }

    // Standard Red Notes: proof-of-work anti-bot challenge wiring.
    //
    // SAFETY: both scopes default to DISABLED (opt-in). A stock deploy therefore
    // NEVER requires a proof, so any client that attaches none — the web/desktop
    // build before it is updated, mobile, the CLI, curl, third-party apps — can
    // always register and sign in. PoW is enabled deliberately by an admin, per
    // scope, via env (`PROOF_OF_WORK_*_ENABLED=true`) or the persisted overlay
    // (security.proofOfWork.*). The web/desktop client fully solves-and-attaches
    // the challenge when a deployment turns it on (see SessionManager); other
    // clients would need their own solver, which is why enabling is an explicit,
    // informed choice rather than the default. When enabled the difficulty knobs
    // below stay gentle (register ~12 leading-zero bits, sign-in adaptive after 3
    // failed attempts at ~16 bits). Precedence is persisted -> env -> default,
    // resolved per request (no restart needed).
    // Parse an env-supplied difficulty exactly like the persisted overlay does:
    // a valid number is clamped to 0..32 (clampDifficulty); anything unset or
    // non-numeric (NaN/invalid) falls back to the scope default. Without this an
    // env such as `PROOF_OF_WORK_*_DIFFICULTY=abc` yielded NaN (stored "NaN" ->
    // getChallengeDifficulty null -> re-issues forever, a DoS) and `=99` locked
    // the endpoint (client solver throws past MAX_DIFFICULTY).
    const baselineDifficulty = (rawValue: string, fallback: number): number => {
      if (!rawValue) {
        return fallback
      }
      const parsed = +rawValue

      return Number.isFinite(parsed) ? clampDifficulty(parsed) : fallback
    }
    const proofOfWorkBaseline: ProofOfWorkConfig = {
      register: {
        enabled: env.get('PROOF_OF_WORK_REGISTER_ENABLED', true) === 'true',
        difficulty: baselineDifficulty(env.get('PROOF_OF_WORK_REGISTER_DIFFICULTY', true), 12),
        ttlSeconds: env.get('PROOF_OF_WORK_REGISTER_TTL_SECONDS', true)
          ? +env.get('PROOF_OF_WORK_REGISTER_TTL_SECONDS', true)
          : 600,
      },
      signIn: {
        enabled: env.get('PROOF_OF_WORK_SIGNIN_ENABLED', true) === 'true',
        difficulty: baselineDifficulty(env.get('PROOF_OF_WORK_SIGNIN_DIFFICULTY', true), 16),
        ttlSeconds: env.get('PROOF_OF_WORK_SIGNIN_TTL_SECONDS', true)
          ? +env.get('PROOF_OF_WORK_SIGNIN_TTL_SECONDS', true)
          : 600,
        mode: env.get('PROOF_OF_WORK_SIGNIN_MODE', true) === 'always' ? 'always' : 'adaptive',
        adaptiveThreshold: env.get('PROOF_OF_WORK_SIGNIN_ADAPTIVE_THRESHOLD', true)
          ? +env.get('PROOF_OF_WORK_SIGNIN_ADAPTIVE_THRESHOLD', true)
          : 3,
      },
    }
    const proofOfWorkOverlayReader = new ServerSettingsOverlayReader(env.get('SERVER_SETTINGS_PATH', true) || undefined)
    container
      .bind<ProofOfWorkConfigResolverInterface>(TYPES.Auth_ProofOfWorkConfigResolver)
      .toConstantValue(
        new EnvProofOfWorkConfigResolver(proofOfWorkBaseline, () => proofOfWorkOverlayReader.proofOfWork()),
      )

    // Standard Red Notes: registration policy (default role + email-domain policy)
    // resolved per registration from the persisted admin overlay layered over the
    // REGISTRATION_* env baseline (persisted -> env -> default). Reads the SAME
    // ServerSettings overlay file the gateway admin surface writes.
    const registrationOverlayReader = new ServerSettingsOverlayReader(
      env.get('SERVER_SETTINGS_PATH', true) || undefined,
    )
    const registrationBaseline = registrationBaselineFromEnv({
      defaultRole: env.get('REGISTRATION_DEFAULT_ROLE', true) || undefined,
      domainMode: env.get('REGISTRATION_DOMAIN_MODE', true) || undefined,
      domains: env.get('REGISTRATION_DOMAINS', true) || undefined,
      // Standard Red Notes: EMAIL CONFIRMATION env baseline (part 2).
      emailConfirmationEnabled: env.get('REGISTRATION_EMAIL_CONFIRMATION', true) || undefined,
      emailConfirmationGating: env.get('REGISTRATION_EMAIL_CONFIRMATION_GATING', true) || undefined,
      emailConfirmationSubject: env.get('REGISTRATION_EMAIL_CONFIRMATION_SUBJECT', true) || undefined,
      emailConfirmationBody: env.get('REGISTRATION_EMAIL_CONFIRMATION_BODY', true) || undefined,
      emailConfirmationBaseUrl: env.get('REGISTRATION_EMAIL_CONFIRMATION_URL', true) || undefined,
    })
    container
      .bind<RegistrationConfigResolverInterface>(TYPES.Auth_RegistrationConfigResolver)
      .toConstantValue(
        new EnvRegistrationConfigResolver(registrationBaseline, () => registrationOverlayReader.registration()),
      )
    container
      .bind<RequestProofOfWorkChallenge>(TYPES.Auth_RequestProofOfWorkChallenge)
      .toConstantValue(
        new RequestProofOfWorkChallenge(
          container.get<ProofOfWorkChallengeRepositoryInterface>(TYPES.Auth_ProofOfWorkChallengeRepository),
        ),
      )
    container
      .bind<VerifyProofOfWork>(TYPES.Auth_VerifyProofOfWork)
      .toConstantValue(
        new VerifyProofOfWork(
          container.get<ProofOfWorkChallengeRepositoryInterface>(TYPES.Auth_ProofOfWorkChallengeRepository),
        ),
      )
    // Standard Red Notes: reader for the gateway's per-IP escalate flag on the
    // SHARED Redis cache. Bound only when Auth_Redis is present (the gateway and
    // auth share the same cache container); absent under the TypeORM cache
    // topology, where the gate simply never escalates on IP. The flag is
    // config-gated by the SAME adaptiveEscalation switch the gateway uses to write
    // it: persisted admin overlay wins over the RATE_LIMIT_ADAPTIVE_ESCALATION env
    // baseline, else off. Reads are per-call so an admin toggle applies live.
    const rateLimitEscalationOverlayReader = new ServerSettingsOverlayReader(
      env.get('SERVER_SETTINGS_PATH', true) || undefined,
    )
    const adaptiveEscalationEnvBaseline = env.get('RATE_LIMIT_ADAPTIVE_ESCALATION', true) === 'true'
    const ipEscalationChecker = container.isBound(TYPES.Auth_Redis)
      ? new RedisIpEscalationChecker(container.get<Redis>(TYPES.Auth_Redis), async (): Promise<boolean> => {
          const overlay = await rateLimitEscalationOverlayReader.rateLimitAdaptiveEscalation()

          return overlay ?? adaptiveEscalationEnvBaseline
        })
      : undefined
    container
      .bind<ProofOfWorkGate>(TYPES.Auth_ProofOfWorkGate)
      .toConstantValue(
        new ProofOfWorkGate(
          container.get<RequestProofOfWorkChallenge>(TYPES.Auth_RequestProofOfWorkChallenge),
          container.get<VerifyProofOfWork>(TYPES.Auth_VerifyProofOfWork),
          container.get<ProofOfWorkConfigResolverInterface>(TYPES.Auth_ProofOfWorkConfigResolver),
          container.get<LockRepositoryInterface>(TYPES.Auth_LockRepository),
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<winston.Logger>(TYPES.Auth_Logger),
          ipEscalationChecker,
        ),
      )

    container
      .bind<TraceSession>(TYPES.Auth_TraceSession)
      .toConstantValue(
        new TraceSession(
          container.get(TYPES.Auth_SessionTraceRepository),
          container.get(TYPES.Auth_Timer),
          container.get(TYPES.Auth_SESSION_TRACE_DAYS_TTL),
        ),
      )
    container
      .bind<SelectorInterface<ProtocolVersion>>(TYPES.Auth_ProtocolVersionSelector)
      .toConstantValue(new DeterministicSelector<ProtocolVersion>())
    container.bind<UAParserInstance>(TYPES.Auth_DeviceDetector).toConstantValue(new UAParser())
    container.bind<CrypterInterface>(TYPES.Auth_Crypter).to(CrypterNode)
    container
      .bind<SettingCrypterInterface>(TYPES.Auth_SettingCrypter)
      .toConstantValue(
        new SettingCrypter(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<CrypterInterface>(TYPES.Auth_Crypter),
        ),
      )
    container
      .bind<EmailBackupStateRepositoryInterface>(TYPES.Auth_EmailBackupStateRepository)
      .toConstantValue(
        new TypeORMEmailBackupStateRepository(
          appDataSource.dataSource,
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<MapperInterface<Setting, TypeORMSetting>>(TYPES.Auth_SettingPersistenceMapper),
          container.get<SettingCrypterInterface>(TYPES.Auth_SettingCrypter),
        ),
      )
    container
      .bind<VerifyUserServerPassword>(TYPES.Auth_VerifyUserServerPassword)
      .toConstantValue(new VerifyUserServerPassword(container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository)))
    container
      .bind<GetSetting>(TYPES.Auth_GetSetting)
      .toConstantValue(
        new GetSetting(
          container.get<SettingRepositoryInterface>(TYPES.Auth_SettingRepository),
          container.get<SettingCrypterInterface>(TYPES.Auth_SettingCrypter),
          container.get<VerifyUserServerPassword>(TYPES.Auth_VerifyUserServerPassword),
        ),
      )
    container
      .bind<GetAccountRecoveryEscrow>(TYPES.Auth_GetAccountRecoveryEscrow)
      .toConstantValue(
        new GetAccountRecoveryEscrow(
          container.get<SettingRepositoryInterface>(TYPES.Auth_SettingRepository),
          container.get<SettingCrypterInterface>(TYPES.Auth_SettingCrypter),
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
        ),
      )
    container
      .bind<SessionService>(TYPES.Auth_SessionService)
      .toConstantValue(
        new SessionService(
          container.get<SessionRepositoryInterface>(TYPES.Auth_SessionRepository),
          container.get<EphemeralSessionRepositoryInterface>(TYPES.Auth_EphemeralSessionRepository),
          container.get<RevokedSessionRepositoryInterface>(TYPES.Auth_RevokedSessionRepository),
          container.get<UAParserInstance>(TYPES.Auth_DeviceDetector),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<winston.Logger>(TYPES.Auth_Logger),
          container.get<number>(TYPES.Auth_ACCESS_TOKEN_AGE),
          container.get<number>(TYPES.Auth_REFRESH_TOKEN_AGE),
          container.get<CryptoNode>(TYPES.Auth_CryptoNode),
          container.get<TraceSession>(TYPES.Auth_TraceSession),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          container.get<string[]>(TYPES.Auth_READONLY_USERS),
          container.get<GetSetting>(TYPES.Auth_GetSetting),
          container.get<boolean>(TYPES.Auth_FORCE_LEGACY_SESSIONS),
        ),
      )
    container
      .bind<GetCooldownSessionTokens>(TYPES.Auth_GetCooldownSessionTokens)
      .toConstantValue(
        new GetCooldownSessionTokens(
          container.get<SessionTokensCooldownRepositoryInterface>(TYPES.Auth_SessionTokensCooldownRepository),
        ),
      )
    container
      .bind<GetSessionFromToken>(TYPES.Auth_GetSessionFromToken)
      .toConstantValue(
        new GetSessionFromToken(
          container.get<SessionRepositoryInterface>(TYPES.Auth_SessionRepository),
          container.get<EphemeralSessionRepositoryInterface>(TYPES.Auth_EphemeralSessionRepository),
          container.get<GetCooldownSessionTokens>(TYPES.Auth_GetCooldownSessionTokens),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    const httpAgentKeepAliveTimeout = env.get('HTTP_AGENT_KEEP_ALIVE_TIMEOUT', true)
      ? +env.get('HTTP_AGENT_KEEP_ALIVE_TIMEOUT', true)
      : 4_000

    container.bind<AxiosInstance>(TYPES.Auth_HTTPClient).toConstantValue(
      axios.create({
        httpAgent: new AgentKeepAlive({
          keepAlive: true,
          timeout: 2 * httpAgentKeepAliveTimeout,
          freeSocketTimeout: httpAgentKeepAliveTimeout,
        }),
      }),
    )

    // Standard Red Notes: webhook dispatcher needs the shared Axios HTTP client,
    // so it is bound here, after Auth_HTTPClient. It must precede the session-deletion
    // use-cases (e.g. DeleteSessionByToken) that eagerly resolve it at bind time.
    container
      .bind<WebhookDispatcherInterface>(TYPES.Auth_WebhookDispatcher)
      .toConstantValue(
        new WebhookDispatcher(
          container.get(TYPES.Auth_WebhookRepository),
          new PinnedHttpTransport(),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<DeleteSessionByToken>(TYPES.Auth_DeleteSessionByToken)
      .toConstantValue(
        new DeleteSessionByToken(
          container.get<GetSessionFromToken>(TYPES.Auth_GetSessionFromToken),
          container.get<SessionRepositoryInterface>(TYPES.Auth_SessionRepository),
          container.get<EphemeralSessionRepositoryInterface>(TYPES.Auth_EphemeralSessionRepository),
          container.get<AuditLogWriterInterface>(TYPES.Auth_AuditLogWriter),
          container.get<WebhookDispatcherInterface>(TYPES.Auth_WebhookDispatcher),
        ),
      )
    container
      .bind<CooldownSessionTokens>(TYPES.Auth_CooldownSessionTokens)
      .toConstantValue(
        new CooldownSessionTokens(
          container.get<number>(TYPES.Auth_COOLDOWN_SESSION_TOKENS_TTL),
          container.get<SessionTokensCooldownRepositoryInterface>(TYPES.Auth_SessionTokensCooldownRepository),
        ),
      )
    container.bind<AuthResponseFactory20161215>(TYPES.Auth_AuthResponseFactory20161215).to(AuthResponseFactory20161215)
    container.bind<AuthResponseFactory20190520>(TYPES.Auth_AuthResponseFactory20190520).to(AuthResponseFactory20190520)
    container.bind<AuthResponseFactory20200115>(TYPES.Auth_AuthResponseFactory20200115).to(AuthResponseFactory20200115)
    container
      .bind<AuthResponseFactoryResolverInterface>(TYPES.Auth_AuthResponseFactoryResolver)
      .to(AuthResponseFactoryResolver)
    container.bind<KeyParamsFactory>(TYPES.Auth_KeyParamsFactory).to(KeyParamsFactory)
    container
      .bind<TokenDecoderInterface<SessionTokenData>>(TYPES.Auth_SessionTokenDecoder)
      .toConstantValue(new TokenDecoder<SessionTokenData>(container.get(TYPES.Auth_JWT_SECRET)))
    container
      .bind<TokenDecoderInterface<SessionTokenData>>(TYPES.Auth_FallbackSessionTokenDecoder)
      .toConstantValue(new TokenDecoder<SessionTokenData>(container.get(TYPES.Auth_LEGACY_JWT_SECRET)))
    container
      .bind<TokenDecoderInterface<CrossServiceTokenData>>(TYPES.Auth_CrossServiceTokenDecoder)
      .toConstantValue(new TokenDecoder<CrossServiceTokenData>(container.get(TYPES.Auth_AUTH_JWT_SECRET)))
    container
      .bind<TokenDecoderInterface<OfflineUserTokenData>>(TYPES.Auth_OfflineUserTokenDecoder)
      .toConstantValue(new TokenDecoder<OfflineUserTokenData>(container.get(TYPES.Auth_AUTH_JWT_SECRET)))
    container
      .bind<TokenDecoderInterface<WebSocketConnectionTokenData>>(TYPES.Auth_WebSocketConnectionTokenDecoder)
      .toConstantValue(
        new TokenDecoder<WebSocketConnectionTokenData>(container.get(TYPES.Auth_WEB_SOCKET_CONNECTION_TOKEN_SECRET)),
      )
    container
      .bind<TokenEncoderInterface<OfflineUserTokenData>>(TYPES.Auth_OfflineUserTokenEncoder)
      .toConstantValue(new TokenEncoder<OfflineUserTokenData>(container.get(TYPES.Auth_AUTH_JWT_SECRET)))
    container
      .bind<TokenEncoderInterface<SessionTokenData>>(TYPES.Auth_SessionTokenEncoder)
      .toConstantValue(new TokenEncoder<SessionTokenData>(container.get(TYPES.Auth_JWT_SECRET)))
    container
      .bind<TokenEncoderInterface<CrossServiceTokenData>>(TYPES.Auth_CrossServiceTokenEncoder)
      .toConstantValue(new TokenEncoder<CrossServiceTokenData>(container.get(TYPES.Auth_AUTH_JWT_SECRET)))
    container
      .bind<TokenEncoderInterface<ValetTokenData>>(TYPES.Auth_ValetTokenEncoder)
      .toConstantValue(new TokenEncoder<ValetTokenData>(container.get(TYPES.Auth_VALET_TOKEN_SECRET)))
    container
      .bind<AuthenticationMethodResolver>(TYPES.Auth_AuthenticationMethodResolver)
      .toConstantValue(
        new AuthenticationMethodResolver(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<SessionServiceInterface>(TYPES.Auth_SessionService),
          container.get<TokenDecoderInterface<SessionTokenData>>(TYPES.Auth_SessionTokenDecoder),
          container.get<TokenDecoderInterface<SessionTokenData>>(TYPES.Auth_FallbackSessionTokenDecoder),
          container.get<GetSessionFromToken>(TYPES.Auth_GetSessionFromToken),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container.bind<DomainEventFactory>(TYPES.Auth_DomainEventFactory).to(DomainEventFactory)
    container
      .bind<SettingsAssociationServiceInterface>(TYPES.Auth_SettingsAssociationService)
      .to(SettingsAssociationService)

    container
      .bind<GetUserKeyParams>(TYPES.Auth_GetUserKeyParams)
      .toConstantValue(
        new GetUserKeyParams(
          container.get<KeyParamsFactoryInterface>(TYPES.Auth_KeyParamsFactory),
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<PKCERepositoryInterface>(TYPES.Auth_PKCERepository),
          container.get<winston.Logger>(TYPES.Auth_Logger),
          container.get<boolean>(TYPES.Auth_WORKSPACES_PER_EMAIL_ENABLED),
        ),
      )

    container.bind<OfflineSettingServiceInterface>(TYPES.Auth_OfflineSettingService).to(OfflineSettingService)
    container.bind<ContentDecoderInterface>(TYPES.Auth_ContenDecoder).toConstantValue(new ContentDecoder())
    container.bind<ClientServiceInterface>(TYPES.Auth_WebSocketsClientService).to(WebSocketsClientService)
    container.bind<RoleServiceInterface>(TYPES.Auth_RoleService).to(RoleService)
    container.bind<RoleToSubscriptionMapInterface>(TYPES.Auth_RoleToSubscriptionMap).to(RoleToSubscriptionMap)
    const standardRedFeaturesMode = env.get('STANDARD_RED_FEATURES_MODE', true) ?? 'included'
    const standardRedEntitlementMode = env.get('STANDARD_RED_ENTITLEMENT_MODE', true) ?? 'included'
    container
      .bind<SubscriptionSettingsAssociationServiceInterface>(TYPES.Auth_SubscriptionSettingsAssociationService)
      .to(SubscriptionSettingsAssociationService)
    container.bind<FeatureServiceInterface>(TYPES.Auth_FeatureService).toConstantValue(new FeatureService())
    container
      .bind<SelectorInterface<boolean>>(TYPES.Auth_BooleanSelector)
      .toConstantValue(new DeterministicSelector<boolean>())

    container
      .bind<CaptchaServerInterface>(TYPES.Auth_CaptchaServer)
      .toConstantValue(
        new HttpCaptchaServer(
          container.get(TYPES.Auth_Logger),
          container.get(TYPES.Auth_HTTPClient),
          container.get(TYPES.Auth_CAPTCHA_SERVER_URL),
        ),
      )

    container
      .bind<CookieFactoryInterface>(TYPES.Auth_CookieFactory)
      .toConstantValue(
        new CookieFactory(
          ['None', 'Lax', 'Strict'].includes(env.get('COOKIE_SAME_SITE', true))
            ? (env.get('COOKIE_SAME_SITE', true) as 'None' | 'Lax' | 'Strict')
            : 'None',
          env.get('COOKIE_DOMAIN', true) ?? '',
          env.get('COOKIE_SECURE', true) ? env.get('COOKIE_SECURE', true) === 'true' : true,
          env.get('COOKIE_PARTITIONED', true) ? env.get('COOKIE_PARTITIONED', true) === 'true' : true,
        ),
      )

    // Middleware
    container.bind<SessionMiddleware>(TYPES.Auth_SessionMiddleware).to(SessionMiddleware)
    container.bind<LockMiddleware>(TYPES.Auth_LockMiddleware).to(LockMiddleware)
    container
      .bind<RequiredCrossServiceTokenMiddleware>(TYPES.Auth_RequiredCrossServiceTokenMiddleware)
      .toConstantValue(
        new RequiredCrossServiceTokenMiddleware(
          container.get<TokenDecoderInterface<CrossServiceTokenData>>(TYPES.Auth_CrossServiceTokenDecoder),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<OptionalCrossServiceTokenMiddleware>(TYPES.Auth_OptionalCrossServiceTokenMiddleware)
      .toConstantValue(
        new OptionalCrossServiceTokenMiddleware(
          container.get<TokenDecoderInterface<CrossServiceTokenData>>(TYPES.Auth_CrossServiceTokenDecoder),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<ApiGatewayOfflineAuthMiddleware>(TYPES.Auth_ApiGatewayOfflineAuthMiddleware)
      .to(ApiGatewayOfflineAuthMiddleware)
    container.bind<OfflineUserAuthMiddleware>(TYPES.Auth_OfflineUserAuthMiddleware).to(OfflineUserAuthMiddleware)

    // use cases
    container
      .bind<PersistStatistics>(TYPES.Auth_PersistStatistics)
      .toConstantValue(
        new PersistStatistics(
          container.get(TYPES.Auth_SessionTraceRepository),
          container.get(TYPES.Auth_DomainEventPublisher),
          container.get(TYPES.Auth_DomainEventFactory),
          container.get(TYPES.Auth_Timer),
        ),
      )
    container
      .bind<GenerateAuthenticatorRegistrationOptions>(TYPES.Auth_GenerateAuthenticatorRegistrationOptions)
      .toConstantValue(
        new GenerateAuthenticatorRegistrationOptions(
          container.get(TYPES.Auth_AuthenticatorRepository),
          container.get(TYPES.Auth_AuthenticatorChallengeRepository),
          container.get(TYPES.Auth_U2F_RELYING_PARTY_NAME),
          container.get(TYPES.Auth_U2F_RELYING_PARTY_ID),
          container.get(TYPES.Auth_UserRepository),
          container.get(TYPES.Auth_FeatureService),
        ),
      )
    container
      .bind<VerifyAuthenticatorRegistrationResponse>(TYPES.Auth_VerifyAuthenticatorRegistrationResponse)
      .toConstantValue(
        new VerifyAuthenticatorRegistrationResponse(
          container.get(TYPES.Auth_AuthenticatorRepository),
          container.get(TYPES.Auth_AuthenticatorChallengeRepository),
          container.get(TYPES.Auth_U2F_RELYING_PARTY_ID),
          container.get(TYPES.Auth_U2F_EXPECTED_ORIGIN),
          container.get(TYPES.Auth_U2F_REQUIRE_USER_VERIFICATION),
          container.get(TYPES.Auth_UserRepository),
          container.get(TYPES.Auth_FeatureService),
        ),
      )
    container
      .bind<GenerateAuthenticatorAuthenticationOptions>(TYPES.Auth_GenerateAuthenticatorAuthenticationOptions)
      .toConstantValue(
        new GenerateAuthenticatorAuthenticationOptions(
          container.get(TYPES.Auth_UserRepository),
          container.get(TYPES.Auth_AuthenticatorRepository),
          container.get(TYPES.Auth_AuthenticatorChallengeRepository),
          container.get(TYPES.Auth_PSEUDO_KEY_PARAMS_KEY),
          container.get(TYPES.Auth_U2F_RELYING_PARTY_ID),
        ),
      )
    container
      .bind<VerifyAuthenticatorAuthenticationResponse>(TYPES.Auth_VerifyAuthenticatorAuthenticationResponse)
      .toConstantValue(
        new VerifyAuthenticatorAuthenticationResponse(
          container.get(TYPES.Auth_AuthenticatorRepository),
          container.get(TYPES.Auth_AuthenticatorChallengeRepository),
          container.get(TYPES.Auth_U2F_RELYING_PARTY_ID),
          container.get(TYPES.Auth_U2F_EXPECTED_ORIGIN),
          container.get(TYPES.Auth_U2F_REQUIRE_USER_VERIFICATION),
        ),
      )
    container
      .bind<ListAuthenticators>(TYPES.Auth_ListAuthenticators)
      .toConstantValue(
        new ListAuthenticators(
          container.get(TYPES.Auth_AuthenticatorRepository),
          container.get(TYPES.Auth_UserRepository),
          container.get(TYPES.Auth_FeatureService),
        ),
      )
    container
      .bind<DeleteAuthenticator>(TYPES.Auth_DeleteAuthenticator)
      .toConstantValue(
        new DeleteAuthenticator(
          container.get(TYPES.Auth_AuthenticatorRepository),
          container.get(TYPES.Auth_UserRepository),
          container.get(TYPES.Auth_FeatureService),
        ),
      )
    container
      .bind<CreateAppPassword>(TYPES.Auth_CreateAppPassword)
      .toConstantValue(
        new CreateAppPassword(
          container.get(TYPES.Auth_AppPasswordRepository),
          container.get(TYPES.Auth_UserRepository),
        ),
      )
    container
      .bind<ListAppPasswords>(TYPES.Auth_ListAppPasswords)
      .toConstantValue(new ListAppPasswords(container.get(TYPES.Auth_AppPasswordRepository)))
    container
      .bind<DeleteAppPassword>(TYPES.Auth_DeleteAppPassword)
      .toConstantValue(new DeleteAppPassword(container.get(TYPES.Auth_AppPasswordRepository)))
    container
      .bind<RevokeAppPassword>(TYPES.Auth_RevokeAppPassword)
      .toConstantValue(new RevokeAppPassword(container.get(TYPES.Auth_AppPasswordRepository)))
    container
      .bind<VerifyAppPassword>(TYPES.Auth_VerifyAppPassword)
      .toConstantValue(
        new VerifyAppPassword(
          container.get(TYPES.Auth_AppPasswordRepository),
          container.get(TYPES.Auth_UserRepository),
        ),
      )
    container
      .bind<CreateMcpToken>(TYPES.Auth_CreateMcpToken)
      .toConstantValue(
        new CreateMcpToken(container.get(TYPES.Auth_McpTokenRepository), container.get(TYPES.Auth_UserRepository)),
      )
    container
      .bind<ListMcpTokens>(TYPES.Auth_ListMcpTokens)
      .toConstantValue(new ListMcpTokens(container.get(TYPES.Auth_McpTokenRepository)))
    container
      .bind<DeleteMcpToken>(TYPES.Auth_DeleteMcpToken)
      .toConstantValue(new DeleteMcpToken(container.get(TYPES.Auth_McpTokenRepository)))
    container
      .bind<AuthenticateWithMcpToken>(TYPES.Auth_AuthenticateWithMcpToken)
      .toConstantValue(new AuthenticateWithMcpToken(container.get(TYPES.Auth_McpTokenRepository)))
    container
      .bind<GetMcpTokenKeys>(TYPES.Auth_GetMcpTokenKeys)
      .toConstantValue(new GetMcpTokenKeys(container.get(TYPES.Auth_McpTokenRepository)))
    container
      .bind<RegisterWebhook>(TYPES.Auth_RegisterWebhook)
      .toConstantValue(new RegisterWebhook(container.get(TYPES.Auth_WebhookRepository)))
    container
      .bind<ListWebhooks>(TYPES.Auth_ListWebhooks)
      .toConstantValue(new ListWebhooks(container.get(TYPES.Auth_WebhookRepository)))
    container
      .bind<DeleteWebhook>(TYPES.Auth_DeleteWebhook)
      .toConstantValue(new DeleteWebhook(container.get(TYPES.Auth_WebhookRepository)))
    container
      .bind<QueryAuditLog>(TYPES.Auth_QueryAuditLog)
      .toConstantValue(new QueryAuditLog(container.get(TYPES.Auth_AuditLogRepository)))
    container
      .bind<CreateShare>(TYPES.Auth_CreateShare)
      .toConstantValue(
        new CreateShare(container.get(TYPES.Auth_ShareRepository), container.get(TYPES.Auth_UserRepository)),
      )
    container
      .bind<ListShares>(TYPES.Auth_ListShares)
      .toConstantValue(new ListShares(container.get(TYPES.Auth_ShareRepository)))
    container
      .bind<RevokeShare>(TYPES.Auth_RevokeShare)
      .toConstantValue(new RevokeShare(container.get(TYPES.Auth_ShareRepository)))
    container
      .bind<GetShare>(TYPES.Auth_GetShare)
      .toConstantValue(new GetShare(container.get(TYPES.Auth_ShareRepository)))
    container
      .bind<CreateGroup>(TYPES.Auth_CreateGroup)
      .toConstantValue(
        new CreateGroup(container.get(TYPES.Auth_GroupRepository), container.get(TYPES.Auth_RoleRepository)),
      )
    container
      .bind<ListGroups>(TYPES.Auth_ListGroups)
      .toConstantValue(new ListGroups(container.get(TYPES.Auth_GroupRepository)))
    container
      .bind<DeleteGroup>(TYPES.Auth_DeleteGroup)
      .toConstantValue(new DeleteGroup(container.get(TYPES.Auth_GroupRepository)))
    container
      .bind<AddUserToGroup>(TYPES.Auth_AddUserToGroup)
      .toConstantValue(
        new AddUserToGroup(container.get(TYPES.Auth_GroupRepository), container.get(TYPES.Auth_UserRepository)),
      )
    container
      .bind<RemoveUserFromGroup>(TYPES.Auth_RemoveUserFromGroup)
      .toConstantValue(new RemoveUserFromGroup(container.get(TYPES.Auth_GroupRepository)))
    container
      .bind<SetGroupRoles>(TYPES.Auth_SetGroupRoles)
      .toConstantValue(
        new SetGroupRoles(container.get(TYPES.Auth_GroupRepository), container.get(TYPES.Auth_RoleRepository)),
      )
    container
      .bind<ListGroupMembers>(TYPES.Auth_ListGroupMembers)
      .toConstantValue(
        new ListGroupMembers(container.get(TYPES.Auth_GroupRepository), container.get(TYPES.Auth_UserRepository)),
      )
    container
      .bind<GetUserEffectivePermissions>(TYPES.Auth_GetUserEffectivePermissions)
      .toConstantValue(
        new GetUserEffectivePermissions(
          container.get(TYPES.Auth_UserRepository),
          container.get(TYPES.Auth_GroupRepository),
          container.get(TYPES.Auth_RoleRepository),
        ),
      )
    container
      .bind<ListRolesWithPermissions>(TYPES.Auth_ListRolesWithPermissions)
      .toConstantValue(
        new ListRolesWithPermissions(
          container.get(TYPES.Auth_RoleRepository),
          container.get(TYPES.Auth_PermissionRepository),
        ),
      )
    container
      .bind<SetRolePermissions>(TYPES.Auth_SetRolePermissions)
      .toConstantValue(
        new SetRolePermissions(
          container.get(TYPES.Auth_RoleRepository),
          container.get(TYPES.Auth_PermissionRepository),
        ),
      )
    container
      .bind<CreateCustomRole>(TYPES.Auth_CreateCustomRole)
      .toConstantValue(
        new CreateCustomRole(container.get(TYPES.Auth_RoleRepository), container.get(TYPES.Auth_PermissionRepository)),
      )
    container
      .bind<DeleteCustomRole>(TYPES.Auth_DeleteCustomRole)
      .toConstantValue(
        new DeleteCustomRole(container.get(TYPES.Auth_RoleRepository), container.get(TYPES.Auth_GroupRepository)),
      )
    container
      .bind<GetPermissionCatalog>(TYPES.Auth_GetPermissionCatalog)
      .toConstantValue(
        new GetPermissionCatalog(
          container.get(TYPES.Auth_RoleRepository),
          container.get(TYPES.Auth_PermissionRepository),
        ),
      )
    container
      .bind<GetRoleHolders>(TYPES.Auth_GetRoleHolders)
      .toConstantValue(
        new GetRoleHolders(
          container.get(TYPES.Auth_RoleRepository),
          container.get(TYPES.Auth_GroupRepository),
          container.get(TYPES.Auth_UserRepository),
        ),
      )
    container
      .bind<ResolveRoleSetPermissions>(TYPES.Auth_ResolveRoleSetPermissions)
      .toConstantValue(new ResolveRoleSetPermissions(container.get(TYPES.Auth_RoleRepository)))
    container
      .bind<CreateDeadManSwitch>(TYPES.Auth_CreateDeadManSwitch)
      .toConstantValue(
        new CreateDeadManSwitch(
          container.get(TYPES.Auth_DeadManSwitchRepository),
          container.get(TYPES.Auth_UserRepository),
        ),
      )
    container
      .bind<ListDeadManSwitches>(TYPES.Auth_ListDeadManSwitches)
      .toConstantValue(new ListDeadManSwitches(container.get(TYPES.Auth_DeadManSwitchRepository)))
    container
      .bind<CheckInDeadManSwitch>(TYPES.Auth_CheckInDeadManSwitch)
      .toConstantValue(
        new CheckInDeadManSwitch(
          container.get(TYPES.Auth_DeadManSwitchRepository),
          container.get<EmailSenderInterface>(TYPES.Auth_EmailSender),
        ),
      )
    container
      .bind<DeleteDeadManSwitch>(TYPES.Auth_DeleteDeadManSwitch)
      .toConstantValue(
        new DeleteDeadManSwitch(
          container.get(TYPES.Auth_DeadManSwitchRepository),
          container.get<EmailSenderInterface>(TYPES.Auth_EmailSender),
        ),
      )
    container
      .bind<CreateEmailReminder>(TYPES.Auth_CreateEmailReminder)
      .toConstantValue(
        new CreateEmailReminder(
          container.get(TYPES.Auth_EmailReminderRepository),
          container.get(TYPES.Auth_MAX_EMAIL_REMINDERS_PER_USER),
        ),
      )
    container
      .bind<ListEmailReminders>(TYPES.Auth_ListEmailReminders)
      .toConstantValue(new ListEmailReminders(container.get(TYPES.Auth_EmailReminderRepository)))
    container
      .bind<DeleteEmailReminder>(TYPES.Auth_DeleteEmailReminder)
      .toConstantValue(
        new DeleteEmailReminder(
          container.get(TYPES.Auth_EmailReminderRepository),
          container.get<EmailSenderInterface>(TYPES.Auth_EmailReminderSender),
        ),
      )
    container
      .bind<CreateTrustedDevice>(TYPES.Auth_CreateTrustedDevice)
      .toConstantValue(
        new CreateTrustedDevice(
          container.get(TYPES.Auth_TrustedDeviceRepository),
          container.get(TYPES.Auth_UserRepository),
          trustedDeviceDurationDays,
        ),
      )
    container
      .bind<ListTrustedDevices>(TYPES.Auth_ListTrustedDevices)
      .toConstantValue(new ListTrustedDevices(container.get(TYPES.Auth_TrustedDeviceRepository)))
    container
      .bind<DeleteTrustedDevice>(TYPES.Auth_DeleteTrustedDevice)
      .toConstantValue(new DeleteTrustedDevice(container.get(TYPES.Auth_TrustedDeviceRepository)))
    container
      .bind<VerifyTrustedDevice>(TYPES.Auth_VerifyTrustedDevice)
      .toConstantValue(
        new VerifyTrustedDevice(
          container.get(TYPES.Auth_TrustedDeviceRepository),
          container.get(TYPES.Auth_UserRepository),
        ),
      )
    container
      .bind<CreatePendingMfaApproval>(TYPES.Auth_CreatePendingMfaApproval)
      .toConstantValue(
        new CreatePendingMfaApproval(
          container.get(TYPES.Auth_PendingMfaApprovalRepository),
          container.get(TYPES.Auth_DomainEventPublisher),
          container.get(TYPES.Auth_DomainEventFactory),
          container.get(TYPES.Auth_Logger),
          pendingMfaApprovalTtlSeconds,
        ),
      )
    container
      .bind<ResolvePendingMfaApproval>(TYPES.Auth_ResolvePendingMfaApproval)
      .toConstantValue(new ResolvePendingMfaApproval(container.get(TYPES.Auth_PendingMfaApprovalRepository)))
    container
      .bind<GetPendingMfaApprovalStatus>(TYPES.Auth_GetPendingMfaApprovalStatus)
      .toConstantValue(new GetPendingMfaApprovalStatus(container.get(TYPES.Auth_PendingMfaApprovalRepository)))
    container
      .bind<ListPendingMfaApprovals>(TYPES.Auth_ListPendingMfaApprovals)
      .toConstantValue(new ListPendingMfaApprovals(container.get(TYPES.Auth_PendingMfaApprovalRepository)))
    container
      .bind<TriggerDueDeadManSwitches>(TYPES.Auth_TriggerDueDeadManSwitches)
      .toConstantValue(
        new TriggerDueDeadManSwitches(
          container.get(TYPES.Auth_DeadManSwitchRepository),
          container.get<EmailSenderInterface>(TYPES.Auth_EmailSender),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<TriggerDueEmailReminders>(TYPES.Auth_TriggerDueEmailReminders)
      .toConstantValue(
        new TriggerDueEmailReminders(
          container.get(TYPES.Auth_EmailReminderRepository),
          container.get(TYPES.Auth_UserRepository),
          container.get(TYPES.Auth_GetSetting),
          container.get<EmailSenderInterface>(TYPES.Auth_EmailReminderSender),
          container.get<winston.Logger>(TYPES.Auth_Logger),
          container.get<boolean>(TYPES.Auth_EMAIL_REMINDERS_ENABLED),
          container.get<boolean>(TYPES.Auth_EMAIL_REMINDER_NO_RECORDS),
        ),
      )
    container
      .bind<SetSettingValue>(TYPES.Auth_SetSettingValue)
      .toConstantValue(
        new SetSettingValue(
          container.get<GetSetting>(TYPES.Auth_GetSetting),
          container.get<SettingRepositoryInterface>(TYPES.Auth_SettingRepository),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<SettingsAssociationServiceInterface>(TYPES.Auth_SettingsAssociationService),
          container.get<RoleServiceInterface>(TYPES.Auth_RoleService),
          container.get<SettingCrypterInterface>(TYPES.Auth_SettingCrypter),
        ),
      )
    container
      .bind<SetUserBanStatus>(TYPES.Auth_SetUserBanStatus)
      .toConstantValue(
        new SetUserBanStatus(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<TimerInterface>(TYPES.Auth_Timer),
        ),
      )
    container
      .bind<SetUserSuspension>(TYPES.Auth_SetUserSuspension)
      .toConstantValue(
        new SetUserSuspension(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<SessionRepositoryInterface>(TYPES.Auth_SessionRepository),
          container.get<EphemeralSessionRepositoryInterface>(TYPES.Auth_EphemeralSessionRepository),
          container.get<RevokedSessionRepositoryInterface>(TYPES.Auth_RevokedSessionRepository),
          container.get<TimerInterface>(TYPES.Auth_Timer),
        ),
      )
    container
      .bind<GenerateRecoveryCodes>(TYPES.Auth_GenerateRecoveryCodes)
      .toConstantValue(
        new GenerateRecoveryCodes(
          container.get(TYPES.Auth_UserRepository),
          container.get(TYPES.Auth_SetSettingValue),
          container.get(TYPES.Auth_CryptoNode),
          container.get(TYPES.Auth_VerifyUserServerPassword),
        ),
      )
    container
      .bind<GetSubscriptionSetting>(TYPES.Auth_GetSubscriptionSetting)
      .toConstantValue(
        new GetSubscriptionSetting(
          container.get<SubscriptionSettingRepositoryInterface>(TYPES.Auth_SubscriptionSettingRepository),
          container.get<SettingCrypterInterface>(TYPES.Auth_SettingCrypter),
        ),
      )
    container
      .bind<SetSubscriptionSettingValue>(TYPES.Auth_SetSubscriptionSettingValue)
      .toConstantValue(
        new SetSubscriptionSettingValue(
          container.get<SubscriptionSettingRepositoryInterface>(TYPES.Auth_SubscriptionSettingRepository),
          container.get<GetSubscriptionSetting>(TYPES.Auth_GetSubscriptionSetting),
          container.get<SettingsAssociationServiceInterface>(TYPES.Auth_SettingsAssociationService),
          container.get<TimerInterface>(TYPES.Auth_Timer),
        ),
      )
    container
      .bind<ApplyDefaultSubscriptionSettings>(TYPES.Auth_ApplyDefaultSubscriptionSettings)
      .toConstantValue(
        new ApplyDefaultSubscriptionSettings(
          container.get<SubscriptionSettingsAssociationServiceInterface>(
            TYPES.Auth_SubscriptionSettingsAssociationService,
          ),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          container.get<GetSubscriptionSetting>(TYPES.Auth_GetSubscriptionSetting),
          container.get<SetSubscriptionSettingValue>(TYPES.Auth_SetSubscriptionSettingValue),
        ),
      )
    container
      .bind<ActivatePremiumFeatures>(TYPES.Auth_ActivatePremiumFeatures)
      .toConstantValue(
        new ActivatePremiumFeatures(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          container.get<ApplyDefaultSubscriptionSettings>(TYPES.Auth_ApplyDefaultSubscriptionSettings),
          container.get<RoleServiceInterface>(TYPES.Auth_RoleService),
          container.get<TimerInterface>(TYPES.Auth_Timer),
        ),
      )

    container
      .bind<CleanupSessionTraces>(TYPES.Auth_CleanupSessionTraces)
      .toConstantValue(new CleanupSessionTraces(container.get(TYPES.Auth_SessionTraceRepository)))
    container
      .bind<CleanupExpiredSessions>(TYPES.Auth_CleanupExpiredSessions)
      .toConstantValue(new CleanupExpiredSessions(container.get(TYPES.Auth_SessionRepository)))
    container.bind<AuthenticateUser>(TYPES.Auth_AuthenticateUser).to(AuthenticateUser)
    container.bind<AuthenticateRequest>(TYPES.Auth_AuthenticateRequest).to(AuthenticateRequest)
    container
      .bind<RefreshSessionToken>(TYPES.Auth_RefreshSessionToken)
      .toConstantValue(
        new RefreshSessionToken(
          container.get<SessionServiceInterface>(TYPES.Auth_SessionService),
          container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
          container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<GetSetting>(TYPES.Auth_GetSetting),
          container.get<CooldownSessionTokens>(TYPES.Auth_CooldownSessionTokens),
          container.get<GetSessionFromToken>(TYPES.Auth_GetSessionFromToken),
          container.get<winston.Logger>(TYPES.Auth_Logger),
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<RegistrationConfigResolverInterface>(TYPES.Auth_RegistrationConfigResolver),
        ),
      )
    container
      .bind<VerifyHumanInteraction>(TYPES.Auth_VerifyHumanInteraction)
      .toConstantValue(
        new VerifyHumanInteraction(
          container.get(TYPES.Auth_HUMAN_VERIFICATION_ENABLED),
          container.get<CaptchaServerInterface>(TYPES.Auth_CaptchaServer),
        ),
      )
    container.bind<SignIn>(TYPES.Auth_SignIn).toConstantValue(
      new SignIn(
        container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
        container.get<AuthResponseFactoryResolverInterface>(TYPES.Auth_AuthResponseFactoryResolver),
        container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
        container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
        container.get<SessionServiceInterface>(TYPES.Auth_SessionService),
        container.get<PKCERepositoryInterface>(TYPES.Auth_PKCERepository),
        container.get<CrypterInterface>(TYPES.Auth_Crypter),
        container.get<winston.Logger>(TYPES.Auth_Logger),
        container.get<number>(TYPES.Auth_MAX_LOGIN_ATTEMPTS),
        container.get<LockRepositoryInterface>(TYPES.Auth_LockRepository),
        container.get<VerifyHumanInteraction>(TYPES.Auth_VerifyHumanInteraction),
        container.get<boolean>(TYPES.Auth_WORKSPACES_PER_EMAIL_ENABLED),
        container.get<AuditLogWriterInterface>(TYPES.Auth_AuditLogWriter),
        container.get<WebhookDispatcherInterface>(TYPES.Auth_WebhookDispatcher),
        // Standard Red Notes: EMAIL CONFIRMATION sign-in gate (block_signin mode).
        container.get<RegistrationConfigResolverInterface>(TYPES.Auth_RegistrationConfigResolver),
      ),
    )
    container
      .bind<GenerateMagicLinkCode>(TYPES.Auth_GenerateMagicLinkCode)
      .toConstantValue(
        new GenerateMagicLinkCode(
          container.get<MagicLinkTokenRepositoryInterface>(TYPES.Auth_MagicLinkTokenRepository),
          container.get<EmailSenderInterface>(TYPES.Auth_EmailSender),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<VerifyMagicLinkCode>(TYPES.Auth_VerifyMagicLinkCode)
      .toConstantValue(
        new VerifyMagicLinkCode(
          container.get<MagicLinkTokenRepositoryInterface>(TYPES.Auth_MagicLinkTokenRepository),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<SendEmailConfirmation>(TYPES.Auth_SendEmailConfirmation)
      .toConstantValue(
        new SendEmailConfirmation(
          container.get<EmailConfirmationTokenRepositoryInterface>(TYPES.Auth_EmailConfirmationTokenRepository),
          container.get<EmailSenderInterface>(TYPES.Auth_EmailSender),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    // Standard Red Notes: APPROVAL / WAITLIST QUEUE. SendApprovalNotification +
    // ListPendingUsers + ApproveUser are bound here; RejectUser depends on
    // Auth_DeleteAccount and is bound just after it (see below) so its eager
    // resolution never precedes the DeleteAccount binding.
    container
      .bind<SendApprovalNotification>(TYPES.Auth_SendApprovalNotification)
      .toConstantValue(
        new SendApprovalNotification(
          container.get<EmailSenderInterface>(TYPES.Auth_EmailSender),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<ListPendingUsers>(TYPES.Auth_ListPendingUsers)
      .toConstantValue(new ListPendingUsers(container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository)))
    container
      .bind<ApproveUser>(TYPES.Auth_ApproveUser)
      .toConstantValue(
        new ApproveUser(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<SendApprovalNotification>(TYPES.Auth_SendApprovalNotification),
          env.get('REGISTRATION_EMAIL_CONFIRMATION_URL', true) || undefined,
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<VerifyEmailConfirmation>(TYPES.Auth_VerifyEmailConfirmation)
      .toConstantValue(
        new VerifyEmailConfirmation(
          container.get<EmailConfirmationTokenRepositoryInterface>(TYPES.Auth_EmailConfirmationTokenRepository),
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<ResendEmailConfirmation>(TYPES.Auth_ResendEmailConfirmation)
      .toConstantValue(
        new ResendEmailConfirmation(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<RegistrationConfigResolverInterface>(TYPES.Auth_RegistrationConfigResolver),
          container.get<SendEmailConfirmation>(TYPES.Auth_SendEmailConfirmation),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<VerifyMFA>(TYPES.Auth_VerifyMFA)
      .toConstantValue(
        new VerifyMFA(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<SelectorInterface<boolean>>(TYPES.Auth_BooleanSelector),
          container.get<LockRepositoryInterface>(TYPES.Auth_LockRepository),
          container.get<string>(TYPES.Auth_PSEUDO_KEY_PARAMS_KEY),
          container.get<AuthenticatorRepositoryInterface>(TYPES.Auth_AuthenticatorRepository),
          container.get<VerifyAuthenticatorAuthenticationResponse>(
            TYPES.Auth_VerifyAuthenticatorAuthenticationResponse,
          ),
          container.get<GetSetting>(TYPES.Auth_GetSetting),
          container.get<VerifyMagicLinkCode>(TYPES.Auth_VerifyMagicLinkCode),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<ClearLoginAttempts>(TYPES.Auth_ClearLoginAttempts)
      .toConstantValue(
        new ClearLoginAttempts(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<LockRepositoryInterface>(TYPES.Auth_LockRepository),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<IncreaseLoginAttempts>(TYPES.Auth_IncreaseLoginAttempts)
      .toConstantValue(
        new IncreaseLoginAttempts(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<LockRepositoryInterface>(TYPES.Auth_LockRepository),
          container.get<number>(TYPES.Auth_MAX_LOGIN_ATTEMPTS),
        ),
      )
    container
      .bind<GetUserKeyParamsRecovery>(TYPES.Auth_GetUserKeyParamsRecovery)
      .toConstantValue(
        new GetUserKeyParamsRecovery(
          container.get<KeyParamsFactoryInterface>(TYPES.Auth_KeyParamsFactory),
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<PKCERepositoryInterface>(TYPES.Auth_PKCERepository),
          container.get<GetSetting>(TYPES.Auth_GetSetting),
        ),
      )
    container
      .bind<ApplyDefaultSettings>(TYPES.Auth_ApplyDefaultSettings)
      .toConstantValue(
        new ApplyDefaultSettings(
          container.get<SettingsAssociationServiceInterface>(TYPES.Auth_SettingsAssociationService),
          container.get<SetSettingValue>(TYPES.Auth_SetSettingValue),
        ),
      )
    // Standard Red Notes: signup-cap policy resolver (persisted admin overlay ->
    // REGISTRATION_SIGNUPS_PER_* env baseline -> default). Reads the SAME
    // ServerSettings overlay file the gateway admin surface writes so an admin
    // change applies without a restart. Constructed as a local (not a container
    // binding) since only Register consumes it.
    const signupLimitsOverlayReader = new ServerSettingsOverlayReader(
      env.get('SERVER_SETTINGS_PATH', true) || undefined,
    )
    const signupLimitsBaseline = signupLimitsBaselineFromEnv({
      perIpMax: env.get('REGISTRATION_SIGNUPS_PER_IP_MAX', true) || undefined,
      perIpWindowHours: env.get('REGISTRATION_SIGNUPS_PER_IP_WINDOW_HOURS', true) || undefined,
      perWeekMax: env.get('REGISTRATION_SIGNUPS_PER_WEEK_MAX', true) || undefined,
      perDeviceMax: env.get('REGISTRATION_SIGNUPS_PER_DEVICE_MAX', true) || undefined,
      perDeviceWindowHours: env.get('REGISTRATION_SIGNUPS_PER_DEVICE_WINDOW_HOURS', true) || undefined,
    })
    const signupLimitsResolver: SignupLimitsConfigResolverInterface = new EnvSignupLimitsConfigResolver(
      signupLimitsBaseline,
      () => signupLimitsOverlayReader.signupLimits(),
    )
    // Redis-backed counter for the per-IP + per-device SOFT caps. Bound only when
    // Auth_Redis is present (same topology guard as the IP escalation checker);
    // absent under the in-memory/TypeORM cache, where those two caps simply do not
    // apply. The per-week cap is DB-backed and always available regardless.
    const signupRateLimiter: SignupRateLimiterInterface | undefined = container.isBound(TYPES.Auth_Redis)
      ? new RedisSignupRateLimiter(container.get<Redis>(TYPES.Auth_Redis))
      : undefined
    // Standard Red Notes: SIGNUP INVITE LINKS use cases.
    container.bind<ConsumeSignupInvite>(TYPES.Auth_ConsumeSignupInvite).toConstantValue(
      new ConsumeSignupInvite(
        container.get<SignupInviteLinkRepositoryInterface>(TYPES.Auth_SignupInviteLinkRepository),
        // Standard Red Notes: ATTRIBUTION sink (#14) — one use row per consumed slot.
        container.get<SignupInviteUseRepositoryInterface>(TYPES.Auth_SignupInviteUseRepository),
      ),
    )
    container
      .bind<CreateSignupInviteLink>(TYPES.Auth_CreateSignupInviteLink)
      .toConstantValue(
        new CreateSignupInviteLink(
          container.get<SignupInviteLinkRepositoryInterface>(TYPES.Auth_SignupInviteLinkRepository),
        ),
      )
    container
      .bind<ListSignupInviteLinks>(TYPES.Auth_ListSignupInviteLinks)
      .toConstantValue(
        new ListSignupInviteLinks(
          container.get<SignupInviteLinkRepositoryInterface>(TYPES.Auth_SignupInviteLinkRepository),
        ),
      )
    container
      .bind<RevokeSignupInviteLink>(TYPES.Auth_RevokeSignupInviteLink)
      .toConstantValue(
        new RevokeSignupInviteLink(
          container.get<SignupInviteLinkRepositoryInterface>(TYPES.Auth_SignupInviteLinkRepository),
        ),
      )
    container.bind<Register>(TYPES.Auth_Register).toConstantValue(
      new Register(
        container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
        container.get<RoleRepositoryInterface>(TYPES.Auth_RoleRepository),
        container.get<AuthResponseFactory20200115>(TYPES.Auth_AuthResponseFactory20200115),
        container.get<CrypterInterface>(TYPES.Auth_Crypter),
        container.get<boolean>(TYPES.Auth_DISABLE_USER_REGISTRATION),
        container.get<TimerInterface>(TYPES.Auth_Timer),
        container.get<ApplyDefaultSettings>(TYPES.Auth_ApplyDefaultSettings),
        standardRedEntitlementMode,
        container.get<ActivatePremiumFeatures>(TYPES.Auth_ActivatePremiumFeatures),
        env.get('STANDARD_RED_FULL_FEATURE_DURATION_DAYS', true)
          ? +env.get('STANDARD_RED_FULL_FEATURE_DURATION_DAYS', true)
          : 36500,
        env.get('STANDARD_RED_FULL_FEATURE_FILE_LIMIT_BYTES', true)
          ? +env.get('STANDARD_RED_FULL_FEATURE_FILE_LIMIT_BYTES', true)
          : -1,
        container.get<boolean>(TYPES.Auth_WORKSPACES_PER_EMAIL_ENABLED),
        // Standard Red Notes: lets Register consult the admin-panel-persisted
        // REGISTRATION_DISABLED flag at runtime (in addition to the env override).
        container.get<SettingRepositoryInterface>(TYPES.Auth_SettingRepository),
        // Standard Red Notes: resolves the admin-configurable default role +
        // email-domain policy for each registration.
        container.get<RegistrationConfigResolverInterface>(TYPES.Auth_RegistrationConfigResolver),
        // Standard Red Notes: EMAIL CONFIRMATION — issues + emails the single-use
        // verification link when the resolved policy enables it.
        container.get<SendEmailConfirmation>(TYPES.Auth_SendEmailConfirmation),
        container.get<winston.Logger>(TYPES.Auth_Logger),
        // Standard Red Notes: SIGNUP CAPS — the Redis-backed counter (per-IP +
        // per-device SOFT) and the cap-policy resolver. Both fail open.
        signupRateLimiter,
        signupLimitsResolver,
        // Standard Red Notes: SIGNUP INVITE LINKS — atomically consumes an
        // invite slot (invite-only mode fails closed; open mode honors a present
        // token, fails open). Always wired so invite-only is enforceable.
        container.get<ConsumeSignupInvite>(TYPES.Auth_ConsumeSignupInvite),
      ),
    )
    container.bind<GetActiveSessionsForUser>(TYPES.Auth_GetActiveSessionsForUser).to(GetActiveSessionsForUser)
    container.bind<DeleteOtherSessionsForUser>(TYPES.Auth_DeleteOtherSessionsForUser).to(DeleteOtherSessionsForUser)
    container.bind<DeleteSessionForUser>(TYPES.Auth_DeleteSessionForUser).to(DeleteSessionForUser)
    container
      .bind<ChangeCredentials>(TYPES.Auth_ChangeCredentials)
      .toConstantValue(
        new ChangeCredentials(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<AuthResponseFactoryResolverInterface>(TYPES.Auth_AuthResponseFactoryResolver),
          container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
          container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<DeleteOtherSessionsForUser>(TYPES.Auth_DeleteOtherSessionsForUser),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<GetSettings>(TYPES.Auth_GetSettings)
      .toConstantValue(
        new GetSettings(
          container.get<SettingRepositoryInterface>(TYPES.Auth_SettingRepository),
          container.get<SettingCrypterInterface>(TYPES.Auth_SettingCrypter),
        ),
      )
    container
      .bind<GetSubscriptionSettings>(TYPES.Auth_GetSubscriptionSettings)
      .toConstantValue(
        new GetSubscriptionSettings(
          container.get<SubscriptionSettingRepositoryInterface>(TYPES.Auth_SubscriptionSettingRepository),
          container.get<SettingCrypterInterface>(TYPES.Auth_SettingCrypter),
        ),
      )
    container
      .bind<GetRegularSubscriptionForUser>(TYPES.Auth_GetRegularSubscriptionForUser)
      .toConstantValue(
        new GetRegularSubscriptionForUser(
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
        ),
      )
    container
      .bind<GetSharedSubscriptionForUser>(TYPES.Auth_GetSharedSubscriptionForUser)
      .toConstantValue(
        new GetSharedSubscriptionForUser(
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
        ),
      )
    container
      .bind<GetSharedOrRegularSubscriptionForUser>(TYPES.Auth_GetSharedOrRegularSubscriptionForUser)
      .toConstantValue(
        new GetSharedOrRegularSubscriptionForUser(
          container.get<GetRegularSubscriptionForUser>(TYPES.Auth_GetRegularSubscriptionForUser),
          container.get<GetSharedSubscriptionForUser>(TYPES.Auth_GetSharedSubscriptionForUser),
        ),
      )
    container
      .bind<GetAllSettingsForUser>(TYPES.Auth_GetAllSettingsForUser)
      .toConstantValue(
        new GetAllSettingsForUser(
          container.get<GetSettings>(TYPES.Auth_GetSettings),
          container.get<GetSharedOrRegularSubscriptionForUser>(TYPES.Auth_GetSharedOrRegularSubscriptionForUser),
          container.get<GetSubscriptionSettings>(TYPES.Auth_GetSubscriptionSettings),
        ),
      )
    container.bind<GetUserFeatures>(TYPES.Auth_GetUserFeatures).to(GetUserFeatures)
    container.bind<DeleteSetting>(TYPES.Auth_DeleteSetting).to(DeleteSetting)
    container.bind<GetMfaSecret>(TYPES.Auth_GetMfaSecret).to(GetMfaSecret)
    container.bind<ValidateMfaToken>(TYPES.Auth_ValidateMfaToken).to(ValidateMfaToken)
    container
      .bind<SignInWithRecoveryCodes>(TYPES.Auth_SignInWithRecoveryCodes)
      .toConstantValue(
        new SignInWithRecoveryCodes(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<AuthResponseFactory20200115>(TYPES.Auth_AuthResponseFactory20200115),
          container.get<PKCERepositoryInterface>(TYPES.Auth_PKCERepository),
          container.get<CrypterInterface>(TYPES.Auth_Crypter),
          container.get<GetSetting>(TYPES.Auth_GetSetting),
          container.get<GenerateRecoveryCodes>(TYPES.Auth_GenerateRecoveryCodes),
          container.get<IncreaseLoginAttempts>(TYPES.Auth_IncreaseLoginAttempts),
          container.get<ClearLoginAttempts>(TYPES.Auth_ClearLoginAttempts),
          container.get<DeleteSetting>(TYPES.Auth_DeleteSetting),
          container.get<AuthenticatorRepositoryInterface>(TYPES.Auth_AuthenticatorRepository),
          container.get<number>(TYPES.Auth_MAX_LOGIN_ATTEMPTS),
          container.get<LockRepositoryInterface>(TYPES.Auth_LockRepository),
          container.get<VerifyHumanInteraction>(TYPES.Auth_VerifyHumanInteraction),
        ),
      )
    container
      .bind<DeleteAccount>(TYPES.Auth_DeleteAccount)
      .toConstantValue(
        new DeleteAccount(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<GetRegularSubscriptionForUser>(TYPES.Auth_GetRegularSubscriptionForUser),
          container.get<GetSharedSubscriptionForUser>(TYPES.Auth_GetSharedSubscriptionForUser),
          container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
          container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<VerifyUserServerPassword>(TYPES.Auth_VerifyUserServerPassword),
        ),
      )
    // Standard Red Notes: APPROVAL QUEUE reject reuses the DeleteAccount pipeline,
    // so it is bound right after Auth_DeleteAccount (which it resolves eagerly).
    container
      .bind<RejectUser>(TYPES.Auth_RejectUser)
      .toConstantValue(
        new RejectUser(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<DeleteAccount>(TYPES.Auth_DeleteAccount),
        ),
      )
    container
      .bind<GetUserSubscription>(TYPES.Auth_GetUserSubscription)
      .toConstantValue(
        new GetUserSubscription(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          standardRedFeaturesMode,
          container.get<TimerInterface>(TYPES.Auth_Timer),
          env.get('STANDARD_RED_FULL_FEATURE_DURATION_DAYS', true)
            ? +env.get('STANDARD_RED_FULL_FEATURE_DURATION_DAYS', true)
            : 36500,
        ),
      )
    container
      .bind<GetUserOfflineSubscription>(TYPES.Auth_GetUserOfflineSubscription)
      .toConstantValue(
        new GetUserOfflineSubscription(
          container.get<OfflineUserSubscriptionRepositoryInterface>(TYPES.Auth_OfflineUserSubscriptionRepository),
          standardRedFeaturesMode,
          container.get<TimerInterface>(TYPES.Auth_Timer),
          env.get('STANDARD_RED_FULL_FEATURE_DURATION_DAYS', true)
            ? +env.get('STANDARD_RED_FULL_FEATURE_DURATION_DAYS', true)
            : 36500,
        ),
      )
    container.bind<CreateSubscriptionToken>(TYPES.Auth_CreateSubscriptionToken).to(CreateSubscriptionToken)
    container
      .bind<AuthenticateSubscriptionToken>(TYPES.Auth_AuthenticateSubscriptionToken)
      .to(AuthenticateSubscriptionToken)
    container
      .bind<AuthenticateOfflineSubscriptionToken>(TYPES.Auth_AuthenticateOfflineSubscriptionToken)
      .to(AuthenticateOfflineSubscriptionToken)
    container
      .bind<CreateOfflineSubscriptionToken>(TYPES.Auth_CreateOfflineSubscriptionToken)
      .to(CreateOfflineSubscriptionToken)
    container
      .bind<CreateValetToken>(TYPES.Auth_CreateValetToken)
      .toConstantValue(
        new CreateValetToken(
          container.get<TokenEncoderInterface<ValetTokenData>>(TYPES.Auth_ValetTokenEncoder),
          container.get<SubscriptionSettingsAssociationServiceInterface>(
            TYPES.Auth_SubscriptionSettingsAssociationService,
          ),
          container.get<GetRegularSubscriptionForUser>(TYPES.Auth_GetRegularSubscriptionForUser),
          container.get<GetSharedSubscriptionForUser>(TYPES.Auth_GetSharedSubscriptionForUser),
          container.get<GetSubscriptionSetting>(TYPES.Auth_GetSubscriptionSetting),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<number>(TYPES.Auth_VALET_TOKEN_TTL),
        ),
      )
    container
      .bind<InviteToSharedSubscription>(TYPES.Auth_InviteToSharedSubscription)
      .toConstantValue(
        new InviteToSharedSubscription(
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<SharedSubscriptionInvitationRepositoryInterface>(
            TYPES.Auth_SharedSubscriptionInvitationRepository,
          ),
          container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
          container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
          container.get<AuthInviteMutationTransactionRunner>(TYPES.Auth_InviteMutationTransactionRunner),
          container.get<AuthInviteRealtimeOutboxProducer>(TYPES.Auth_InviteRealtimeOutboxProducer),
          container.get<AuthInviteAffectedUserResolver>(TYPES.Auth_InviteAffectedUserResolver),
        ),
      )
    container
      .bind<AcceptSharedSubscriptionInvitation>(TYPES.Auth_AcceptSharedSubscriptionInvitation)
      .toConstantValue(
        new AcceptSharedSubscriptionInvitation(
          container.get<SharedSubscriptionInvitationRepositoryInterface>(
            TYPES.Auth_SharedSubscriptionInvitationRepository,
          ),
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          container.get<RoleServiceInterface>(TYPES.Auth_RoleService),
          container.get<ApplyDefaultSubscriptionSettings>(TYPES.Auth_ApplyDefaultSubscriptionSettings),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<winston.Logger>(TYPES.Auth_Logger),
          container.get<AuthInviteMutationTransactionRunner>(TYPES.Auth_InviteMutationTransactionRunner),
          container.get<AuthInviteRealtimeOutboxProducer>(TYPES.Auth_InviteRealtimeOutboxProducer),
          container.get<AuthInviteAffectedUserResolver>(TYPES.Auth_InviteAffectedUserResolver),
        ),
      )
    container
      .bind<DeclineSharedSubscriptionInvitation>(TYPES.Auth_DeclineSharedSubscriptionInvitation)
      .toConstantValue(
        new DeclineSharedSubscriptionInvitation(
          container.get<SharedSubscriptionInvitationRepositoryInterface>(
            TYPES.Auth_SharedSubscriptionInvitationRepository,
          ),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<AuthInviteMutationTransactionRunner>(TYPES.Auth_InviteMutationTransactionRunner),
          container.get<AuthInviteRealtimeOutboxProducer>(TYPES.Auth_InviteRealtimeOutboxProducer),
          container.get<AuthInviteAffectedUserResolver>(TYPES.Auth_InviteAffectedUserResolver),
        ),
      )
    container
      .bind<CancelSharedSubscriptionInvitation>(TYPES.Auth_CancelSharedSubscriptionInvitation)
      .toConstantValue(
        new CancelSharedSubscriptionInvitation(
          container.get<SharedSubscriptionInvitationRepositoryInterface>(
            TYPES.Auth_SharedSubscriptionInvitationRepository,
          ),
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          container.get<RoleServiceInterface>(TYPES.Auth_RoleService),
          container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
          container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<winston.Logger>(TYPES.Auth_Logger),
          container.get<AuthInviteMutationTransactionRunner>(TYPES.Auth_InviteMutationTransactionRunner),
          container.get<AuthInviteRealtimeOutboxProducer>(TYPES.Auth_InviteRealtimeOutboxProducer),
          container.get<AuthInviteAffectedUserResolver>(TYPES.Auth_InviteAffectedUserResolver),
        ),
      )
    container
      .bind<ListSharedSubscriptionInvitations>(TYPES.Auth_ListSharedSubscriptionInvitations)
      .to(ListSharedSubscriptionInvitations)
    container
      .bind<VerifyPredicate>(TYPES.Auth_VerifyPredicate)
      .toConstantValue(
        new VerifyPredicate(
          container.get<SettingRepositoryInterface>(TYPES.Auth_SettingRepository),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          standardRedFeaturesMode,
        ),
      )
    const crossServiceTokenVersionConfig = resolveCrossServiceTokenVersionConfig(
      env.get('APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2', true),
      env.get('APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3', true),
    )
    if (crossServiceTokenVersionConfig.defaultedConfigurationKeys.length > 0) {
      logger.warn('Cross-service token version thresholds were missing or invalid; secure defaults were applied.', {
        configurationKeys: crossServiceTokenVersionConfig.defaultedConfigurationKeys,
      })
    }

    container.bind<CreateCrossServiceToken>(TYPES.Auth_CreateCrossServiceToken).toConstantValue(
      new CreateCrossServiceToken(
        container.get<ProjectorInterface<User>>(TYPES.Auth_UserProjector),
        container.get<ProjectorInterface<Session>>(TYPES.Auth_SessionProjector),
        container.get<ProjectorInterface<Role>>(TYPES.Auth_RoleProjector),
        container.get<TokenEncoderInterface<CrossServiceTokenData>>(TYPES.Auth_CrossServiceTokenEncoder),
        container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
        container.get<number>(TYPES.Auth_AUTH_JWT_TTL),
        container.get<GetRegularSubscriptionForUser>(TYPES.Auth_GetRegularSubscriptionForUser),
        container.get<GetSubscriptionSetting>(TYPES.Auth_GetSubscriptionSetting),
        container.get<SharedVaultUserRepositoryInterface>(TYPES.Auth_SharedVaultUserRepository),
        container.get<GetActiveSessionsForUser>(TYPES.Auth_GetActiveSessionsForUser),
        crossServiceTokenVersionConfig.version2Threshold,
        crossServiceTokenVersionConfig.version3Threshold,
        container.get<GetSetting>(TYPES.Auth_GetSetting),
        // Standard Red Notes: RBAC groups — tokens carry group-conferred roles
        // (direct ∪ group) so e.g. admin granted via a group works.
        container.get<GroupRepositoryInterface>(TYPES.Auth_GroupRepository),
      ),
    )
    container.bind<ProcessUserRequest>(TYPES.Auth_ProcessUserRequest).to(ProcessUserRequest)
    container
      .bind<UpdateStorageQuotaUsedForUser>(TYPES.Auth_UpdateStorageQuotaUsedForUser)
      .toConstantValue(
        new UpdateStorageQuotaUsedForUser(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<GetRegularSubscriptionForUser>(TYPES.Auth_GetRegularSubscriptionForUser),
          container.get<GetSharedSubscriptionForUser>(TYPES.Auth_GetSharedSubscriptionForUser),
          container.get<GetSubscriptionSetting>(TYPES.Auth_GetSubscriptionSetting),
          container.get<SetSubscriptionSettingValue>(TYPES.Auth_SetSubscriptionSettingValue),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<AddSharedVaultUser>(TYPES.Auth_AddSharedVaultUser)
      .toConstantValue(
        new AddSharedVaultUser(container.get<SharedVaultUserRepositoryInterface>(TYPES.Auth_SharedVaultUserRepository)),
      )
    container
      .bind<RemoveSharedVaultUser>(TYPES.Auth_RemoveSharedVaultUser)
      .toConstantValue(
        new RemoveSharedVaultUser(
          container.get<SharedVaultUserRepositoryInterface>(TYPES.Auth_SharedVaultUserRepository),
        ),
      )
    container
      .bind<DesignateSurvivor>(TYPES.Auth_DesignateSurvivor)
      .toConstantValue(
        new DesignateSurvivor(
          container.get<SharedVaultUserRepositoryInterface>(TYPES.Auth_SharedVaultUserRepository),
          container.get<TimerInterface>(TYPES.Auth_Timer),
        ),
      )
    container
      .bind<DisableEmailSettingBasedOnEmailSubscription>(TYPES.Auth_DisableEmailSettingBasedOnEmailSubscription)
      .toConstantValue(
        new DisableEmailSettingBasedOnEmailSubscription(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<SetSettingValue>(TYPES.Auth_SetSettingValue),
          container.get<SetSubscriptionSettingValue>(TYPES.Auth_SetSubscriptionSettingValue),
          container.get<GetSharedOrRegularSubscriptionForUser>(TYPES.Auth_GetSharedOrRegularSubscriptionForUser),
        ),
      )
    container
      .bind<TriggerEmailBackupForUser>(TYPES.Auth_TriggerEmailBackupForUser)
      .toConstantValue(
        new TriggerEmailBackupForUser(
          container.get<RoleServiceInterface>(TYPES.Auth_RoleService),
          container.get<GetUserKeyParams>(TYPES.Auth_GetUserKeyParams),
          container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
          container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
          container.get<boolean>(TYPES.Auth_EMAIL_BACKUPS_ENABLED),
        ),
      )
    container
      .bind<ReconcilePendingEmailBackupForUser>(TYPES.Auth_ReconcilePendingEmailBackupForUser)
      .toConstantValue(
        new ReconcilePendingEmailBackupForUser(
          container.get<EmailSenderInterface>(TYPES.Auth_EmailSender),
          container.get<BackupAttachmentStorageInterface>(TYPES.Auth_BackupAttachmentStorage),
          container.get<GetSetting>(TYPES.Auth_GetSetting),
          container.get<SetSettingValue>(TYPES.Auth_SetSettingValue),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<winston.Logger>(TYPES.Auth_Logger),
          container.get<EmailBackupStateRepositoryInterface>(TYPES.Auth_EmailBackupStateRepository),
        ),
      )
    container.bind<TriggerEmailBackupForAllUsers>(TYPES.Auth_TriggerEmailBackupForAllUsers).toConstantValue(
      new TriggerEmailBackupForAllUsers(
        container.get<SettingRepositoryInterface>(TYPES.Auth_SettingRepository),
        container.get<TriggerEmailBackupForUser>(TYPES.Auth_TriggerEmailBackupForUser),
        container.get<GetSetting>(TYPES.Auth_GetSetting),
        container.get<TimerInterface>(TYPES.Auth_Timer),
        container.get<winston.Logger>(TYPES.Auth_Logger),
        container.get<boolean>(TYPES.Auth_EMAIL_BACKUPS_ENABLED),
        // Email delivery is "configured" when the SMTP sender reports itself
        // configured (host + from present). Mirrors SmtpEmailSender.isConfigured().
        () => container.get<EmailSenderInterface>(TYPES.Auth_EmailSender).isConfigured(),
        container.get<ReconcilePendingEmailBackupForUser>(TYPES.Auth_ReconcilePendingEmailBackupForUser),
      ),
    )
    container
      .bind<NextcloudBackupStateStore>(TYPES.Auth_NextcloudBackupStateStore)
      .toConstantValue(
        new NextcloudBackupStateStore(
          new TypeORMNextcloudBackupStateRepository(
            appDataSource.dataSource,
            container.get<TimerInterface>(TYPES.Auth_Timer),
          ),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<TriggerNextcloudBackupForUser>(TYPES.Auth_TriggerNextcloudBackupForUser)
      .toConstantValue(
        new TriggerNextcloudBackupForUser(
          container.get<GetUserKeyParams>(TYPES.Auth_GetUserKeyParams),
          container.get<GetSetting>(TYPES.Auth_GetSetting),
          container.get<DomainEventPublisherInterface>(TYPES.Auth_NextcloudBackupDomainEventPublisher),
          container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
        ),
      )
    container.bind<TriggerNextcloudBackupForAllUsers>(TYPES.Auth_TriggerNextcloudBackupForAllUsers).toConstantValue(
      new TriggerNextcloudBackupForAllUsers(
        container.get<SettingRepositoryInterface>(TYPES.Auth_SettingRepository),
        container.get<TriggerNextcloudBackupForUser>(TYPES.Auth_TriggerNextcloudBackupForUser),
        container.get<NextcloudBackupStateStore>(TYPES.Auth_NextcloudBackupStateStore),
        container.get<TimerInterface>(TYPES.Auth_Timer),
        container.get<winston.Logger>(TYPES.Auth_Logger),
        container.get<boolean>(TYPES.Auth_NEXTCLOUD_BACKUPS_ENABLED),
        // Standard Red Notes: runtime admin override of the master gate. The
        // api-gateway persists admin server settings to SERVER_SETTINGS_PATH
        // (the docker entrypoint points both services at the same file); a
        // persisted value WINS over the env boolean above. No shared file /
        // env unset => undefined => the env value applies unchanged.
        (() => {
          const overlayReader = new ServerSettingsOverlayReader(env.get('SERVER_SETTINGS_PATH', true) || undefined)

          return () => overlayReader.nextcloudBackupsEnabled()
        })(),
      ),
    )
    container
      .bind<TriggerPostSettingUpdateActions>(TYPES.Auth_TriggerPostSettingUpdateActions)
      .toConstantValue(
        new TriggerPostSettingUpdateActions(
          container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
          container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
          container.get<TriggerEmailBackupForUser>(TYPES.Auth_TriggerEmailBackupForUser),
          container.get<GenerateRecoveryCodes>(TYPES.Auth_GenerateRecoveryCodes),
          container.get<EmailReminderRepositoryInterface>(TYPES.Auth_EmailReminderRepository),
          container.get<EmailSenderInterface>(TYPES.Auth_EmailReminderSender),
        ),
      )
    container
      .bind<RenewSharedSubscriptions>(TYPES.Auth_RenewSharedSubscriptions)
      .toConstantValue(
        new RenewSharedSubscriptions(
          container.get<ListSharedSubscriptionInvitations>(TYPES.Auth_ListSharedSubscriptionInvitations),
          container.get<SharedSubscriptionInvitationRepositoryInterface>(
            TYPES.Auth_SharedSubscriptionInvitationRepository,
          ),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<RoleServiceInterface>(TYPES.Auth_RoleService),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<FixStorageQuotaForUser>(TYPES.Auth_FixStorageQuotaForUser)
      .toConstantValue(
        new FixStorageQuotaForUser(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<GetRegularSubscriptionForUser>(TYPES.Auth_GetRegularSubscriptionForUser),
          container.get<GetSharedSubscriptionForUser>(TYPES.Auth_GetSharedSubscriptionForUser),
          container.get<SetSubscriptionSettingValue>(TYPES.Auth_SetSubscriptionSettingValue),
          container.get<ListSharedSubscriptionInvitations>(TYPES.Auth_ListSharedSubscriptionInvitations),
          container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
          container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    // Standard Red Notes: skipped in 'cli' mode — its CSV reader needs the S3
    // client the lean CLI boot does not construct, and the srn-admin CLI never
    // resolves this use case.
    if (!isConfiguredForHomeServer && !isConfiguredForCli) {
      container
        .bind<DeleteAccountsFromCSVFile>(TYPES.Auth_DeleteAccountsFromCSVFile)
        .toConstantValue(
          new DeleteAccountsFromCSVFile(
            container.get<CSVFileReaderInterface>(TYPES.Auth_CSVFileReader),
            container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
            container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
            container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
            container.get<winston.Logger>(TYPES.Auth_Logger),
          ),
        )
    }

    // Controller
    container
      .bind<ControllerContainerInterface>(TYPES.Auth_ControllerContainer)
      .toConstantValue(configuration?.controllerConatiner ?? new ControllerContainer())
    container
      .bind<AuthController>(TYPES.Auth_AuthController)
      .toConstantValue(
        new AuthController(
          container.get<GetUserKeyParamsRecovery>(TYPES.Auth_GetUserKeyParamsRecovery),
          container.get<GenerateRecoveryCodes>(TYPES.Auth_GenerateRecoveryCodes),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<AuthenticatorsController>(TYPES.Auth_AuthenticatorsController)
      .toConstantValue(
        new AuthenticatorsController(
          container.get(TYPES.Auth_GenerateAuthenticatorRegistrationOptions),
          container.get(TYPES.Auth_VerifyAuthenticatorRegistrationResponse),
          container.get(TYPES.Auth_GenerateAuthenticatorAuthenticationOptions),
          container.get(TYPES.Auth_ListAuthenticators),
          container.get(TYPES.Auth_DeleteAuthenticator),
          container.get(TYPES.Auth_AuthenticatorHttpMapper),
        ),
      )
    container
      .bind<AppPasswordsController>(TYPES.Auth_AppPasswordsController)
      .toConstantValue(
        new AppPasswordsController(
          container.get(TYPES.Auth_CreateAppPassword),
          container.get(TYPES.Auth_ListAppPasswords),
          container.get(TYPES.Auth_DeleteAppPassword),
          container.get(TYPES.Auth_RevokeAppPassword),
          container.get(TYPES.Auth_AppPasswordHttpMapper),
        ),
      )
    container
      .bind<McpTokensController>(TYPES.Auth_McpTokensController)
      .toConstantValue(
        new McpTokensController(
          container.get(TYPES.Auth_CreateMcpToken),
          container.get(TYPES.Auth_ListMcpTokens),
          container.get(TYPES.Auth_DeleteMcpToken),
          container.get(TYPES.Auth_AuthenticateWithMcpToken),
          container.get(TYPES.Auth_GetMcpTokenKeys),
          container.get(TYPES.Auth_McpTokenHttpMapper),
          container.get(TYPES.Auth_AuthResponseFactoryResolver),
          container.get(TYPES.Auth_UserRepository),
          container.get(TYPES.Auth_SessionRepository),
        ),
      )
    container
      .bind<WebhooksController>(TYPES.Auth_WebhooksController)
      .toConstantValue(
        new WebhooksController(
          container.get(TYPES.Auth_RegisterWebhook),
          container.get(TYPES.Auth_ListWebhooks),
          container.get(TYPES.Auth_DeleteWebhook),
          container.get(TYPES.Auth_WebhookHttpMapper),
          container.get(TYPES.Auth_AuditLogWriter),
        ),
      )
    container
      .bind<SharesController>(TYPES.Auth_SharesController)
      .toConstantValue(
        new SharesController(
          container.get(TYPES.Auth_CreateShare),
          container.get(TYPES.Auth_ListShares),
          container.get(TYPES.Auth_RevokeShare),
          container.get(TYPES.Auth_GetShare),
          container.get(TYPES.Auth_ShareHttpMapper),
        ),
      )
    container
      .bind<DeadManSwitchesController>(TYPES.Auth_DeadManSwitchesController)
      .toConstantValue(
        new DeadManSwitchesController(
          container.get(TYPES.Auth_CreateDeadManSwitch),
          container.get(TYPES.Auth_ListDeadManSwitches),
          container.get(TYPES.Auth_CheckInDeadManSwitch),
          container.get(TYPES.Auth_DeleteDeadManSwitch),
          container.get(TYPES.Auth_DeadManSwitchHttpMapper),
        ),
      )
    container
      .bind<EmailRemindersController>(TYPES.Auth_EmailRemindersController)
      .toConstantValue(
        new EmailRemindersController(
          container.get(TYPES.Auth_CreateEmailReminder),
          container.get(TYPES.Auth_ListEmailReminders),
          container.get(TYPES.Auth_DeleteEmailReminder),
          container.get(TYPES.Auth_EmailReminderHttpMapper),
        ),
      )
    container
      .bind<TrustedDevicesController>(TYPES.Auth_TrustedDevicesController)
      .toConstantValue(
        new TrustedDevicesController(
          container.get(TYPES.Auth_CreateTrustedDevice),
          container.get(TYPES.Auth_ListTrustedDevices),
          container.get(TYPES.Auth_DeleteTrustedDevice),
          container.get(TYPES.Auth_TrustedDeviceHttpMapper),
        ),
      )
    container
      .bind<PendingMfaApprovalsController>(TYPES.Auth_PendingMfaApprovalsController)
      .toConstantValue(
        new PendingMfaApprovalsController(
          container.get(TYPES.Auth_ListPendingMfaApprovals),
          container.get(TYPES.Auth_ResolvePendingMfaApproval),
          container.get(TYPES.Auth_GetPendingMfaApprovalStatus),
          container.get(TYPES.Auth_PendingMfaApprovalHttpMapper),
        ),
      )
    container
      .bind<MagicLinkController>(TYPES.Auth_MagicLinkController)
      .toConstantValue(
        new MagicLinkController(
          container.get(TYPES.Auth_GenerateMagicLinkCode),
          container.get(TYPES.Auth_SetSettingValue),
          container.get(TYPES.Auth_GetSetting),
        ),
      )
    container
      .bind<SubscriptionInvitesController>(TYPES.Auth_SubscriptionInvitesController)
      .to(SubscriptionInvitesController)
    container.bind<UserRequestsController>(TYPES.Auth_UserRequestsController).to(UserRequestsController)

    // Handlers
    container
      .bind<AccountDeletionRequestedEventHandler>(TYPES.Auth_AccountDeletionRequestedEventHandler)
      .toConstantValue(
        new AccountDeletionRequestedEventHandler(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<SessionRepositoryInterface>(TYPES.Auth_SessionRepository),
          container.get<EphemeralSessionRepositoryInterface>(TYPES.Auth_EphemeralSessionRepository),
          container.get<RevokedSessionRepositoryInterface>(TYPES.Auth_RevokedSessionRepository),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<AccountDeletionVerificationPassedEventHandler>(TYPES.Auth_AccountDeletionVerificationPassedEventHandler)
      .toConstantValue(
        new AccountDeletionVerificationPassedEventHandler(
          container.get<DeleteAccount>(TYPES.Auth_DeleteAccount),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<SubscriptionPurchasedEventHandler>(TYPES.Auth_SubscriptionPurchasedEventHandler)
      .toConstantValue(
        new SubscriptionPurchasedEventHandler(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          container.get<ApplyDefaultSubscriptionSettings>(TYPES.Auth_ApplyDefaultSubscriptionSettings),
          container.get<OfflineUserSubscriptionRepositoryInterface>(TYPES.Auth_OfflineUserSubscriptionRepository),
          container.get<RoleServiceInterface>(TYPES.Auth_RoleService),
          container.get<RenewSharedSubscriptions>(TYPES.Auth_RenewSharedSubscriptions),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<SubscriptionCancelledEventHandler>(TYPES.Auth_SubscriptionCancelledEventHandler)
      .to(SubscriptionCancelledEventHandler)
    container
      .bind<SubscriptionRenewedEventHandler>(TYPES.Auth_SubscriptionRenewedEventHandler)
      .to(SubscriptionRenewedEventHandler)
    container
      .bind<SubscriptionRefundedEventHandler>(TYPES.Auth_SubscriptionRefundedEventHandler)
      .to(SubscriptionRefundedEventHandler)
    container
      .bind<SubscriptionExpiredEventHandler>(TYPES.Auth_SubscriptionExpiredEventHandler)
      .to(SubscriptionExpiredEventHandler)
    container
      .bind<SubscriptionSyncRequestedEventHandler>(TYPES.Auth_SubscriptionSyncRequestedEventHandler)
      .toConstantValue(
        new SubscriptionSyncRequestedEventHandler(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          container.get<OfflineUserSubscriptionRepositoryInterface>(TYPES.Auth_OfflineUserSubscriptionRepository),
          container.get<RoleServiceInterface>(TYPES.Auth_RoleService),
          container.get<ApplyDefaultSubscriptionSettings>(TYPES.Auth_ApplyDefaultSubscriptionSettings),
          container.get<SetSettingValue>(TYPES.Auth_SetSettingValue),
          container.get<OfflineSettingServiceInterface>(TYPES.Auth_OfflineSettingService),
          container.get<ContentDecoderInterface>(TYPES.Auth_ContenDecoder),
          container.get<RenewSharedSubscriptions>(TYPES.Auth_RenewSharedSubscriptions),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<ExtensionKeyGrantedEventHandler>(TYPES.Auth_ExtensionKeyGrantedEventHandler)
      .toConstantValue(
        new ExtensionKeyGrantedEventHandler(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<SetSettingValue>(TYPES.Auth_SetSettingValue),
          container.get<OfflineSettingServiceInterface>(TYPES.Auth_OfflineSettingService),
          container.get<ContentDecoderInterface>(TYPES.Auth_ContenDecoder),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<SubscriptionReassignedEventHandler>(TYPES.Auth_SubscriptionReassignedEventHandler)
      .toConstantValue(
        new SubscriptionReassignedEventHandler(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          container.get<RoleServiceInterface>(TYPES.Auth_RoleService),
          container.get<winston.Logger>(TYPES.Auth_Logger),
          container.get<ApplyDefaultSubscriptionSettings>(TYPES.Auth_ApplyDefaultSubscriptionSettings),
          container.get<SetSettingValue>(TYPES.Auth_SetSettingValue),
        ),
      )
    container
      .bind<FileUploadedEventHandler>(TYPES.Auth_FileUploadedEventHandler)
      .toConstantValue(
        new FileUploadedEventHandler(
          container.get(TYPES.Auth_UpdateStorageQuotaUsedForUser),
          container.get(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<SharedVaultFileUploadedEventHandler>(TYPES.Auth_SharedVaultFileUploadedEventHandler)
      .toConstantValue(
        new SharedVaultFileUploadedEventHandler(
          container.get(TYPES.Auth_UpdateStorageQuotaUsedForUser),
          container.get(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<SharedVaultFileMovedEventHandler>(TYPES.Auth_SharedVaultFileMovedEventHandler)
      .toConstantValue(
        new SharedVaultFileMovedEventHandler(
          container.get(TYPES.Auth_UpdateStorageQuotaUsedForUser),
          container.get(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<FileRemovedEventHandler>(TYPES.Auth_FileRemovedEventHandler)
      .toConstantValue(
        new FileRemovedEventHandler(
          container.get(TYPES.Auth_UpdateStorageQuotaUsedForUser),
          container.get(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<SharedVaultFileRemovedEventHandler>(TYPES.Auth_SharedVaultFileRemovedEventHandler)
      .toConstantValue(
        new SharedVaultFileRemovedEventHandler(
          container.get(TYPES.Auth_UpdateStorageQuotaUsedForUser),
          container.get(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<UserDisabledSessionUserAgentLoggingEventHandler>(TYPES.Auth_UserDisabledSessionUserAgentLoggingEventHandler)
      .to(UserDisabledSessionUserAgentLoggingEventHandler)
    container
      .bind<SharedSubscriptionInvitationCreatedEventHandler>(TYPES.Auth_SharedSubscriptionInvitationCreatedEventHandler)
      .to(SharedSubscriptionInvitationCreatedEventHandler)
    container
      .bind<PredicateVerificationRequestedEventHandler>(TYPES.Auth_PredicateVerificationRequestedEventHandler)
      .to(PredicateVerificationRequestedEventHandler)

    container
      .bind<EmailSubscriptionUnsubscribedEventHandler>(TYPES.Auth_EmailSubscriptionUnsubscribedEventHandler)
      .toConstantValue(
        new EmailSubscriptionUnsubscribedEventHandler(
          container.get<DisableEmailSettingBasedOnEmailSubscription>(
            TYPES.Auth_DisableEmailSettingBasedOnEmailSubscription,
          ),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<PaymentsAccountDeletedEventHandler>(TYPES.Auth_PaymentsAccountDeletedEventHandler)
      .toConstantValue(
        new PaymentsAccountDeletedEventHandler(
          container.get(TYPES.Auth_DeleteAccount),
          container.get(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<UserAddedToSharedVaultEventHandler>(TYPES.Auth_UserAddedToSharedVaultEventHandler)
      .toConstantValue(
        new UserAddedToSharedVaultEventHandler(
          container.get<AddSharedVaultUser>(TYPES.Auth_AddSharedVaultUser),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<UserRemovedFromSharedVaultEventHandler>(TYPES.Auth_UserRemovedFromSharedVaultEventHandler)
      .toConstantValue(
        new UserRemovedFromSharedVaultEventHandler(
          container.get<RemoveSharedVaultUser>(TYPES.Auth_RemoveSharedVaultUser),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<UserDesignatedAsSurvivorInSharedVaultEventHandler>(
        TYPES.Auth_UserDesignatedAsSurvivorInSharedVaultEventHandler,
      )
      .toConstantValue(
        new UserDesignatedAsSurvivorInSharedVaultEventHandler(
          container.get<DesignateSurvivor>(TYPES.Auth_DesignateSurvivor),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<UserInvitedToSharedVaultEventHandler>(TYPES.Auth_UserInvitedToSharedVaultEventHandler)
      .toConstantValue(
        new UserInvitedToSharedVaultEventHandler(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
          container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
        ),
      )
    container
      .bind<FileQuotaRecalculatedEventHandler>(TYPES.Auth_FileQuotaRecalculatedEventHandler)
      .toConstantValue(
        new FileQuotaRecalculatedEventHandler(
          container.get<UpdateStorageQuotaUsedForUser>(TYPES.Auth_UpdateStorageQuotaUsedForUser),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<SubscriptionStateFetchedEventHandler>(TYPES.Auth_SubscriptionStateFetchedEventHandler)
      .toConstantValue(
        new SubscriptionStateFetchedEventHandler(
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<UserSubscriptionRepositoryInterface>(TYPES.Auth_UserSubscriptionRepository),
          container.get<OfflineUserSubscriptionRepositoryInterface>(TYPES.Auth_OfflineUserSubscriptionRepository),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )
    container
      .bind<WebhookItemDeletedEventHandler>(TYPES.Auth_WebhookItemDeletedEventHandler)
      .toConstantValue(new WebhookItemDeletedEventHandler(container.get(TYPES.Auth_WebhookDispatcher)))
    container
      .bind<WebhookItemsChangedEventHandler>(TYPES.Auth_WebhookItemsChangedEventHandler)
      .toConstantValue(new WebhookItemsChangedEventHandler(container.get(TYPES.Auth_WebhookDispatcher)))
    container
      .bind<EmailRequestedEventHandler>(TYPES.Auth_EmailRequestedEventHandler)
      .toConstantValue(
        new EmailRequestedEventHandler(
          container.get<EmailSenderInterface>(TYPES.Auth_EmailSender),
          container.get<BackupAttachmentStorageInterface>(TYPES.Auth_BackupAttachmentStorage),
          container.get<GetSetting>(TYPES.Auth_GetSetting),
          container.get<SetSettingValue>(TYPES.Auth_SetSettingValue),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<boolean>(TYPES.Auth_EMAIL_BACKUPS_ENABLED),
          container.get<winston.Logger>(TYPES.Auth_Logger),
          container.get<EmailBackupStateRepositoryInterface>(TYPES.Auth_EmailBackupStateRepository),
        ),
      )
    container
      .bind<NextcloudBackupCompletedEventHandler>(TYPES.Auth_NextcloudBackupCompletedEventHandler)
      .toConstantValue(
        new NextcloudBackupCompletedEventHandler(
          container.get<NextcloudBackupStateStore>(TYPES.Auth_NextcloudBackupStateStore),
          container.get<TimerInterface>(TYPES.Auth_Timer),
          container.get<winston.Logger>(TYPES.Auth_Logger),
        ),
      )

    const eventHandlers: Map<string, DomainEventHandlerInterface> = new Map([
      ['ACCOUNT_DELETION_REQUESTED', container.get(TYPES.Auth_AccountDeletionRequestedEventHandler)],
      ['ACCOUNT_DELETION_VERIFICATION_PASSED', container.get(TYPES.Auth_AccountDeletionVerificationPassedEventHandler)],
      ['SUBSCRIPTION_PURCHASED', container.get(TYPES.Auth_SubscriptionPurchasedEventHandler)],
      ['SUBSCRIPTION_CANCELLED', container.get(TYPES.Auth_SubscriptionCancelledEventHandler)],
      ['SUBSCRIPTION_RENEWED', container.get(TYPES.Auth_SubscriptionRenewedEventHandler)],
      ['SUBSCRIPTION_REFUNDED', container.get(TYPES.Auth_SubscriptionRefundedEventHandler)],
      ['SUBSCRIPTION_EXPIRED', container.get(TYPES.Auth_SubscriptionExpiredEventHandler)],
      ['SUBSCRIPTION_SYNC_REQUESTED', container.get(TYPES.Auth_SubscriptionSyncRequestedEventHandler)],
      ['EXTENSION_KEY_GRANTED', container.get(TYPES.Auth_ExtensionKeyGrantedEventHandler)],
      ['SUBSCRIPTION_REASSIGNED', container.get(TYPES.Auth_SubscriptionReassignedEventHandler)],
      ['FILE_UPLOADED', container.get(TYPES.Auth_FileUploadedEventHandler)],
      ['SHARED_VAULT_FILE_UPLOADED', container.get(TYPES.Auth_SharedVaultFileUploadedEventHandler)],
      ['SHARED_VAULT_FILE_MOVED', container.get(TYPES.Auth_SharedVaultFileMovedEventHandler)],
      ['FILE_REMOVED', container.get(TYPES.Auth_FileRemovedEventHandler)],
      ['SHARED_VAULT_FILE_REMOVED', container.get(TYPES.Auth_SharedVaultFileRemovedEventHandler)],
      [
        'USER_DISABLED_SESSION_USER_AGENT_LOGGING',
        container.get(TYPES.Auth_UserDisabledSessionUserAgentLoggingEventHandler),
      ],
      [
        'SHARED_SUBSCRIPTION_INVITATION_CREATED',
        container.get(TYPES.Auth_SharedSubscriptionInvitationCreatedEventHandler),
      ],
      ['PREDICATE_VERIFICATION_REQUESTED', container.get(TYPES.Auth_PredicateVerificationRequestedEventHandler)],
      ['EMAIL_SUBSCRIPTION_UNSUBSCRIBED', container.get(TYPES.Auth_EmailSubscriptionUnsubscribedEventHandler)],
      ['EMAIL_REQUESTED', container.get(TYPES.Auth_EmailRequestedEventHandler)],
      ['NEXTCLOUD_BACKUP_COMPLETED', container.get(TYPES.Auth_NextcloudBackupCompletedEventHandler)],
      ['PAYMENTS_ACCOUNT_DELETED', container.get(TYPES.Auth_PaymentsAccountDeletedEventHandler)],
      ['USER_ADDED_TO_SHARED_VAULT', container.get(TYPES.Auth_UserAddedToSharedVaultEventHandler)],
      ['USER_REMOVED_FROM_SHARED_VAULT', container.get(TYPES.Auth_UserRemovedFromSharedVaultEventHandler)],
      [
        'USER_DESIGNATED_AS_SURVIVOR_IN_SHARED_VAULT',
        container.get(TYPES.Auth_UserDesignatedAsSurvivorInSharedVaultEventHandler),
      ],
      ['USER_INVITED_TO_SHARED_VAULT', container.get(TYPES.Auth_UserInvitedToSharedVaultEventHandler)],
      [
        'FILE_QUOTA_RECALCULATED',
        container.get<FileQuotaRecalculatedEventHandler>(TYPES.Auth_FileQuotaRecalculatedEventHandler),
      ],
      ['SUBSCRIPTION_STATE_FETCHED', container.get(TYPES.Auth_SubscriptionStateFetchedEventHandler)],
      // Standard Red Notes: bridge internal item events onto outbound webhooks.
      ['ITEM_DELETED', container.get(TYPES.Auth_WebhookItemDeletedEventHandler)],
      ['ITEMS_CHANGED_ON_SERVER', container.get(TYPES.Auth_WebhookItemsChangedEventHandler)],
    ])

    if (isConfiguredForHomeServer) {
      const directCallEventMessageHandler = new DirectCallEventMessageHandler(
        eventHandlers,
        container.get(TYPES.Auth_Logger),
      )
      directCallDomainEventPublisher.register(directCallEventMessageHandler)
      container
        .bind<DomainEventMessageHandlerInterface>(TYPES.Auth_DomainEventMessageHandler)
        .toConstantValue(directCallEventMessageHandler)
    } else if (!isConfiguredForCli) {
      // Standard Red Notes: the SQS subscriber wiring needs the SQS client the
      // lean 'cli' boot does not construct — and the CLI never consumes events
      // (only bin/worker.ts resolves the subscriber).
      container
        .bind<DomainEventMessageHandlerInterface>(TYPES.Auth_DomainEventMessageHandler)
        .toConstantValue(new SQSEventMessageHandler(eventHandlers, container.get(TYPES.Auth_Logger)))

      container
        .bind<DomainEventSubscriberInterface>(TYPES.Auth_DomainEventSubscriber)
        .toConstantValue(
          new SQSDomainEventSubscriber(
            container.get<SQSClient>(TYPES.Auth_SQS),
            container.get<string>(TYPES.Auth_SQS_QUEUE_URL),
            container.get<DomainEventMessageHandlerInterface>(TYPES.Auth_DomainEventMessageHandler),
            container.get<winston.Logger>(TYPES.Auth_Logger),
          ),
        )
    }

    container
      .bind<BaseAuthController>(TYPES.Auth_BaseAuthController)
      .toConstantValue(
        new BaseAuthController(
          container.get<VerifyMFA>(TYPES.Auth_VerifyMFA),
          container.get<SignIn>(TYPES.Auth_SignIn),
          container.get<GetUserKeyParams>(TYPES.Auth_GetUserKeyParams),
          container.get<ClearLoginAttempts>(TYPES.Auth_ClearLoginAttempts),
          container.get<IncreaseLoginAttempts>(TYPES.Auth_IncreaseLoginAttempts),
          container.get<winston.Logger>(TYPES.Auth_Logger),
          container.get<AuthController>(TYPES.Auth_AuthController),
          container.get<Register>(TYPES.Auth_Register),
          container.get<DomainEventPublisherInterface>(TYPES.Auth_DomainEventPublisher),
          container.get<DomainEventFactoryInterface>(TYPES.Auth_DomainEventFactory),
          container.get<SessionServiceInterface>(TYPES.Auth_SessionService),
          container.get<VerifyHumanInteraction>(TYPES.Auth_VerifyHumanInteraction),
          container.get<CookieFactoryInterface>(TYPES.Auth_CookieFactory),
          container.get<SignInWithRecoveryCodes>(TYPES.Auth_SignInWithRecoveryCodes),
          container.get<DeleteSessionByToken>(TYPES.Auth_DeleteSessionByToken),
          container.get<string>(TYPES.Auth_CAPTCHA_UI_URL),
          container.get<VerifyAppPassword>(TYPES.Auth_VerifyAppPassword),
          container.get<VerifyTrustedDevice>(TYPES.Auth_VerifyTrustedDevice),
          container.get<CreatePendingMfaApproval>(TYPES.Auth_CreatePendingMfaApproval),
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<ProofOfWorkGate>(TYPES.Auth_ProofOfWorkGate),
          container.get<VerifyEmailConfirmation>(TYPES.Auth_VerifyEmailConfirmation),
          container.get<ResendEmailConfirmation>(TYPES.Auth_ResendEmailConfirmation),
          container.get<GetAccountRecoveryEscrow>(TYPES.Auth_GetAccountRecoveryEscrow),
          container.get<ControllerContainerInterface>(TYPES.Auth_ControllerContainer),
        ),
      )

    // Inversify Controllers
    if (isConfiguredForHomeServer) {
      container
        .bind<BaseAuthenticatorsController>(TYPES.Auth_BaseAuthenticatorsController)
        .toConstantValue(
          new BaseAuthenticatorsController(
            container.get(TYPES.Auth_AuthenticatorsController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseAppPasswordsController>(TYPES.Auth_BaseAppPasswordsController)
        .toConstantValue(
          new BaseAppPasswordsController(
            container.get(TYPES.Auth_AppPasswordsController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      // Standard Red Notes: SELF-SERVE invite links (auth.meInviteLinks.*). Bound
      // here on the home-server path so the constructor registers the three
      // DirectCall handlers with the controllerContainer; the multi-container path
      // reaches these via AnnotatedMeInviteLinksController's @httpX routes instead.
      container
        .bind<BaseMeInviteLinksController>(TYPES.Auth_BaseMeInviteLinksController)
        .toConstantValue(
          new BaseMeInviteLinksController(
            container.get(TYPES.Auth_RegistrationConfigResolver),
            container.get(TYPES.Auth_SignupInviteLinkRepository),
            container.get(TYPES.Auth_SignupInviteUseRepository),
            container.get(TYPES.Auth_CreateSignupInviteLink),
            container.get(TYPES.Auth_ListSignupInviteLinks),
            container.get(TYPES.Auth_RevokeSignupInviteLink),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseMcpTokensController>(TYPES.Auth_BaseMcpTokensController)
        .toConstantValue(
          new BaseMcpTokensController(
            container.get(TYPES.Auth_McpTokensController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseWebhooksController>(TYPES.Auth_BaseWebhooksController)
        .toConstantValue(
          new BaseWebhooksController(
            container.get(TYPES.Auth_WebhooksController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseSharesController>(TYPES.Auth_BaseSharesController)
        .toConstantValue(
          new BaseSharesController(
            container.get(TYPES.Auth_SharesController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseDeadManSwitchesController>(TYPES.Auth_BaseDeadManSwitchesController)
        .toConstantValue(
          new BaseDeadManSwitchesController(
            container.get(TYPES.Auth_DeadManSwitchesController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseEmailRemindersController>(TYPES.Auth_BaseEmailRemindersController)
        .toConstantValue(
          new BaseEmailRemindersController(
            container.get(TYPES.Auth_EmailRemindersController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseTrustedDevicesController>(TYPES.Auth_BaseTrustedDevicesController)
        .toConstantValue(
          new BaseTrustedDevicesController(
            container.get(TYPES.Auth_TrustedDevicesController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BasePendingMfaApprovalsController>(TYPES.Auth_BasePendingMfaApprovalsController)
        .toConstantValue(
          new BasePendingMfaApprovalsController(
            container.get(TYPES.Auth_PendingMfaApprovalsController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseMagicLinkController>(TYPES.Auth_BaseMagicLinkController)
        .toConstantValue(
          new BaseMagicLinkController(
            container.get(TYPES.Auth_MagicLinkController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseSubscriptionInvitesController>(TYPES.Auth_BaseSubscriptionInvitesController)
        .toConstantValue(
          new BaseSubscriptionInvitesController(
            container.get(TYPES.Auth_SubscriptionInvitesController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseUserRequestsController>(TYPES.Auth_BaseUserRequestsController)
        .toConstantValue(
          new BaseUserRequestsController(
            container.get(TYPES.Auth_UserRequestsController),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseWebSocketsController>(TYPES.Auth_BaseWebSocketsController)
        .toConstantValue(
          new BaseWebSocketsController(
            container.get(TYPES.Auth_CreateCrossServiceToken),
            container.get(TYPES.Auth_WebSocketConnectionTokenDecoder),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseSessionsController>(TYPES.Auth_BaseSessionsController)
        .toConstantValue(
          new BaseSessionsController(
            container.get(TYPES.Auth_GetActiveSessionsForUser),
            container.get(TYPES.Auth_AuthenticateRequest),
            container.get(TYPES.Auth_SessionProjector),
            container.get(TYPES.Auth_CreateCrossServiceToken),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseValetTokenController>(TYPES.Auth_BaseValetTokenController)
        .toConstantValue(
          new BaseValetTokenController(
            container.get(TYPES.Auth_CreateValetToken),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseUsersController>(TYPES.Auth_BaseUsersController)
        .toConstantValue(
          new BaseUsersController(
            container.get<DeleteAccount>(TYPES.Auth_DeleteAccount),
            container.get<GetUserSubscription>(TYPES.Auth_GetUserSubscription),
            container.get<ClearLoginAttempts>(TYPES.Auth_ClearLoginAttempts),
            container.get<IncreaseLoginAttempts>(TYPES.Auth_IncreaseLoginAttempts),
            container.get<ChangeCredentials>(TYPES.Auth_ChangeCredentials),
            container.get<CookieFactoryInterface>(TYPES.Auth_CookieFactory),
            container.get<ControllerContainerInterface>(TYPES.Auth_ControllerContainer),
          ),
        )
      container.bind<BaseAdminController>(TYPES.Auth_BaseAdminController).toConstantValue(
        new BaseAdminController(
          container.get<DeleteSetting>(TYPES.Auth_DeleteSetting),
          container.get<GetSetting>(TYPES.Auth_GetSetting),
          container.get<UserRepositoryInterface>(TYPES.Auth_UserRepository),
          container.get<CreateSubscriptionToken>(TYPES.Auth_CreateSubscriptionToken),
          container.get<CreateOfflineSubscriptionToken>(TYPES.Auth_CreateOfflineSubscriptionToken),
          container.get<SetSettingValue>(TYPES.Auth_SetSettingValue),
          container.get<SetUserBanStatus>(TYPES.Auth_SetUserBanStatus),
          container.get<QueryAuditLog>(TYPES.Auth_QueryAuditLog),
          container.get(TYPES.Auth_AuditLogEntryHttpMapper),
          container.get<AuditLogWriterInterface>(TYPES.Auth_AuditLogWriter),
          container.get<ControllerContainerInterface>(TYPES.Auth_ControllerContainer),
          container.get<WebhookDispatcherInterface>(TYPES.Auth_WebhookDispatcher),
          // Standard Red Notes: per-user SERVER storage-limit dependencies (the
          // upload limit is a subscription setting; see BaseAdminController).
          container.get<GetRegularSubscriptionForUser>(TYPES.Auth_GetRegularSubscriptionForUser),
          container.get<GetSubscriptionSetting>(TYPES.Auth_GetSubscriptionSetting),
          container.get<SetSubscriptionSettingValue>(TYPES.Auth_SetSubscriptionSettingValue),
          // Standard Red Notes: admin-role grant/revoke + reset-mfa/fix-quota
          // panel ops, and the read-only env master switches (see
          // BaseAdminController). The trailing RBAC group deps remain omitted
          // here, mirroring the pre-existing home-server behaviour.
          container.get<RoleServiceInterface>(TYPES.Auth_RoleService),
          container.get<FixStorageQuotaForUser>(TYPES.Auth_FixStorageQuotaForUser),
          container.get<boolean>(TYPES.Auth_DISABLE_USER_REGISTRATION),
          container.get<boolean>(TYPES.Auth_NEXTCLOUD_BACKUPS_ENABLED),
          // Standard Red Notes: the RBAC group + role-management deps stay
          // undefined on the home-server single-process path (pre-existing
          // behaviour; those endpoints degrade to "not available" here). They
          // are passed explicitly as `undefined` only so the trailing
          // lockRepository — the LAST positional constructor arg — can be wired
          // by position without pulling the group/RBAC surface in.
          undefined, // doCreateGroup
          undefined, // doListGroups
          undefined, // doDeleteGroup
          undefined, // doAddUserToGroup
          undefined, // doRemoveUserFromGroup
          undefined, // doSetGroupRoles
          undefined, // doListGroupMembers
          undefined, // doGetUserEffectivePermissions
          undefined, // groupHttpMapper
          undefined, // doListRolesWithPermissions
          undefined, // doSetRolePermissions
          undefined, // doCreateCustomRole
          undefined, // doDeleteCustomRole
          undefined, // doGetPermissionCatalog
          undefined, // doGetRoleHolders
          undefined, // doResolveRoleSetPermissions
          // Standard Red Notes: failed-login lock repository, backing the
          // anti-abuse "Locked accounts" list + unlock on the single-container
          // deploy. Auth_LockRepository is always bound (RedisLockRepository
          // under a Redis cache, TypeORMLockRepository under the in-memory/
          // TypeORM cache topology). Wiring it here makes UNLOCK (resetLockCounter)
          // work on the single container; the LIST endpoint additionally requires
          // the Redis SCAN-based listLockedAccounts, so under the TypeORM cache
          // topology it correctly reports `available:false` (see
          // BaseAdminController.getLockedAccounts / LockRepositoryInterface).
          container.get<LockRepositoryInterface>(TYPES.Auth_LockRepository),
          // Standard Red Notes: admin SUSPEND/UNSUSPEND + admin-initiated
          // DELETE. Wired on the single-container path too so the admin panel's
          // suspend/delete endpoints work there. Delete reuses the existing
          // cross-service DeleteAccount pipeline (Auth_DeleteAccount).
          container.get<SetUserSuspension>(TYPES.Auth_SetUserSuspension),
          container.get<DeleteAccount>(TYPES.Auth_DeleteAccount),
          // Standard Red Notes: SIGNUP INVITE LINKS admin surface — wired on the
          // single-container path too so the admin panel's invite-link
          // create/list/revoke endpoints work there.
          container.get<CreateSignupInviteLink>(TYPES.Auth_CreateSignupInviteLink),
          container.get<ListSignupInviteLinks>(TYPES.Auth_ListSignupInviteLinks),
          container.get<RevokeSignupInviteLink>(TYPES.Auth_RevokeSignupInviteLink),
          // Standard Red Notes: APPROVAL QUEUE — wired on the single-container
          // path too so the admin panel's pending-users list/approve/reject work.
          container.get<ListPendingUsers>(TYPES.Auth_ListPendingUsers),
          container.get<ApproveUser>(TYPES.Auth_ApproveUser),
          container.get<RejectUser>(TYPES.Auth_RejectUser),
        ),
      )
      container
        .bind<BaseSubscriptionTokensController>(TYPES.Auth_BaseSubscriptionTokensController)
        .toConstantValue(
          new BaseSubscriptionTokensController(
            container.get<CreateSubscriptionToken>(TYPES.Auth_CreateSubscriptionToken),
            container.get<AuthenticateSubscriptionToken>(TYPES.Auth_AuthenticateSubscriptionToken),
            container.get<GetSetting>(TYPES.Auth_GetSetting),
            container.get<ProjectorInterface<User>>(TYPES.Auth_UserProjector),
            container.get<ProjectorInterface<Role>>(TYPES.Auth_RoleProjector),
            container.get<TokenEncoderInterface<CrossServiceTokenData>>(TYPES.Auth_CrossServiceTokenEncoder),
            container.get<number>(TYPES.Auth_AUTH_JWT_TTL),
            container.get<ControllerContainerInterface>(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseSubscriptionSettingsController>(TYPES.Auth_BaseSubscriptionSettingsController)
        .toConstantValue(
          new BaseSubscriptionSettingsController(
            container.get<GetSubscriptionSetting>(TYPES.Auth_GetSubscriptionSetting),
            container.get<GetSharedOrRegularSubscriptionForUser>(TYPES.Auth_GetSharedOrRegularSubscriptionForUser),
            container.get<SetSubscriptionSettingValue>(TYPES.Auth_SetSubscriptionSettingValue),
            container.get<TriggerPostSettingUpdateActions>(TYPES.Auth_TriggerPostSettingUpdateActions),
            container.get<MapperInterface<SubscriptionSetting, SubscriptionSettingHttpRepresentation>>(
              TYPES.Auth_SubscriptionSettingHttpMapper,
            ),
            container.get<winston.Logger>(TYPES.Auth_Logger),
            container.get<ControllerContainerInterface>(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseSettingsController>(TYPES.Auth_BaseSettingsController)
        .toConstantValue(
          new BaseSettingsController(
            container.get<GetAllSettingsForUser>(TYPES.Auth_GetAllSettingsForUser),
            container.get<GetSetting>(TYPES.Auth_GetSetting),
            container.get<SetSettingValue>(TYPES.Auth_SetSettingValue),
            container.get<TriggerPostSettingUpdateActions>(TYPES.Auth_TriggerPostSettingUpdateActions),
            container.get<DeleteSetting>(TYPES.Auth_DeleteSetting),
            container.get<GetMfaSecret>(TYPES.Auth_GetMfaSecret),
            container.get<ValidateMfaToken>(TYPES.Auth_ValidateMfaToken),
            container.get<MapperInterface<Setting, SettingHttpRepresentation>>(TYPES.Auth_SettingHttpMapper),
            container.get<MapperInterface<SubscriptionSetting, SubscriptionSettingHttpRepresentation>>(
              TYPES.Auth_SubscriptionSettingHttpMapper,
            ),
            container.get<winston.Logger>(TYPES.Auth_Logger),
            container.get<ControllerContainerInterface>(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseSessionController>(TYPES.Auth_BaseSessionController)
        .toConstantValue(
          new BaseSessionController(
            container.get<DeleteSessionForUser>(TYPES.Auth_DeleteSessionForUser),
            container.get<DeleteOtherSessionsForUser>(TYPES.Auth_DeleteOtherSessionsForUser),
            container.get<RefreshSessionToken>(TYPES.Auth_RefreshSessionToken),
            container.get<CookieFactoryInterface>(TYPES.Auth_CookieFactory),
            container.get<ControllerContainerInterface>(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseOfflineController>(TYPES.Auth_BaseOfflineController)
        .toConstantValue(
          new BaseOfflineController(
            container.get(TYPES.Auth_GetUserFeatures),
            container.get(TYPES.Auth_GetUserOfflineSubscription),
            container.get(TYPES.Auth_CreateOfflineSubscriptionToken),
            container.get(TYPES.Auth_AuthenticateOfflineSubscriptionToken),
            container.get(TYPES.Auth_OfflineUserTokenEncoder),
            container.get(TYPES.Auth_AUTH_JWT_TTL),
            container.get(TYPES.Auth_Logger),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
      container
        .bind<BaseFeaturesController>(TYPES.Auth_BaseFeaturesController)
        .toConstantValue(
          new BaseFeaturesController(
            container.get(TYPES.Auth_GetUserFeatures),
            container.get(TYPES.Auth_ControllerContainer),
          ),
        )
    }

    logger.debug('Configuration complete')

    return container
  }
}
