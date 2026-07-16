import * as winston from 'winston'
import AgentKeepAlive from 'agentkeepalive'
import * as grpc from '@grpc/grpc-js'
import { SNSClient, SNSClientConfig } from '@aws-sdk/client-sns'
import axios, { AxiosInstance } from 'axios'
import Redis from 'ioredis'
import { Container } from 'inversify'
import { Timer, TimerInterface } from '@standardnotes/time'

import { Env } from './Env'
import { TYPES } from './Types'
import { ServiceProxyInterface } from '../Service/Proxy/ServiceProxyInterface'
import { HttpServiceProxy } from '../Service/Http/HttpServiceProxy'
import { SubscriptionTokenAuthMiddleware } from '../Controller/SubscriptionTokenAuthMiddleware'
import { CrossServiceTokenCacheInterface } from '../Service/Cache/CrossServiceTokenCacheInterface'
import { RedisCrossServiceTokenCache } from '../Infra/Redis/RedisCrossServiceTokenCache'
import { WebSocketAuthMiddleware } from '../Controller/WebSocketAuthMiddleware'
import { InMemoryCrossServiceTokenCache } from '../Infra/InMemory/InMemoryCrossServiceTokenCache'
import { DirectCallServiceProxy } from '../Service/DirectCall/DirectCallServiceProxy'
import { MapperInterface, ServiceContainerInterface } from '@standardnotes/domain-core'
import { EndpointResolverInterface } from '../Service/Resolver/EndpointResolverInterface'
import { EndpointResolver } from '../Service/Resolver/EndpointResolver'
import { RequiredCrossServiceTokenMiddleware } from '../Controller/RequiredCrossServiceTokenMiddleware'
import { UserRateLimitMiddleware } from '../Controller/UserRateLimitMiddleware'
import { OptionalCrossServiceTokenMiddleware } from '../Controller/OptionalCrossServiceTokenMiddleware'
import { Transform } from 'stream'
import { AuthClient, IAuthClient, ISyncingClient, SyncRequest, SyncResponse, SyncingClient } from '@standardnotes/grpc'
import { GRPCServiceProxy } from '../Service/gRPC/GRPCServiceProxy'
import { GRPCSyncingServerServiceProxy } from '../Service/gRPC/GRPCSyncingServerServiceProxy'
import { SyncResponseHttpRepresentation } from '../Mapping/Sync/Http/SyncResponseHttpRepresentation'
import { SyncRequestGRPCMapper } from '../Mapping/Sync/GRPC/SyncRequestGRPCMapper'
import { SyncResponseGRPCMapper } from '../Mapping/Sync/GRPC/SyncResponseGRPCMapper'
import { GRPCWebSocketAuthMiddleware } from '../Controller/GRPCWebSocketAuthMiddleware'
import { DomainEventPublisherInterface } from '@standardnotes/domain-events'
import { SNSDomainEventPublisher } from '@standardnotes/domain-events-infra'
import { DomainEventFactoryInterface } from '../Event/DomainEventFactoryInterface'
import { DomainEventFactory } from '../Event/DomainEventFactory'
import { AssistantProviderConfig } from '../Service/Assistant/providers/factory'
import { FetchLike, GitHubPublishService } from '../Service/Integrations/GitHubPublishService'
import { createTesseractRecognizer, OcrService } from '../Service/Ocr/OcrService'
import { WebFetchLike, WebService } from '../Service/Web/WebService'
import {
  resolveOwnPackageVersion,
  UpdateCheckFetchLike,
  UpdateCheckService,
} from '../Service/Updates/UpdateCheckService'
import { PluginsFetchLike, PluginsProxyService } from '../Service/Plugins/PluginsProxyService'
import { AdminLogsService } from '../Service/AdminLogs/AdminLogsService'
import { CaldavService } from '../Service/Caldav/CaldavService'
import { CaldavTokenStore } from '../Service/Caldav/CaldavTokenStore'
import { PublishedCalendarStore } from '../Service/Caldav/PublishedCalendarStore'
import { ReminderDeliveryService } from '../Service/ReminderDelivery/ReminderDeliveryService'
import { ReminderDeliveryScheduler } from '../Service/ReminderDelivery/ReminderDeliveryScheduler'
import { PublishedRemindersStore } from '../Service/ReminderDelivery/PublishedRemindersStore'
import { DeliveryConfigStore } from '../Service/ReminderDelivery/DeliveryConfigStore'
import { ProviderRegistry } from '../Service/ReminderDelivery/Providers/ProviderRegistry'
import { TelegramProvider } from '../Service/ReminderDelivery/Providers/TelegramProvider'
import { EmailProvider } from '../Service/ReminderDelivery/Providers/EmailProvider'
import { WhatsAppProvider } from '../Service/ReminderDelivery/Providers/WhatsAppProvider'
import { WorkflowsService } from '../Service/Workflows/WorkflowsService'
import { WorkflowsPairingStore } from '../Service/Workflows/WorkflowsPairingStore'
import { ServerSettingsStore } from '../Service/ServerSettings/ServerSettingsStore'
import { ServerSettingsResolver } from '../Service/ServerSettings/ServerSettingsResolver'
import { RuntimeLogLevelApplier } from '../Service/Logging/RuntimeLogLevelApplier'
import { ServiceControlService } from '../Service/ServiceControl/ServiceControlService'
import { DockerServiceControlService } from '../Service/ServiceControl/DockerServiceControlService'
import { IpAccessListStore, IpAccessListRedis } from '../Controller/IpAccessList'
import { parseClientIpHeaderName } from '../Controller/ClientIp'
import { RateLimitMetricsStore, RateLimitMetricsRedis } from '../Controller/RateLimitMetrics'
import { SubscriptionTokenStore } from '../Service/Assistant/subscription/SubscriptionTokenStore'
import { SubscriptionCredentialProvider } from '../Service/Assistant/subscription/SubscriptionCredentialProvider'
import { buildDefaultOAuthConfig } from '../Service/Assistant/subscription/oauthConfig'
import * as path from 'path'

export class ContainerConfigLoader {
  async load(configuration?: {
    serviceContainer?: ServiceContainerInterface
    logger?: Transform
    environmentOverrides?: { [name: string]: string }
    container?: Container
  }): Promise<Container> {
    const env: Env = new Env(configuration?.environmentOverrides)
    env.load()

    const container = configuration?.container ?? new Container()

    const isConfiguredForHomeServer = env.get('MODE', true) === 'home-server'
    const isConfiguredForSelfHosting = env.get('MODE', true) === 'self-hosted'
    const isConfiguredForHomeServerOrSelfHosting = isConfiguredForHomeServer || isConfiguredForSelfHosting
    const isConfiguredForInMemoryCache = env.get('CACHE_TYPE', true) === 'memory'
    const isConfiguredForGRPCProxy = env.get('SERVICE_PROXY_TYPE', true) === 'grpc'

    container
      .bind<boolean>(TYPES.ApiGateway_IS_CONFIGURED_FOR_HOME_SERVER_OR_SELF_HOSTING)
      .toConstantValue(isConfiguredForHomeServerOrSelfHosting)

    if (!isConfiguredForHomeServerOrSelfHosting) {
      const snsConfig: SNSClientConfig = {
        region: env.get('SNS_AWS_REGION', true),
      }
      if (env.get('SNS_ENDPOINT', true)) {
        snsConfig.endpoint = env.get('SNS_ENDPOINT', true)
      }
      if (env.get('SNS_ACCESS_KEY_ID', true) && env.get('SNS_SECRET_ACCESS_KEY', true)) {
        snsConfig.credentials = {
          accessKeyId: env.get('SNS_ACCESS_KEY_ID', true),
          secretAccessKey: env.get('SNS_SECRET_ACCESS_KEY', true),
        }
      }
      const snsClient = new SNSClient(snsConfig)
      container.bind<SNSClient>(TYPES.ApiGateway_SNS).toConstantValue(snsClient)

      container.bind(TYPES.ApiGateway_SNS_TOPIC_ARN).toConstantValue(env.get('SNS_TOPIC_ARN', true))

      container
        .bind<DomainEventPublisherInterface>(TYPES.ApiGateway_DomainEventPublisher)
        .toConstantValue(
          new SNSDomainEventPublisher(
            container.get(TYPES.ApiGateway_SNS),
            container.get(TYPES.ApiGateway_SNS_TOPIC_ARN),
          ),
        )
    }

    const winstonFormatters = [winston.format.splat(), winston.format.json()]

    let logger: winston.Logger
    if (configuration?.logger) {
      logger = configuration.logger as winston.Logger
    } else {
      logger = winston.createLogger({
        level: env.get('LOG_LEVEL', true) || 'info',
        format: winston.format.combine(...winstonFormatters),
        transports: [new winston.transports.Console({ level: env.get('LOG_LEVEL', true) || 'info' })],
        defaultMeta: { service: 'api-gateway' },
      })
    }
    container.bind<winston.Logger>(TYPES.ApiGateway_Logger).toConstantValue(logger)

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
      container.bind(TYPES.ApiGateway_Redis).toConstantValue(redis)
    }

    const httpAgentKeepAliveTimeout = env.get('HTTP_AGENT_KEEP_ALIVE_TIMEOUT', true)
      ? +env.get('HTTP_AGENT_KEEP_ALIVE_TIMEOUT', true)
      : 4_000

    container.bind<AxiosInstance>(TYPES.ApiGateway_HTTPClient).toConstantValue(
      axios.create({
        httpAgent: new AgentKeepAlive({
          keepAlive: true,
          timeout: 2 * httpAgentKeepAliveTimeout,
          freeSocketTimeout: httpAgentKeepAliveTimeout,
        }),
      }),
    )

    // env vars
    container.bind(TYPES.ApiGateway_SYNCING_SERVER_JS_URL).toConstantValue(env.get('SYNCING_SERVER_JS_URL', true))
    container.bind(TYPES.ApiGateway_AUTH_SERVER_URL).toConstantValue(env.get('AUTH_SERVER_URL', true))
    container.bind(TYPES.ApiGateway_REVISIONS_SERVER_URL).toConstantValue(env.get('REVISIONS_SERVER_URL', true))
    container.bind(TYPES.ApiGateway_EMAIL_SERVER_URL).toConstantValue(env.get('EMAIL_SERVER_URL', true))
    container.bind(TYPES.ApiGateway_PAYMENTS_SERVER_URL).toConstantValue(env.get('PAYMENTS_SERVER_URL', true))
    container.bind(TYPES.ApiGateway_FILES_SERVER_URL).toConstantValue(env.get('FILES_SERVER_URL', true))
    container.bind(TYPES.ApiGateway_WEB_SOCKET_SERVER_URL).toConstantValue(env.get('WEB_SOCKET_SERVER_URL', true))
    container.bind(TYPES.ApiGateway_AUTH_JWT_SECRET).toConstantValue(env.get('AUTH_JWT_SECRET'))
    // Standard Red Notes: forwarded-client-IP config. TRUST_PROXY is bound raw for
    // the read-only admin display (Express itself is configured from it in
    // bin/server.ts / HomeServer.ts). CLIENT_IP_HEADER is parsed to its lower-case
    // header name (empty = off) and consumed by the canonical resolveClientIp so
    // the auth session IP, rate limiter, ACL and workflows audit all agree.
    container.bind<string>(TYPES.ApiGateway_TRUST_PROXY).toConstantValue(env.get('TRUST_PROXY', true) ?? '')
    container
      .bind<string>(TYPES.ApiGateway_CLIENT_IP_HEADER)
      .toConstantValue(parseClientIpHeaderName(env.get('CLIENT_IP_HEADER', true)))
    // Standard Red Notes: collaboration-room capability signing. Reuses the
    // websocket-gateway connection-token secret so the gateway verifies the
    // capability with the SAME secret it already holds. Empty when the realtime
    // gateway is not configured -> the CollaborationController fails closed.
    container
      .bind<string>(TYPES.ApiGateway_WEB_SOCKET_CONNECTION_TOKEN_SECRET)
      .toConstantValue(env.get('WEB_SOCKET_CONNECTION_TOKEN_SECRET', true) || '')
    container
      .bind<number>(TYPES.ApiGateway_COLLABORATION_CAPABILITY_TTL)
      .toConstantValue(
        env.get('COLLABORATION_CAPABILITY_TTL_SECONDS', true)
          ? +env.get('COLLABORATION_CAPABILITY_TTL_SECONDS', true)
          : 300,
      )
    container
      .bind(TYPES.ApiGateway_HTTP_CALL_TIMEOUT)
      .toConstantValue(env.get('HTTP_CALL_TIMEOUT', true) ? +env.get('HTTP_CALL_TIMEOUT', true) : 60_000)
    container.bind(TYPES.ApiGateway_VERSION).toConstantValue(env.get('VERSION', true) ?? 'development')
    container
      .bind(TYPES.ApiGateway_CROSS_SERVICE_TOKEN_CACHE_TTL)
      .toConstantValue(+env.get('CROSS_SERVICE_TOKEN_CACHE_TTL', true))
    container.bind(TYPES.ApiGateway_IS_CONFIGURED_FOR_HOME_SERVER).toConstantValue(isConfiguredForHomeServer)
    container
      .bind<string[]>(TYPES.ApiGateway_CORS_ALLOWED_ORIGINS)
      .toConstantValue(env.get('CORS_ALLOWED_ORIGINS', true) ? env.get('CORS_ALLOWED_ORIGINS', true).split(',') : [])
    container.bind<string>(TYPES.ApiGateway_CAPTCHA_UI_URL).toConstantValue(env.get('CAPTCHA_UI_URL', true))

    // Assistant LLM proxy configuration (server-held provider credentials).
    // The "openai" provider is the general OpenAI-compatible case driven by a
    // configurable base URL (OpenAI, LM Studio, Ollama, OpenRouter, custom).
    // NOTE: this is the ENV baseline only — the effective config is resolved per
    // request through the ServerSettingsResolver bound below (persisted admin
    // overrides WIN over these env values).
    const envAssistantProviderConfig: AssistantProviderConfig = {
      anthropicApiKey: env.get('ASSISTANT_ANTHROPIC_API_KEY', true) || undefined,
      openaiApiKey: env.get('ASSISTANT_OPENAI_API_KEY', true) || undefined,
      openaiBaseURL: env.get('ASSISTANT_OPENAI_BASE_URL', true) || undefined,
      openaiModel: env.get('ASSISTANT_OPENAI_MODEL', true) || undefined,
      ollamaUrl: env.get('ASSISTANT_OLLAMA_URL', true) || undefined,
      // OpenAI Codex / ChatGPT subscription mode (opt-in). Leave ASSISTANT_OPENAI_AUTH_MODE
      // unset or 'api-key' to keep the default OpenAI API-key behavior unchanged.
      openaiAuthMode: env.get('ASSISTANT_OPENAI_AUTH_MODE', true) === 'subscription' ? 'subscription' : 'api-key',
      openaiSubscriptionToken: env.get('ASSISTANT_OPENAI_SUBSCRIPTION_TOKEN', true) || undefined,
      openaiSubscriptionBaseURL: env.get('ASSISTANT_OPENAI_SUBSCRIPTION_BASE_URL', true) || undefined,
      openaiAccountId: env.get('ASSISTANT_OPENAI_ACCOUNT_ID', true) || undefined,
      openaiBeta: env.get('ASSISTANT_OPENAI_BETA', true) || undefined,
      openaiExtraHeaders: env.get('ASSISTANT_OPENAI_EXTRA_HEADERS', true) || undefined,
    }
    container
      .bind<AssistantProviderConfig>(TYPES.ApiGateway_ASSISTANT_PROVIDER_CONFIG)
      .toConstantValue(envAssistantProviderConfig)

    // Standard Red Notes: runtime-configurable server settings (admin pane).
    // A persisted JSON overlay over env config — PRECEDENCE: persisted (admin-set)
    // WINS over env; env is the fallback; hardcoded defaults last. Consumers
    // (assistant provider factory calls, UpdateCheckService, the Nextcloud gate
    // view) read through the resolver per request, so admin changes take effect
    // on next use without a restart. Default path sits next to the other
    // gateway JSON stores; SERVER_SETTINGS_PATH overrides it (the docker
    // entrypoint points BOTH the gateway and the auth service at the same file
    // so the auth-side Nextcloud gate can read the same overlay).
    const serverSettingsPath =
      env.get('SERVER_SETTINGS_PATH', true) || path.resolve(process.cwd(), 'data', 'server-settings.json')
    const serverSettingsStore = new ServerSettingsStore(serverSettingsPath)
    const serverSettingsResolver = new ServerSettingsResolver(serverSettingsStore, {
      assistant: envAssistantProviderConfig,
      assistantDailyRequestLimit: env.get('ASSISTANT_DAILY_REQUEST_LIMIT', true)
        ? +env.get('ASSISTANT_DAILY_REQUEST_LIMIT', true)
        : undefined,
      assistantFiveHourTokenLimit: env.get('ASSISTANT_5H_TOKEN_LIMIT', true)
        ? +env.get('ASSISTANT_5H_TOKEN_LIMIT', true)
        : undefined,
      assistantWeeklyTokenLimit: env.get('ASSISTANT_WEEKLY_TOKEN_LIMIT', true)
        ? +env.get('ASSISTANT_WEEKLY_TOKEN_LIMIT', true)
        : undefined,
      updateCheckUrl: env.get('UPDATE_CHECK_URL', true) || undefined,
      nextcloudBackupsEnabled: env.get('NEXTCLOUD_BACKUPS_ENABLED', true)
        ? env.get('NEXTCLOUD_BACKUPS_ENABLED', true) === 'true'
        : undefined,
      // Standard Red Notes: PROOF-OF-WORK anti-bot env baseline. The gateway
      // persists + views these; the AUTH server reads the SAME overlay file and
      // enforces the gating. undefined when the env var is unset so the source
      // map reports 'default' (the resolver applies the hardcoded fallbacks:
      // registerEnabled=false, registerDifficulty=12, signInEnabled=false,
      // signInMode='adaptive', signInDifficulty=16, signInAdaptiveThreshold=3 —
      // both scopes DISABLED by default so a stock deploy locks nobody out).
      proofOfWorkRegisterEnabled: env.get('PROOF_OF_WORK_REGISTER_ENABLED', true)
        ? env.get('PROOF_OF_WORK_REGISTER_ENABLED', true) === 'true'
        : undefined,
      proofOfWorkRegisterDifficulty: env.get('PROOF_OF_WORK_REGISTER_DIFFICULTY', true)
        ? +env.get('PROOF_OF_WORK_REGISTER_DIFFICULTY', true)
        : undefined,
      proofOfWorkSignInEnabled: env.get('PROOF_OF_WORK_SIGNIN_ENABLED', true)
        ? env.get('PROOF_OF_WORK_SIGNIN_ENABLED', true) === 'true'
        : undefined,
      proofOfWorkSignInMode:
        env.get('PROOF_OF_WORK_SIGNIN_MODE', true) === 'always'
          ? 'always'
          : env.get('PROOF_OF_WORK_SIGNIN_MODE', true) === 'adaptive'
            ? 'adaptive'
            : undefined,
      proofOfWorkSignInDifficulty: env.get('PROOF_OF_WORK_SIGNIN_DIFFICULTY', true)
        ? +env.get('PROOF_OF_WORK_SIGNIN_DIFFICULTY', true)
        : undefined,
      proofOfWorkSignInAdaptiveThreshold: env.get('PROOF_OF_WORK_SIGNIN_ADAPTIVE_THRESHOLD', true)
        ? +env.get('PROOF_OF_WORK_SIGNIN_ADAPTIVE_THRESHOLD', true)
        : undefined,
      // Standard Red Notes: RATE-LIMIT env baseline. Enforced by the gateway's
      // RateLimitMiddleware, which reads the resolved config per request. undefined
      // when unset so the source map reports 'default' (the resolver applies the
      // hardcoded safe defaults that reproduce the historical hardcoded behavior:
      // enabled=true, window=60s, login=10, registration=5, per-user off).
      rateLimitEnabled: env.get('RATE_LIMIT_ENABLED', true)
        ? env.get('RATE_LIMIT_ENABLED', true) !== 'false'
        : undefined,
      rateLimitWindowSeconds: env.get('RATE_LIMIT_WINDOW_SECONDS', true)
        ? +env.get('RATE_LIMIT_WINDOW_SECONDS', true)
        : undefined,
      rateLimitLoginMax: env.get('RATE_LIMIT_LOGIN_MAX', true) ? +env.get('RATE_LIMIT_LOGIN_MAX', true) : undefined,
      rateLimitRegistrationMax: env.get('RATE_LIMIT_REGISTRATION_MAX', true)
        ? +env.get('RATE_LIMIT_REGISTRATION_MAX', true)
        : undefined,
      rateLimitUserWindowSeconds: env.get('RATE_LIMIT_USER_WINDOW_SECONDS', true)
        ? +env.get('RATE_LIMIT_USER_WINDOW_SECONDS', true)
        : undefined,
      rateLimitUserMax: env.get('RATE_LIMIT_USER_MAX', true) ? +env.get('RATE_LIMIT_USER_MAX', true) : undefined,
      rateLimitAdaptiveEscalation: env.get('RATE_LIMIT_ADAPTIVE_ESCALATION', true)
        ? env.get('RATE_LIMIT_ADAPTIVE_ESCALATION', true) === 'true'
        : undefined,
      // Standard Red Notes: REGISTRATION policy env baseline. The gateway persists
      // + views these; the AUTH server reads the SAME overlay file and enforces
      // them in Register. undefined when unset so the source map reports 'default'
      // (the resolver applies CORE_USER / off / [] fallbacks). REGISTRATION_DOMAINS
      // is a comma/whitespace-separated list.
      registrationDefaultRole: env.get('REGISTRATION_DEFAULT_ROLE', true) || undefined,
      registrationDomainMode:
        env.get('REGISTRATION_DOMAIN_MODE', true) === 'allowlist'
          ? 'allowlist'
          : env.get('REGISTRATION_DOMAIN_MODE', true) === 'blocklist'
            ? 'blocklist'
            : env.get('REGISTRATION_DOMAIN_MODE', true) === 'off'
              ? 'off'
              : undefined,
      registrationDomains: env.get('REGISTRATION_DOMAINS', true)
        ? env.get('REGISTRATION_DOMAINS', true).split(/[\s,]+/)
        : undefined,
      // Standard Red Notes: EMAIL CONFIRMATION env baseline (opt-in; only the
      // exact string 'true' enables it). Enforced auth-side; the gateway views it.
      registrationEmailConfirmationEnabled:
        env.get('REGISTRATION_EMAIL_CONFIRMATION', true) === 'true'
          ? true
          : env.get('REGISTRATION_EMAIL_CONFIRMATION', true) === 'false'
            ? false
            : undefined,
      registrationEmailConfirmationGating:
        env.get('REGISTRATION_EMAIL_CONFIRMATION_GATING', true) === 'block_signin'
          ? 'block_signin'
          : env.get('REGISTRATION_EMAIL_CONFIRMATION_GATING', true) === 'warn'
            ? 'warn'
            : undefined,
      registrationEmailConfirmationSubject: env.get('REGISTRATION_EMAIL_CONFIRMATION_SUBJECT', true) || undefined,
      registrationEmailConfirmationBody: env.get('REGISTRATION_EMAIL_CONFIRMATION_BODY', true) || undefined,
      registrationEmailConfirmationBaseUrl: env.get('REGISTRATION_EMAIL_CONFIRMATION_URL', true) || undefined,
      // Standard Red Notes: SIGNUP-CAP env baseline. The gateway persists + views
      // these; the AUTH server reads the SAME overlay file and enforces the caps
      // in Register. undefined when unset so the source map reports 'default' (the
      // resolver applies the unlimited/24h fallbacks). Caps: 0 = unlimited.
      registrationSignupsPerIpMax: env.get('REGISTRATION_SIGNUPS_PER_IP_MAX', true)
        ? +env.get('REGISTRATION_SIGNUPS_PER_IP_MAX', true)
        : undefined,
      registrationSignupsPerIpWindowHours: env.get('REGISTRATION_SIGNUPS_PER_IP_WINDOW_HOURS', true)
        ? +env.get('REGISTRATION_SIGNUPS_PER_IP_WINDOW_HOURS', true)
        : undefined,
      registrationSignupsPerWeekMax: env.get('REGISTRATION_SIGNUPS_PER_WEEK_MAX', true)
        ? +env.get('REGISTRATION_SIGNUPS_PER_WEEK_MAX', true)
        : undefined,
      registrationSignupsPerDeviceMax: env.get('REGISTRATION_SIGNUPS_PER_DEVICE_MAX', true)
        ? +env.get('REGISTRATION_SIGNUPS_PER_DEVICE_MAX', true)
        : undefined,
      registrationSignupsPerDeviceWindowHours: env.get('REGISTRATION_SIGNUPS_PER_DEVICE_WINDOW_HOURS', true)
        ? +env.get('REGISTRATION_SIGNUPS_PER_DEVICE_WINDOW_HOURS', true)
        : undefined,
      // Standard Red Notes: INVITE-URL signup control + extended capabilities env
      // baseline. The gateway persists + views these; the AUTH server reads the
      // SAME overlay file and enforces them. undefined when unset so the source map
      // reports 'default' (the resolver applies the OFF/unlimited/open fallbacks).
      // All default OFF so a stock deploy is unchanged until an admin opts in.
      registrationInviteOnly:
        env.get('REGISTRATION_INVITE_ONLY', true) === 'true'
          ? true
          : env.get('REGISTRATION_INVITE_ONLY', true) === 'false'
            ? false
            : undefined,
      registrationApprovalRequired:
        env.get('REGISTRATION_APPROVAL_REQUIRED', true) === 'true'
          ? true
          : env.get('REGISTRATION_APPROVAL_REQUIRED', true) === 'false'
            ? false
            : undefined,
      registrationMaxTotalAccounts: env.get('REGISTRATION_MAX_TOTAL_ACCOUNTS', true)
        ? +env.get('REGISTRATION_MAX_TOTAL_ACCOUNTS', true)
        : undefined,
      registrationSignupsOpenAt: env.get('REGISTRATION_SIGNUPS_OPEN_AT', true) || undefined,
      registrationSignupsCloseAt: env.get('REGISTRATION_SIGNUPS_CLOSE_AT', true) || undefined,
      registrationInvitesPerUser: env.get('REGISTRATION_INVITES_PER_USER', true)
        ? +env.get('REGISTRATION_INVITES_PER_USER', true)
        : undefined,
      // Standard Red Notes: RUNTIME LOG VERBOSITY env baseline (LOG_LEVEL). The
      // gateway persists + views `logging.level`; the RuntimeLogLevelApplier poller
      // applies the effective level to the live logger. undefined when unset so the
      // source map reports 'default' (the resolver falls back to 'info').
      logLevel: env.get('LOG_LEVEL', true) || undefined,
      // Standard Red Notes: OCR env baseline. The SERVER-side knobs (OCR_SERVER_*)
      // are enforced by the gateway (OcrController/OcrService read the resolver per
      // request). The BROWSER-OCR knobs mirror OCR_ENABLED / OCR_DEFAULT_LANGUAGE
      // (in the single-container image the gateway shares the operator env, so it
      // reads them here as the baseline surfaced via GET /v1/ocr/config). undefined
      // when unset so the source map reports 'default'.
      ocrServerEnabled: env.get('OCR_SERVER_ENABLED', true)
        ? ['true', '1', 'yes', 'on'].includes(env.get('OCR_SERVER_ENABLED', true).toLowerCase())
        : undefined,
      ocrDefaultLanguage: env.get('OCR_SERVER_DEFAULT_LANGUAGE', true) || undefined,
      ocrMaxPages: env.get('OCR_SERVER_MAX_PAGES', true) ? +env.get('OCR_SERVER_MAX_PAGES', true) : undefined,
      ocrMaxImageBytes: env.get('OCR_SERVER_MAX_IMAGE_BYTES', true)
        ? +env.get('OCR_SERVER_MAX_IMAGE_BYTES', true)
        : undefined,
      ocrClientEnabled: env.get('OCR_ENABLED', true)
        ? ['true', '1', 'yes', 'on'].includes(env.get('OCR_ENABLED', true).toLowerCase())
        : undefined,
      ocrClientDefaultLanguage: env.get('OCR_DEFAULT_LANGUAGE', true) || undefined,
      // Standard Red Notes: WORKFLOWS (n8n) env baseline. enabled/n8nUrl/uiTokenTtl
      // are read through the resolver per request (runtime); uiBasePath is the
      // boot-bound Express mount. undefined when unset so the source map reports
      // 'default'.
      workflowsEnabled: env.get('WORKFLOWS_ENABLED', true)
        ? ['true', '1', 'yes', 'on'].includes(env.get('WORKFLOWS_ENABLED', true).toLowerCase())
        : undefined,
      workflowsN8nUrl: env.get('WORKFLOWS_N8N_URL', true) || undefined,
      workflowsUiBasePath: env.get('WORKFLOWS_UI_BASE_PATH', true) || undefined,
      workflowsUiTokenTtlSeconds: env.get('WORKFLOWS_UI_TOKEN_TTL_SECONDS', true)
        ? +env.get('WORKFLOWS_UI_TOKEN_TTL_SECONDS', true)
        : undefined,
      // Standard Red Notes: PLUGINS gallery repo base URL. The gateway proxies the
      // repo server-side so the client fetches it SAME-ORIGIN (strict CSP). Unset
      // => the resolver falls back to the Standard Notes default (behavior unchanged).
      pluginsRepoUrl: env.get('PLUGINS_REPO_URL', true) || undefined,
      // Standard Red Notes: same-origin component RENDERING opt-in. Default OFF —
      // the resolver falls back to OFF so a stock deploy keeps external hosted_url
      // (blocked by CSP) exactly as before. Admin overlay wins over this env.
      pluginsSameOriginRendering: env.get('PLUGINS_SAME_ORIGIN_RENDERING', true)
        ? env.get('PLUGINS_SAME_ORIGIN_RENDERING', true) === 'true'
        : undefined,
    })
    container.bind<ServerSettingsStore>(TYPES.ApiGateway_ServerSettingsStore).toConstantValue(serverSettingsStore)
    container
      .bind<ServerSettingsResolver>(TYPES.ApiGateway_ServerSettingsResolver)
      .toConstantValue(serverSettingsResolver)

    // Standard Red Notes: RUNTIME LOG VERBOSITY. Start an in-process poller that
    // re-reads the effective `logging.level` from the overlay (persisted admin >
    // env LOG_LEVEL > 'info') once at boot and every 30s, mutating the live winston
    // logger + transport levels so an admin can change how verbose the server writes
    // WITHOUT a restart. Fully guarded and unref'd — a broken overlay can never
    // crash startup or keep the event loop alive (memory: verify container boot).
    try {
      new RuntimeLogLevelApplier(logger, () => serverSettingsResolver.resolveLoggingLevel()).start()
    } catch (error) {
      logger.error(`Failed to start runtime log-level applier: ${(error as Error).message}`)
    }

    // Standard Red Notes: anti-abuse infrastructure. The IP allow/block lists and
    // throttle telemetry are Redis-backed, so bind them only when a Redis cache is
    // configured (the in-memory cache deployment has no shared store for these and
    // the whole rate-limit layer no-ops there). Both reuse the SAME ioredis client.
    if (container.isBound(TYPES.ApiGateway_Redis)) {
      const antiAbuseRedis = container.get(TYPES.ApiGateway_Redis) as IpAccessListRedis & RateLimitMetricsRedis
      container
        .bind<IpAccessListStore>(TYPES.ApiGateway_IpAccessListStore)
        .toConstantValue(new IpAccessListStore(antiAbuseRedis))
      container
        .bind<RateLimitMetricsStore>(TYPES.ApiGateway_RateLimitMetricsStore)
        .toConstantValue(new RateLimitMetricsStore(antiAbuseRedis))
    }

    // Standard Red Notes: ChatGPT/Codex subscription pairing credential provider.
    // Bound only when an encryption key is present (the token store fails closed
    // without one, never persisting a credential in plaintext). The PKCE OAuth
    // config is fully env-overridable (see oauthConfig.ts). The AssistantController
    // injects this @optional so pairing routes degrade to 503 when it is absent.
    const subscriptionEncryptionKey = env.get('ASSISTANT_SUBSCRIPTION_ENCRYPTION_KEY', true) || undefined
    if (subscriptionEncryptionKey) {
      const subscriptionTokenPath =
        env.get('ASSISTANT_SUBSCRIPTION_TOKEN_PATH', true) ||
        path.resolve(process.cwd(), 'data', 'assistant-subscription.json')
      const subscriptionTokenStore = new SubscriptionTokenStore(subscriptionTokenPath, subscriptionEncryptionKey)
      const oauthConfig = buildDefaultOAuthConfig((key: string) => env.get(key, true) || undefined)
      container
        .bind<SubscriptionCredentialProvider>(TYPES.ApiGateway_AssistantSubscriptionCredentialProvider)
        .toConstantValue(new SubscriptionCredentialProvider(subscriptionTokenStore, oauthConfig))
    }

    container
      .bind<string>(TYPES.ApiGateway_ASSISTANT_DEFAULT_PROVIDER)
      .toConstantValue(env.get('ASSISTANT_DEFAULT_PROVIDER', true) || 'anthropic')
    container
      .bind<string>(TYPES.ApiGateway_ASSISTANT_DEFAULT_MODEL)
      .toConstantValue(env.get('ASSISTANT_DEFAULT_MODEL', true) || 'claude-3-5-sonnet-latest')
    // Global daily AI request ceiling enforced per user. 0 = unlimited.
    container
      .bind<number>(TYPES.ApiGateway_ASSISTANT_DAILY_REQUEST_LIMIT)
      .toConstantValue(
        env.get('ASSISTANT_DAILY_REQUEST_LIMIT', true) ? +env.get('ASSISTANT_DAILY_REQUEST_LIMIT', true) : 0,
      )
    // Per-user rolling-window AI TOKEN ceilings (env fallback; 0 = unlimited).
    container
      .bind<number>(TYPES.ApiGateway_ASSISTANT_5H_TOKEN_LIMIT)
      .toConstantValue(env.get('ASSISTANT_5H_TOKEN_LIMIT', true) ? +env.get('ASSISTANT_5H_TOKEN_LIMIT', true) : 0)
    container
      .bind<number>(TYPES.ApiGateway_ASSISTANT_WEEKLY_TOKEN_LIMIT)
      .toConstantValue(
        env.get('ASSISTANT_WEEKLY_TOKEN_LIMIT', true) ? +env.get('ASSISTANT_WEEKLY_TOKEN_LIMIT', true) : 0,
      )
    // Standard Red Notes: comma-separated STT model ids the audio-recorder model
    // picker offers. Empty by default — clients then fall back to a free-text field.
    container.bind<string[]>(TYPES.ApiGateway_ASSISTANT_TRANSCRIPTION_MODELS).toConstantValue(
      (env.get('TRANSCRIPTION_MODELS', true) || '')
        .split(',')
        .map((model) => model.trim())
        .filter((model) => model.length > 0),
    )

    // Standard Red Notes: OPT-IN server-side PDF OCR (tesseract-in-Node).
    //
    // E2E DOWNGRADE: when enabled (and a user is admin-allowed via the per-user
    // OCR_SERVER_ALLOWED setting), the client uploads DECRYPTED PDF page images
    // here for recognition — that content leaves end-to-end encryption, exactly
    // like the AI proxy. OFF by default; the browser OCR path stays the default.
    const ocrServerEnabled = ['true', '1', 'yes', 'on'].includes(
      (env.get('OCR_SERVER_ENABLED', true) || '').toLowerCase(),
    )
    container.bind<boolean>(TYPES.ApiGateway_OCR_SERVER_ENABLED).toConstantValue(ocrServerEnabled)
    container
      .bind<string>(TYPES.ApiGateway_OCR_DEFAULT_LANGUAGE)
      .toConstantValue(env.get('OCR_SERVER_DEFAULT_LANGUAGE', true) || 'eng')
    // Bound a single request: page count and per-image byte size, so an OCR call
    // cannot pin the box. Defaults: 50 pages, 12 MB per page image.
    const ocrMaxPages = env.get('OCR_SERVER_MAX_PAGES', true) ? +env.get('OCR_SERVER_MAX_PAGES', true) : 50
    const ocrMaxImageBytes = env.get('OCR_SERVER_MAX_IMAGE_BYTES', true)
      ? +env.get('OCR_SERVER_MAX_IMAGE_BYTES', true)
      : 12 * 1024 * 1024
    container.bind<number>(TYPES.ApiGateway_OCR_MAX_PAGES).toConstantValue(ocrMaxPages)
    container.bind<number>(TYPES.ApiGateway_OCR_MAX_IMAGE_BYTES).toConstantValue(ocrMaxImageBytes)
    container.bind<OcrService>(TYPES.ApiGateway_OcrService).toConstantValue(
      new OcrService(createTesseractRecognizer(), {
        defaultLanguage: env.get('OCR_SERVER_DEFAULT_LANGUAGE', true) || 'eng',
        maxPages: ocrMaxPages,
        maxImageBytes: ocrMaxImageBytes,
      }),
    )

    // Standard Red Notes: optional server-mediated "Publish note to GitHub".
    // Uses the runtime's global fetch for the outbound GitHub Contents API call.
    // The service holds no credentials of its own — the PAT arrives per request.
    container
      .bind<GitHubPublishService>(TYPES.ApiGateway_GitHubPublishService)
      .toConstantValue(new GitHubPublishService(globalThis.fetch.bind(globalThis) as unknown as FetchLike))

    // Standard Red Notes: server-side WEB proxy (fetch + search) for the browser
    // AI agent. fetch() has an SSRF guard (private/loopback/metadata hosts are
    // rejected, see WebService.assertPublicHttpUrl); search() uses a configurable
    // backend (SEARCH_PROVIDER + SEARCH_API_URL + SEARCH_API_KEY) and returns an
    // empty result set (never 500) when unconfigured. Both routes are
    // authenticated by the WebController so this is not an open proxy.
    container.bind<WebService>(TYPES.ApiGateway_WebService).toConstantValue(
      new WebService(globalThis.fetch.bind(globalThis) as unknown as WebFetchLike, {
        searchProvider: env.get('SEARCH_PROVIDER', true) || undefined,
        searchApiUrl: env.get('SEARCH_API_URL', true) || undefined,
        searchApiKey: env.get('SEARCH_API_KEY', true) || undefined,
        maxContentChars: env.get('WEB_FETCH_MAX_CHARS', true) ? +env.get('WEB_FETCH_MAX_CHARS', true) : undefined,
        fetchTimeoutMs: env.get('WEB_FETCH_TIMEOUT_MS', true) ? +env.get('WEB_FETCH_TIMEOUT_MS', true) : undefined,
      }),
    )

    // Standard Red Notes: self-hosted "Check for updates".
    //
    // The gateway (never the browser) fetches the operator-configured
    // UPDATE_CHECK_URL — a GitHub releases/latest API URL or any endpoint
    // returning `{ version, url }` — with a short timeout, caching the result
    // in-memory (UPDATE_CHECK_CACHE_TTL_MS, default 15 min) so client checks
    // can't hammer the remote. Unset URL => the feature reports "not
    // configured" and the client renders that state gracefully. The version
    // this deployment reports as "current" defaults to the api-gateway package
    // version and can be overridden via UPDATE_CHECK_CURRENT_VERSION (useful
    // when release tags track the whole fork rather than this package).
    container.bind<UpdateCheckService>(TYPES.ApiGateway_UpdateCheckService).toConstantValue(
      new UpdateCheckService(globalThis.fetch.bind(globalThis) as unknown as UpdateCheckFetchLike, {
        url: env.get('UPDATE_CHECK_URL', true) || undefined,
        // Runtime settings overlay: an admin-persisted URL wins over the env
        // value and takes effect on the next check (no restart).
        urlResolver: () => serverSettingsResolver.resolveUpdateCheckUrl(),
        currentVersion: env.get('UPDATE_CHECK_CURRENT_VERSION', true) || resolveOwnPackageVersion(),
        cacheTtlMs: env.get('UPDATE_CHECK_CACHE_TTL_MS', true)
          ? +env.get('UPDATE_CHECK_CACHE_TTL_MS', true)
          : undefined,
        timeoutMs: env.get('UPDATE_CHECK_TIMEOUT_MS', true) ? +env.get('UPDATE_CHECK_TIMEOUT_MS', true) : undefined,
      }),
    )

    // Standard Red Notes: SAME-ORIGIN plugins (extensions) gallery proxy.
    //
    // The gateway (never the browser) fetches the operator-configured plugins
    // repo — base URL resolved per request through the ServerSettingsResolver
    // (admin `plugins.repoUrl` overlay wins over PLUGINS_REPO_URL env, over the
    // hardcoded Standard Notes default) — so the client fetches the index (and
    // package files) from THIS origin and the strict CSP `connect-src 'self'` is
    // satisfied with no CSP change. The proxy is SSRF-guarded: the client can only
    // request paths UNDER the configured base (see PluginsProxyService), never an
    // arbitrary host. Timeout + size cap are configurable via env.
    container.bind<PluginsProxyService>(TYPES.ApiGateway_PluginsProxyService).toConstantValue(
      new PluginsProxyService(globalThis.fetch.bind(globalThis) as unknown as PluginsFetchLike, {
        baseUrlResolver: () => serverSettingsResolver.resolvePluginsRepoUrl(),
        timeoutMs: env.get('PLUGINS_REPO_TIMEOUT_MS', true) ? +env.get('PLUGINS_REPO_TIMEOUT_MS', true) : undefined,
        maxBytes: env.get('PLUGINS_REPO_MAX_BYTES', true) ? +env.get('PLUGINS_REPO_MAX_BYTES', true) : undefined,
      }),
    )

    // Standard Red Notes: admin-panel server-log tailing. Reads the container's
    // supervisord per-service log directory (SERVER_LOGS_PATH, default
    // /var/lib/server/logs — see docker/supervisord.conf). Always bound; if the
    // directory is absent at runtime the service degrades to an empty result.
    const serverLogsPath = env.get('SERVER_LOGS_PATH', true) || '/var/lib/server/logs'
    container.bind<string>(TYPES.ApiGateway_SERVER_LOGS_PATH).toConstantValue(serverLogsPath)
    container
      .bind<AdminLogsService>(TYPES.ApiGateway_AdminLogsService)
      .toConstantValue(new AdminLogsService(serverLogsPath))

    // Standard Red Notes: internal PROBE base URLs for the admin server-status
    // endpoint. These are deliberately separate from the proxy URLs above:
    //   - FILES_SERVER_URL is defined as the PUBLIC files URL in this fork's
    //     docker entrypoint (PUBLIC_FILES_SERVER_URL, e.g. the app front door's
    //     /files prefix), so it is NOT reachable from inside the container and
    //     must never be used as a probe target.
    //   - In the single-container image the sibling services listen on
    //     localhost:<internal port> (ports exported by docker-entrypoint.sh:
    //     syncing 3101, auth 3103, files 3104, revisions 3105).
    // Resolution per service: <SERVICE>_PROBE_URL env override (multi-service
    // topologies) → the service-URL env where it is an internal URL → the
    // supervisord sibling port (from the entrypoint's port envs, with hardcoded
    // fallbacks matching the entrypoint).
    const probePort = (portEnvVar: string, fallback: number): string => env.get(portEnvVar, true) || String(fallback)
    const serviceProbeUrls: Record<string, string> = {
      'syncing-server':
        env.get('SYNCING_SERVER_PROBE_URL', true) ||
        env.get('SYNCING_SERVER_JS_URL', true) ||
        `http://localhost:${probePort('SYNCING_SERVER_PORT', 3101)}`,
      auth:
        env.get('AUTH_SERVER_PROBE_URL', true) ||
        env.get('AUTH_SERVER_URL', true) ||
        `http://localhost:${probePort('AUTH_SERVER_PORT', 3103)}`,
      files: env.get('FILES_SERVER_PROBE_URL', true) || `http://localhost:${probePort('FILES_SERVER_PORT', 3104)}`,
      revisions:
        env.get('REVISIONS_SERVER_PROBE_URL', true) ||
        env.get('REVISIONS_SERVER_URL', true) ||
        `http://localhost:${probePort('REVISIONS_SERVER_PORT', 3105)}`,
    }
    container.bind<Record<string, string>>(TYPES.ApiGateway_SERVICE_PROBE_URLS).toConstantValue(serviceProbeUrls)

    // Standard Red Notes: admin-panel SERVICE LIFECYCLE control. Shells out to
    // `supervisorctl` to restart/stop/start the sibling server processes running
    // under supervisord in the single-container image. Program names are an
    // ALLOWLIST (never interpolated into a shell) so a malicious :name path
    // segment can never inject a command. SUPERVISORCTL_CONFIG_PATH overrides the
    // conf the CLI talks through (default /etc/supervisord.conf, where the
    // [supervisorctl] unix-socket sections live). Always bound; when supervisorctl
    // cannot reach supervisord (older image without the socket conf) the service
    // degrades to an "unavailable" outcome rather than throwing.
    container.bind<ServiceControlService>(TYPES.ApiGateway_ServiceControlService).toConstantValue(
      new ServiceControlService({
        configPath: env.get('SUPERVISORCTL_CONFIG_PATH', true) || '/etc/supervisord.conf',
      }),
    )

    // Standard Red Notes: OPT-IN, OFF-BY-DEFAULT container restart (Redis cache +
    // MariaDB) via the locked-down docker-socket-proxy sidecar. It activates ONLY
    // when the operator BOTH sets SERVICE_CONTROL_DOCKER_ENABLED=true + the proxy
    // URL AND runs the `ops` compose profile. The raw docker socket is NEVER
    // mounted into this container — only into the proxy — and the proxy is
    // configured to permit ONLY container restart. When not enabled/reachable the
    // service degrades to a clear "disabled"/"unavailable" outcome (never a 500),
    // and the admin UI hides the controls. SERVICE_CONTROL_DOCKER_PROJECT sets the
    // compose project prefix used to resolve <project>-<service>-1 container
    // names (default 'standard-red-notes', matching docker-compose.yml `name:`);
    // SERVICE_CONTROL_DOCKER_CONTAINERS optionally overrides per service as a CSV
    // of logical=actual pairs (e.g. "cache=my-redis,db=my-mariadb").
    const parseContainerNames = (raw: string | undefined): Record<string, string> => {
      const map: Record<string, string> = {}
      if (!raw) {
        return map
      }
      for (const pair of raw.split(',')) {
        const [logical, actual] = pair.split('=').map((part) => part.trim())
        if (logical && actual) {
          map[logical] = actual
        }
      }

      return map
    }
    container.bind<DockerServiceControlService>(TYPES.ApiGateway_DockerServiceControlService).toConstantValue(
      new DockerServiceControlService({
        enabled: env.get('SERVICE_CONTROL_DOCKER_ENABLED', true) === 'true',
        proxyUrl: env.get('SERVICE_CONTROL_DOCKER_PROXY_URL', true) || '',
        project: env.get('SERVICE_CONTROL_DOCKER_PROJECT', true) || 'standard-red-notes',
        containerNames: parseContainerNames(env.get('SERVICE_CONTROL_DOCKER_CONTAINERS', true)),
      }),
    )

    // Standard Red Notes: OPT-IN read-only CalDAV feed.
    //
    // E2E NOTE: notes/reminders are end-to-end encrypted, so the server cannot
    // read them. This feed serves ONLY reminders the user has EXPLICITLY
    // published into a separate, server-readable store (plaintext by design) and
    // is OFF by default. Gated by the operator master switch CALDAV_ENABLED plus
    // the per-user CALDAV_ENABLED setting (enforced at token issuance). The
    // published store + scoped CalDAV tokens are kept in JSON files under
    // CALDAV_DATA_PATH (default ./data/caldav), keeping the feature self-contained
    // in the api-gateway, which has no database of its own.
    const caldavEnabled = ['true', '1', 'yes', 'on'].includes((env.get('CALDAV_ENABLED', true) || '').toLowerCase())
    const caldavDataPath = env.get('CALDAV_DATA_PATH', true) || path.resolve(process.cwd(), 'data', 'caldav')
    const caldavBasePath = env.get('CALDAV_BASE_PATH', true) || '/dav'
    container.bind<boolean>(TYPES.ApiGateway_CALDAV_ENABLED).toConstantValue(caldavEnabled)
    container.bind<string>(TYPES.ApiGateway_CALDAV_BASE_PATH).toConstantValue(caldavBasePath)
    container
      .bind<CaldavService>(TYPES.ApiGateway_CaldavService)
      .toConstantValue(
        new CaldavService(
          caldavEnabled,
          new CaldavTokenStore(path.join(caldavDataPath, 'tokens.json')),
          new PublishedCalendarStore(path.join(caldavDataPath, 'published.json')),
        ),
      )

    // Standard Red Notes: OPT-IN server-side reminder DELIVERY (Telegram / Email /
    // WhatsApp).
    //
    // E2E NOTE: notes/reminders are end-to-end encrypted, so the server cannot read
    // them. This delivers ONLY reminders the user has EXPLICITLY PUBLISHED into a
    // separate, server-readable store (plaintext by design) to the user's configured
    // channel, and is OFF by default. Gated by the operator master switch
    // REMINDER_DELIVERY_ENABLED plus the per-user REMINDER_DELIVERY_ENABLED setting.
    // The published reminders + per-user delivery config are kept in JSON files under
    // REMINDER_DELIVERY_DATA_PATH (default ./data/reminder-delivery), keeping the
    // feature self-contained in the api-gateway, which has no database of its own.
    // Each provider adapter NO-OPs gracefully when its env credentials are absent.
    const reminderDeliveryEnabled = ['true', '1', 'yes', 'on'].includes(
      (env.get('REMINDER_DELIVERY_ENABLED', true) || '').toLowerCase(),
    )
    const reminderDeliveryDataPath =
      env.get('REMINDER_DELIVERY_DATA_PATH', true) || path.resolve(process.cwd(), 'data', 'reminder-delivery')
    container.bind<boolean>(TYPES.ApiGateway_REMINDER_DELIVERY_ENABLED).toConstantValue(reminderDeliveryEnabled)

    const reminderRegistry = new ProviderRegistry([
      new TelegramProvider(env.get('TELEGRAM_BOT_TOKEN', true) || undefined),
      new EmailProvider({
        host: env.get('SMTP_HOST', true) || undefined,
        port: env.get('SMTP_PORT', true) ? +env.get('SMTP_PORT', true) : undefined,
        user: env.get('SMTP_USER', true) || undefined,
        password: env.get('SMTP_PASSWORD', true) || undefined,
        from: env.get('SMTP_FROM', true) || undefined,
        secure: ['true', '1', 'yes', 'on'].includes((env.get('SMTP_SECURE', true) || '').toLowerCase()),
      }),
      new WhatsAppProvider({
        meta: {
          token: env.get('WHATSAPP_TOKEN', true) || undefined,
          phoneId: env.get('WHATSAPP_PHONE_ID', true) || undefined,
        },
        twilio: {
          accountSid: env.get('TWILIO_ACCOUNT_SID', true) || undefined,
          authToken: env.get('TWILIO_AUTH_TOKEN', true) || undefined,
          from: env.get('TWILIO_WHATSAPP_FROM', true) || undefined,
        },
      }),
    ])

    const reminderDeliveryService = new ReminderDeliveryService(
      reminderDeliveryEnabled,
      new PublishedRemindersStore(path.join(reminderDeliveryDataPath, 'published-reminders.json')),
      new DeliveryConfigStore(path.join(reminderDeliveryDataPath, 'delivery-config.json')),
      reminderRegistry,
    )
    container
      .bind<ReminderDeliveryService>(TYPES.ApiGateway_ReminderDeliveryService)
      .toConstantValue(reminderDeliveryService)

    const reminderDeliveryIntervalSeconds = env.get('REMINDER_DELIVERY_INTERVAL_SECONDS', true)
      ? +env.get('REMINDER_DELIVERY_INTERVAL_SECONDS', true)
      : 60
    container
      .bind<ReminderDeliveryScheduler>(TYPES.ApiGateway_ReminderDeliveryScheduler)
      .toConstantValue(
        new ReminderDeliveryScheduler(
          reminderDeliveryService,
          Math.max(1, reminderDeliveryIntervalSeconds) * 1000,
          logger,
        ),
      )

    // Standard Red Notes: OPT-IN WORKFLOWS (n8n-backed automation engine).
    //
    // Two gates, both fail-closed: this operator master switch AND the
    // admin-managed per-user WORKFLOWS_ENABLED setting (which rides along in the
    // cross-service token). The n8n engine itself is a peer container on the
    // internal docker network (WORKFLOWS_N8N_URL) with no host port — its editor
    // UI is reachable ONLY through the authenticated /workflows-ui gateway proxy,
    // and only for entitled + explicitly PAIRED users. Pairing state is a JSON
    // file under WORKFLOWS_DATA_PATH (default ./data/workflows), keeping the
    // feature self-contained in the api-gateway, which has no database of its own
    // (same pattern as the CalDAV/reminder-delivery stores). The editor-proxy
    // UI-access token reuses AUTH_JWT_SECRET (already held by the gateway) and
    // mirrors COOKIE_SECURE so its cookie matches the deployment's cookie policy.
    const workflowsEnabled = ['true', '1', 'yes', 'on'].includes(
      (env.get('WORKFLOWS_ENABLED', true) || '').toLowerCase(),
    )
    const workflowsDataPath = env.get('WORKFLOWS_DATA_PATH', true) || path.resolve(process.cwd(), 'data', 'workflows')
    const workflowsUiTokenTtlSeconds = env.get('WORKFLOWS_UI_TOKEN_TTL_SECONDS', true)
      ? +env.get('WORKFLOWS_UI_TOKEN_TTL_SECONDS', true)
      : 12 * 60 * 60
    container.bind<boolean>(TYPES.ApiGateway_WORKFLOWS_ENABLED).toConstantValue(workflowsEnabled)
    container.bind<WorkflowsService>(TYPES.ApiGateway_WorkflowsService).toConstantValue(
      new WorkflowsService(
        {
          enabled: workflowsEnabled,
          n8nUrl: env.get('WORKFLOWS_N8N_URL', true) || 'http://n8n:5678',
          uiBasePath: env.get('WORKFLOWS_UI_BASE_PATH', true) || '/workflows-ui',
          jwtSecret: env.get('AUTH_JWT_SECRET'),
          cookieSecure: (env.get('COOKIE_SECURE', true) || '').toLowerCase() === 'true',
          uiTokenTtlSeconds: Math.max(60, workflowsUiTokenTtlSeconds),
        },
        new WorkflowsPairingStore(path.join(workflowsDataPath, 'pairings.json')),
        // Standard Red Notes: the runtime overlay resolver, so enabled/n8nUrl/
        // uiTokenTtl are re-read per request (persisted admin value wins over env).
        serverSettingsResolver,
      ),
    )

    // Middleware
    container
      .bind<RequiredCrossServiceTokenMiddleware>(TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware)
      .to(RequiredCrossServiceTokenMiddleware)
    // Standard Red Notes: the PER-USER rate tier for expensive authenticated
    // endpoints (mounted after RequiredCrossServiceTokenMiddleware on the
    // assistant streaming proxy). Off by default (userMax 0 => pass-through);
    // no-op when Redis is absent. See UserRateLimitMiddleware.
    container.bind<UserRateLimitMiddleware>(TYPES.ApiGateway_UserRateLimitMiddleware).to(UserRateLimitMiddleware)
    container
      .bind<OptionalCrossServiceTokenMiddleware>(TYPES.ApiGateway_OptionalCrossServiceTokenMiddleware)
      .to(OptionalCrossServiceTokenMiddleware)
    container
      .bind<SubscriptionTokenAuthMiddleware>(TYPES.ApiGateway_SubscriptionTokenAuthMiddleware)
      .to(SubscriptionTokenAuthMiddleware)

    // Services
    container.bind<TimerInterface>(TYPES.ApiGateway_Timer).toConstantValue(new Timer())

    if (isConfiguredForHomeServer) {
      container
        .bind<CrossServiceTokenCacheInterface>(TYPES.ApiGateway_CrossServiceTokenCache)
        .toConstantValue(new InMemoryCrossServiceTokenCache(container.get(TYPES.ApiGateway_Timer)))
    } else {
      container
        .bind<CrossServiceTokenCacheInterface>(TYPES.ApiGateway_CrossServiceTokenCache)
        .to(RedisCrossServiceTokenCache)
    }
    container
      .bind<EndpointResolverInterface>(TYPES.ApiGateway_EndpointResolver)
      .toConstantValue(new EndpointResolver(isConfiguredForHomeServer))

    if (isConfiguredForHomeServer) {
      if (!configuration?.serviceContainer) {
        throw new Error('Service container is required when configured for home server')
      }
      container
        .bind<ServiceProxyInterface>(TYPES.ApiGateway_ServiceProxy)
        .toConstantValue(
          new DirectCallServiceProxy(configuration.serviceContainer, container.get(TYPES.ApiGateway_FILES_SERVER_URL)),
        )
    } else {
      if (isConfiguredForGRPCProxy) {
        container.bind(TYPES.ApiGateway_AUTH_SERVER_GRPC_URL).toConstantValue(env.get('AUTH_SERVER_GRPC_URL'))
        container.bind(TYPES.ApiGateway_SYNCING_SERVER_GRPC_URL).toConstantValue(env.get('SYNCING_SERVER_GRPC_URL'))
        const grpcAgentKeepAliveTimeout = env.get('GRPC_AGENT_KEEP_ALIVE_TIMEOUT', true)
          ? +env.get('GRPC_AGENT_KEEP_ALIVE_TIMEOUT', true)
          : 20_000

        const grpcMaxMessageSize = env.get('GRPC_MAX_MESSAGE_SIZE', true)
          ? +env.get('GRPC_MAX_MESSAGE_SIZE', true)
          : 1024 * 1024 * 50

        container.bind<IAuthClient>(TYPES.ApiGateway_GRPCAuthClient).toConstantValue(
          new AuthClient(
            container.get<string>(TYPES.ApiGateway_AUTH_SERVER_GRPC_URL),
            grpc.credentials.createInsecure(),
            {
              'grpc.keepalive_timeout_ms': grpcAgentKeepAliveTimeout,
              'grpc.default_compression_algorithm': grpc.compressionAlgorithms.gzip,
              'grpc.default_compression_level': 2,
              'grpc.max_receive_message_length': grpcMaxMessageSize,
              'grpc.max_send_message_length': grpcMaxMessageSize,
            },
          ),
        )
        container.bind<ISyncingClient>(TYPES.ApiGateway_GRPCSyncingClient).toConstantValue(
          new SyncingClient(
            container.get<string>(TYPES.ApiGateway_SYNCING_SERVER_GRPC_URL),
            grpc.credentials.createInsecure(),
            {
              'grpc.keepalive_timeout_ms': grpcAgentKeepAliveTimeout,
              'grpc.default_compression_algorithm': grpc.compressionAlgorithms.gzip,
              'grpc.default_compression_level': 2,
              'grpc.max_receive_message_length': grpcMaxMessageSize,
              'grpc.max_send_message_length': grpcMaxMessageSize,
            },
          ),
        )

        container
          .bind<MapperInterface<Record<string, unknown>, SyncRequest>>(TYPES.Mapper_SyncRequestGRPCMapper)
          .toConstantValue(new SyncRequestGRPCMapper())
        container
          .bind<MapperInterface<SyncResponse, SyncResponseHttpRepresentation>>(TYPES.Mapper_SyncResponseGRPCMapper)
          .toConstantValue(new SyncResponseGRPCMapper())

        container
          .bind<DomainEventFactoryInterface>(TYPES.ApiGateway_DomainEventFactory)
          .toConstantValue(new DomainEventFactory(container.get<TimerInterface>(TYPES.ApiGateway_Timer)))

        container
          .bind<GRPCSyncingServerServiceProxy>(TYPES.ApiGateway_GRPCSyncingServerServiceProxy)
          .toConstantValue(
            new GRPCSyncingServerServiceProxy(
              container.get<ISyncingClient>(TYPES.ApiGateway_GRPCSyncingClient),
              container.get<MapperInterface<Record<string, unknown>, SyncRequest>>(TYPES.Mapper_SyncRequestGRPCMapper),
              container.get<MapperInterface<SyncResponse, SyncResponseHttpRepresentation>>(
                TYPES.Mapper_SyncResponseGRPCMapper,
              ),
              container.get<winston.Logger>(TYPES.ApiGateway_Logger),
              container.get<DomainEventFactoryInterface>(TYPES.ApiGateway_DomainEventFactory),
              isConfiguredForHomeServerOrSelfHosting
                ? undefined
                : container.get<DomainEventPublisherInterface>(TYPES.ApiGateway_DomainEventPublisher),
            ),
          )
        container
          .bind<ServiceProxyInterface>(TYPES.ApiGateway_ServiceProxy)
          .toConstantValue(
            new GRPCServiceProxy(
              container.get<AxiosInstance>(TYPES.ApiGateway_HTTPClient),
              container.get<string>(TYPES.ApiGateway_AUTH_SERVER_URL),
              container.get<string>(TYPES.ApiGateway_SYNCING_SERVER_JS_URL),
              container.get<string>(TYPES.ApiGateway_PAYMENTS_SERVER_URL),
              container.get<string>(TYPES.ApiGateway_FILES_SERVER_URL),
              container.get<string>(TYPES.ApiGateway_WEB_SOCKET_SERVER_URL),
              container.get<string>(TYPES.ApiGateway_REVISIONS_SERVER_URL),
              container.get<string>(TYPES.ApiGateway_EMAIL_SERVER_URL),
              container.get<number>(TYPES.ApiGateway_HTTP_CALL_TIMEOUT),
              container.get<CrossServiceTokenCacheInterface>(TYPES.ApiGateway_CrossServiceTokenCache),
              container.get<winston.Logger>(TYPES.ApiGateway_Logger),
              container.get<TimerInterface>(TYPES.ApiGateway_Timer),
              container.get<IAuthClient>(TYPES.ApiGateway_GRPCAuthClient),
              container.get<GRPCSyncingServerServiceProxy>(TYPES.ApiGateway_GRPCSyncingServerServiceProxy),
            ),
          )
      } else {
        container.bind<ServiceProxyInterface>(TYPES.ApiGateway_ServiceProxy).to(HttpServiceProxy)
      }
    }

    if (isConfiguredForGRPCProxy) {
      container
        .bind<GRPCWebSocketAuthMiddleware>(TYPES.ApiGateway_WebSocketAuthMiddleware)
        .toConstantValue(
          new GRPCWebSocketAuthMiddleware(
            container.get<IAuthClient>(TYPES.ApiGateway_GRPCAuthClient),
            container.get<string>(TYPES.ApiGateway_AUTH_JWT_SECRET),
            container.get<winston.Logger>(TYPES.ApiGateway_Logger),
          ),
        )
    } else {
      container.bind<WebSocketAuthMiddleware>(TYPES.ApiGateway_WebSocketAuthMiddleware).to(WebSocketAuthMiddleware)
    }

    logger.debug('Configuration complete')

    return container
  }
}
