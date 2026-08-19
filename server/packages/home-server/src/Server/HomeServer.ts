import 'reflect-metadata'

import {
  ControllerContainer,
  Result,
  RuntimeLogLevelApplier,
  ServerSettingsLogLevelResolver,
  ServiceContainer,
} from '@standardnotes/domain-core'
import {
  Service as ApiGatewayService,
  configureTrustProxy,
  createSharedServerAccessKeyMiddleware,
  resolveSharedServerAccessKeyConfig,
  registerCaldavRoutes,
  startReminderDeliveryScheduler,
  createFallbackHandler,
  HOME_SERVER_WELCOME_HTML,
  decideCorsOrigin,
  resolveCorsStrictMode,
  buildDefaultRateLimitRules,
  createRateLimitMiddleware,
  parseClientIpHeaderName,
  IpAccessListStore,
  RateLimitConfig,
  RateLimitMetricsStore,
  RateLimitRedis,
  RequiredCrossServiceTokenMiddleware,
  createAdminEmailDeliveryRouter,
  CollaborationAuthorizationService,
  LoopbackSyncApiRpcAdapter,
  DirectCallSyncCommandPort,
  parseOptionalPositiveInteger,
  parseWebSocketSyncEnabled,
  resolveWebSocketSyncAllowedOrigins,
  SyncWebSocketCommandAdapter,
  SyncWebSocketRuntime,
  TYPES as ApiGatewayTypes,
} from '@standardnotes/api-gateway'
import {
  createLoggerSyncCommandMetrics,
  createInviteRealtimeDomainEventBridge,
  createSharedInviteEventComposition,
  createRedisSyncState,
  createSyncFilesTokenDecoder,
  RedisInviteEventAvailabilityBus,
  RedisInviteEventStore,
  type RedisInviteEventClient,
  type RedisInviteEventPublisher,
  type RedisInviteEventSubscriber,
  type SyncGatewayOptions,
  type InviteRealtimeDomainEventBridge,
  type SyncRedisClient,
} from '@standard-red-notes/websocket-gateway'
import { Service as FilesService } from '@standardnotes/files-server'
import { DirectCallDomainEventPublisher } from '@standardnotes/domain-events-infra'
import { Service as AuthService, AuthServiceInterface } from '@standardnotes/auth-server'
import { Service as SyncingService } from '@standardnotes/syncing-server'
import { Service as RevisionsService } from '@standardnotes/revisions-server'
import { Container } from 'inversify'
import { InversifyExpressServer, sanitizeRequestUrlForLogging } from 'inversify-express-utils'
import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { text, json, Request, Response, NextFunction, raw } from 'express'
import * as http from 'http'
import { resolve as resolvePath } from 'path'
import * as winston from 'winston'
import Redis from 'ioredis'
import { PassThrough } from 'stream'
import { Env } from '../Bootstrap/Env'
import { HomeServerInterface } from './HomeServerInterface'
import { HomeServerConfiguration } from './HomeServerConfiguration'
import { WebSocketRedisBridge } from './WebSocketRedisBridge'
import { HomeServerRuntime, HomeServerRuntimeEmailDelivery } from './HomeServerRuntime'
import { HomeServerSyncFilesAdapter } from './HomeServerSyncFilesAdapter'
import {
  CanonicalHomeServerFileResourceAuthorizer,
  type HomeServerCrossServiceToken,
  type HomeServerPersonalValetToken,
  type HomeServerSharedVaultValetToken,
  type HomeServerSessionValidationPort,
} from './CanonicalHomeServerFileResourceAuthorizer'

export function buildHomeServerEnvironmentOverrides(
  dataDirectoryPath: string,
  configuredEnvironment: { [name: string]: string } | undefined,
): { [name: string]: string } {
  return {
    DB_TYPE: 'sqlite',
    CACHE_TYPE: 'memory',
    DB_SQLITE_DATABASE_PATH: `${dataDirectoryPath}/database/home_server.sqlite`,
    FILE_UPLOAD_PATH: `${dataDirectoryPath}/uploads`,
    // Gateway writes admin overrides here; the grouped logger poller reads the
    // same file. configuredEnvironment below may deliberately override it.
    SERVER_SETTINGS_PATH: `${dataDirectoryPath}/server-settings.json`,
    // Current Standard Red Notes clients support both password and TOTP
    // step-up proof. Default bundled deployments to v3 tokens while allowing an
    // operator's explicit, valid rollout thresholds to override these values.
    APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_2: '0.0.0',
    APPLICATION_VERSION_THRESHOLD_FOR_TOKEN_VERSION_3: '0.0.0',
    // Standard Red Notes: default the CalDAV JSON stores under the data dir so
    // published reminders + scoped tokens persist with the rest of the
    // instance. The feature stays OFF until CALDAV_ENABLED=true.
    CALDAV_DATA_PATH: `${dataDirectoryPath}/caldav`,
    // Standard Red Notes: default the reminder-delivery JSON stores (published
    // reminders + per-user delivery config) under the data dir so they persist
    // with the rest of the instance. The feature stays OFF until
    // REMINDER_DELIVERY_ENABLED=true.
    REMINDER_DELIVERY_DATA_PATH: `${dataDirectoryPath}/reminder-delivery`,
    ...configuredEnvironment,
    MODE: 'home-server',
  }
}

/**
 * FILES_V1 (the binary file lane on the sync socket) is ON by default in the
 * home server: the canonical file store is a local filesystem root that the
 * same process already owns, so no extra infrastructure is required. Operators
 * can turn the capability off without disabling realtime sync entirely by
 * setting WEBSOCKET_FILES_ENABLED=false.
 */
export function parseWebSocketFilesEnabled(value: string | undefined): boolean {
  if (value === undefined) {
    return true
  }
  const normalized = value.trim().toLowerCase()
  if (normalized === '') {
    return true
  }
  return !['false', '0', 'no', 'off'].includes(normalized)
}

export interface HomeServerListener {
  listen(port: number): http.Server
  listen(port: number, hostname: string): http.Server
}

/**
 * Bind to an explicit interface only when configured. Keeping the one-argument
 * listen call as the default preserves the standalone home-server's existing
 * network behavior, while packaged single-host deployments can make nginx the
 * only public edge by selecting loopback.
 */
export function listenHomeServer(app: HomeServerListener, port: number, bindAddress?: string): http.Server {
  return bindAddress ? app.listen(port, bindAddress) : app.listen(port)
}

export class HomeServer implements HomeServerInterface {
  private readonly runtime = new HomeServerRuntime()
  private authService: AuthServiceInterface | undefined
  private logStream: PassThrough | undefined
  private runtimeLogLevelApplier: RuntimeLogLevelApplier | undefined
  private starting = false
  private stopPromise: Promise<Result<string>> | undefined
  private readonly loggerNames = [
    'auth-server',
    'syncing-server',
    'revisions-server',
    'files-server',
    'api-gateway',
    'home-server',
  ]

  async start(configuration: HomeServerConfiguration): Promise<Result<string>> {
    if (this.starting || this.runtime.isActive()) {
      return Result.fail('Home server is already running or changing state.')
    }

    this.starting = true
    try {
      const controllerContainer = new ControllerContainer()
      const serviceContainer = new ServiceContainer()
      const directCallDomainEventPublisher = new DirectCallDomainEventPublisher()

      const environmentOverrides = buildHomeServerEnvironmentOverrides(
        configuration.dataDirectoryPath,
        configuration.environment,
      )

      const env: Env = new Env(environmentOverrides)
      env.load()
      const webSocketSyncEnabled = parseWebSocketSyncEnabled(env.get('WEBSOCKET_SYNC_ENABLED', true) || undefined)
      const syncAllowedOrigins = resolveWebSocketSyncAllowedOrigins(
        env.get('WEBSOCKET_SYNC_ALLOWED_ORIGINS', true) || undefined,
        env.get('PUBLIC_URL', true) || undefined,
      )
      const syncRedisOptions = {
        keyPrefix: env.get('WEBSOCKET_SYNC_REDIS_KEY_PREFIX', true) || undefined,
        operationTimeoutMs: parseOptionalPositiveInteger(
          'WEBSOCKET_SYNC_REDIS_OPERATION_TIMEOUT_MS',
          env.get('WEBSOCKET_SYNC_REDIS_OPERATION_TIMEOUT_MS', true) || undefined,
          30_000,
        ),
        commandLeaseTtlMs: parseOptionalPositiveInteger(
          'WEBSOCKET_SYNC_COMMAND_LEASE_TTL_MS',
          env.get('WEBSOCKET_SYNC_COMMAND_LEASE_TTL_MS', true) || undefined,
          300_000,
        ),
        socketLeaseTtlMs: parseOptionalPositiveInteger(
          'WEBSOCKET_SYNC_SOCKET_LEASE_TTL_MS',
          env.get('WEBSOCKET_SYNC_SOCKET_LEASE_TTL_MS', true) || undefined,
          300_000,
        ),
        maxSocketsPerUser: parseOptionalPositiveInteger(
          'WEBSOCKET_SYNC_MAX_SOCKETS_PER_USER',
          env.get('WEBSOCKET_SYNC_MAX_SOCKETS_PER_USER', true) || undefined,
          1_024,
        ),
      }

      const requestPayloadLimit = env.get('HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES', true)
        ? `${+env.get('HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES', true)}mb`
        : '50mb'

      this.configureLoggers(env, configuration)

      // Bridge in-process WEB_SOCKET_MESSAGE_REQUESTED events onto Redis pub/sub
      // so the self-hosted WebSocket gateway can push them to live clients.
      const webSocketRedisBridge = new WebSocketRedisBridge(
        winston.loggers.get('home-server'),
        env.get('REDIS_HOST', true) || undefined,
        env.get('REDIS_PORT', true) ? +env.get('REDIS_PORT', true) : 6379,
      )
      directCallDomainEventPublisher.register(webSocketRedisBridge)

      const apiGatewayService = new ApiGatewayService(serviceContainer)
      const authService = new AuthService(serviceContainer, controllerContainer, directCallDomainEventPublisher)
      const syncingService = new SyncingService(serviceContainer, controllerContainer, directCallDomainEventPublisher)
      const revisionsService = new RevisionsService(
        serviceContainer,
        controllerContainer,
        directCallDomainEventPublisher,
      )
      const filesService = new FilesService(serviceContainer, directCallDomainEventPublisher)

      const container = new Container()
      await apiGatewayService.getContainer({
        logger: winston.loggers.get('api-gateway'),
        environmentOverrides,
        container,
      })
      await authService.getContainer({
        logger: winston.loggers.get('auth-server'),
        environmentOverrides,
        container,
      })
      await syncingService.getContainer({
        logger: winston.loggers.get('syncing-server'),
        environmentOverrides,
        container,
      })
      await revisionsService.getContainer({
        logger: winston.loggers.get('revisions-server'),
        environmentOverrides,
        container,
      })
      await filesService.getContainer({
        logger: winston.loggers.get('files-server'),
        environmentOverrides,
        container,
      })

      const server = new InversifyExpressServer(container)

      server.setConfig((app) => {
        // Standard Red Notes: honor X-Forwarded-Proto / X-Forwarded-For when the
        // self-hosted server runs behind a TLS-terminating reverse proxy, so
        // req.secure / req.protocol / req.ip reflect the real client. Configurable
        // via TRUST_PROXY (see api-gateway TrustProxy.ts). Default trusts only
        // loopback/private (Docker) networks so direct access keeps working and a
        // remote client cannot spoof the forwarded headers.
        configureTrustProxy(app, env.get('TRUST_PROXY', true))

        // Standard Red Notes: optional trusted client-IP header (CLIENT_IP_HEADER;
        // empty = off), fed into every IP consumer via the canonical resolveClientIp
        // so the rate limiter, IP allow/block list and auth session IP all agree.
        const clientIpHeader = parseClientIpHeaderName(env.get('CLIENT_IP_HEADER', true))

        // Standard Red Notes: Redis-backed IP rate limiting on the unauthenticated,
        // auth-adjacent endpoints (login, registration, MCP-token authenticate,
        // magic-link request, recovery) — the same brute-force throttle the
        // standalone api-gateway installs (bin/server.ts). Reuses the gateway's
        // ioredis client, which is only bound when CACHE_TYPE is NOT in-memory, so
        // when the home-server runs without Redis the middleware is a no-op (the
        // factory returns a pass-through when redis is undefined). Keyed by
        // req.ip, which honors the TRUST_PROXY set above so a direct client cannot
        // spoof it. Tunable via RATE_LIMIT_* env; disable with RATE_LIMIT_ENABLED=false.
        const rateLimitRedis = container.isBound(ApiGatewayTypes.ApiGateway_Redis)
          ? (container.get(ApiGatewayTypes.ApiGateway_Redis) as RateLimitRedis)
          : undefined
        // Standard Red Notes: same config-driven anti-abuse wiring the standalone
        // gateway installs — the tiers are resolved PER REQUEST from the persisted
        // ServerSettings overlay (admin wins over RATE_LIMIT_* env wins over the
        // safe defaults), and the admin-managed IP allow/block list + throttle
        // telemetry are enforced/recorded when Redis (and thus the stores) is bound.
        const rateLimitResolver = container.get<{
          resolveRateLimitConfig(): Promise<{
            enabled: boolean
            windowSeconds: number
            loginMax: number
            registrationMax: number
            adaptiveEscalation: boolean
          }>
        }>(ApiGatewayTypes.ApiGateway_ServerSettingsResolver)
        const rateLimitIpAccessList = container.isBound(ApiGatewayTypes.ApiGateway_IpAccessListStore)
          ? container.get<IpAccessListStore>(ApiGatewayTypes.ApiGateway_IpAccessListStore)
          : undefined
        const rateLimitMetrics = container.isBound(ApiGatewayTypes.ApiGateway_RateLimitMetricsStore)
          ? container.get<RateLimitMetricsStore>(ApiGatewayTypes.ApiGateway_RateLimitMetricsStore)
          : undefined
        const escalationRedis = rateLimitRedis as unknown as {
          set?(key: string, value: string, mode: string, seconds: number): Promise<unknown>
        }
        app.use(
          createRateLimitMiddleware({
            redis: rateLimitRedis,
            logger: {
              warn: (message: string, metadata?: Record<string, unknown>) =>
                winston.loggers.get('home-server').warn(message, metadata),
            },
            config: async (): Promise<RateLimitConfig> => {
              const resolved = await rateLimitResolver.resolveRateLimitConfig()

              return {
                enabled: resolved.enabled,
                rules: buildDefaultRateLimitRules({
                  windowSeconds: resolved.windowSeconds,
                  loginMax: resolved.loginMax,
                  registrationMax: resolved.registrationMax,
                }),
              }
            },
            ipAccessList: rateLimitIpAccessList,
            metrics: rateLimitMetrics,
            clientIpHeader,
            onThrottle: (clientIp: string): void => {
              if (escalationRedis.set === undefined) {
                return
              }
              void (async (): Promise<void> => {
                try {
                  const resolved = await rateLimitResolver.resolveRateLimitConfig()
                  if (resolved.adaptiveEscalation && escalationRedis.set) {
                    await escalationRedis.set(`rl:escalate:${clientIp}`, '1', 'EX', resolved.windowSeconds * 5)
                  }
                } catch {
                  // best-effort escalation signal.
                }
              })()
            },
          }),
        )

        app.use(
          helmet({
            contentSecurityPolicy: {
              directives: {
                defaultSrc: ["https: 'self'"],
                baseUri: ["'self'"],
                childSrc: ['*', 'blob:'],
                connectSrc: ['*'],
                fontSrc: ['*', "'self'"],
                formAction: ["'self'"],
                frameAncestors: ['*', '*.standardnotes.org', '*.standardnotes.com'],
                frameSrc: ['*', 'blob:'],
                imgSrc: ["'self'", '*', 'data:'],
                manifestSrc: ["'self'"],
                mediaSrc: ["'self'"],
                objectSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
              },
            },
          }),
        )
        app.use(json({ limit: requestPayloadLimit }))
        app.use(raw({ limit: requestPayloadLimit, type: 'application/octet-stream' }))
        app.use(
          text({
            type: [
              'text/plain',
              'application/x-www-form-urlencoded',
              'application/x-www-form-urlencoded; charset=utf-8',
            ],
          }),
        )

        app.use(cookieParser() as never)

        // Standard Red Notes: route the self-hosted home-server CORS through the
        // SAME resolver the standalone api-gateway uses (CorsOriginResolver), instead
        // of the former inline block that defaulted to PERMISSIVE (reflecting ANY
        // Origin with credentials when CORS_ORIGIN_STRICT_MODE_ENABLED was unset) and
        // used an UNANCHORED localhost regex (so http://localhost:1.evil.com matched).
        // The resolver defaults to STRICT and only allows origins that legitimately
        // need credentialed cross-origin access (desktop app, the browser clippers, a
        // localhost self-host via the anchored ^https?://localhost(:\d+)?$ regex, and
        // anything the operator lists in CORS_ALLOWED_ORIGINS). Set
        // CORS_ORIGIN_STRICT_MODE_ENABLED=false to restore the legacy permissive mode.
        const corsAllowedOrigins = env.get('CORS_ALLOWED_ORIGINS', true)
          ? env.get('CORS_ALLOWED_ORIGINS', true).split(',')
          : []
        const corsStrictMode = resolveCorsStrictMode(env.get('CORS_ORIGIN_STRICT_MODE_ENABLED', true))
        app.use(
          cors({
            credentials: true,
            exposedHeaders: ['Content-Range', 'Accept-Ranges', 'x-captcha-required'],
            origin: (
              requestOrigin: string | undefined,
              callback: (err: Error | null, origin?: boolean | string | string[]) => void,
            ) => {
              const decision = decideCorsOrigin(requestOrigin, {
                strictMode: corsStrictMode,
                allowedOrigins: corsAllowedOrigins,
              })

              if (decision.allow) {
                callback(null, [requestOrigin as string])
                return
              }

              // Disallowed CROSS-origin request: emit NO Access-Control-Allow-Origin
              // header (a falsy origin tells the cors package to skip CORS headers and
              // continue). The browser blocks the cross-origin RESPONSE while
              // SAME-ORIGIN requests — which need no ACAO — keep working on any custom
              // domain. We deliberately do NOT throw (throwing 500s same-origin deploys).
              callback(null, false)
            },
          }),
        )
        app.use((req: Request, res: Response, next: NextFunction) => {
          if (req.path === '/robots.txt') {
            res.type('text/plain').send('User-agent: *\nDisallow: /\n')
            return
          }
          next()
        })

        // Standard Red Notes: optional server-wide shared access key gate. OFF by
        // default (zero behavior change). This is OBFUSCATION/access-gating for a
        // self-hosted instance, NOT end-to-end security (that is the existing E2E
        // encryption). See SharedServerAccessKeyMiddleware for the security model.
        const sharedServerAccessKeyConfig = resolveSharedServerAccessKeyConfig(
          env.get('SHARED_SERVER_ACCESS_KEY', true),
          env.get('SHARED_SERVER_ACCESS_KEY_MODE', true),
        )
        app.use(createSharedServerAccessKeyMiddleware(sharedServerAccessKeyConfig))

        // Every bundled service declares the same healthcheck controller path.
        // Register the aggregate route before server.build() mounts those
        // controllers so home-server readiness is deterministic rather than
        // depending on controller discovery order. It stays after the standard
        // security middleware; the shared-key middleware explicitly exempts the
        // healthcheck path for container probes.
        app.get('/healthcheck/readiness', (_request: Request, response: Response, next: NextFunction) => {
          const readiness = container.get<{
            check(): Promise<{
              status: 'ready' | 'unavailable'
              deployment: { revision: string | null; version: string | null }
              checks: Record<string, unknown>
            }>
          }>(ApiGatewayTypes.ApiGateway_AggregateReadinessService)
          void readiness
            .check()
            .then((report) => response.status(report.status === 'ready' ? 200 : 503).json(report))
            .catch(next)
        })

        if (env.get('E2E_TESTING', true) === 'true') {
          app.post('/e2e/activate-premium', (request: Request, response: Response) => {
            void this.activatePremiumFeatures({
              username: request.body.username,
              subscriptionId: request.body.subscriptionId,
              subscriptionPlanName: request.body.subscriptionPlanName,
              uploadBytesLimit: request.body.uploadBytesLimit,
              endsAt: request.body.endsAt ? new Date(request.body.endsAt) : undefined,
              cancelPreviousSubscription: request.body.cancelPreviousSubscription,
            }).then((result) => {
              if (result.isFailed()) {
                response.status(400).send({ error: { message: result.getError() } })
              } else {
                response.status(200).send({ message: result.getValue() })
              }
            })
          })
        }

        const routingLogger = winston.loggers.get('home-server')

        // The bundled CACHE_TYPE=memory topology has no durable Redis queue.
        // Mount the authenticated advanced boundary anyway so it returns an
        // explicit 501 capability response; POST /test falls through to the
        // annotated legacy SMTP dispatcher and is not duplicated here.
        const emailDeliveryAuth = container.get<RequiredCrossServiceTokenMiddleware>(
          ApiGatewayTypes.ApiGateway_RequiredCrossServiceTokenMiddleware,
        )
        app.use(
          '/v1/admin/email-delivery',
          createAdminEmailDeliveryRouter(undefined, {
            authenticationMiddleware: emailDeliveryAuth.handler.bind(emailDeliveryAuth),
            auditLogger: routingLogger,
          }),
        )

        // Standard Red Notes: mount the read-only CalDAV router INSIDE setConfig
        // — i.e. BEFORE server.build(). build() mounts the inversify controller
        // router at '/'. The
        // trailing unmatched handler is now a POST-BUILD app.use() fallback (see after
        // build(), replacing the former inert @controller('') FallbackController
        // catch-all), so these routes are no longer at risk of being shadowed — but
        // keeping them pre-build (ahead of the controller router) remains the correct,
        // defensive placement. Registering here also keeps them after all the middleware
        // above (like the e2e route just above). CalDAV gates itself internally
        // (404 when CALDAV_ENABLED is off), so mounting it unconditionally is safe.
        try {
          registerCaldavRoutes(app, container)
          routingLogger.info('CalDAV router mounted')
        } catch {
          routingLogger.error('Failed to mount CalDAV router.')
        }
      })

      const logger: winston.Logger = winston.loggers.get('home-server')

      server.setErrorConfig((app) => {
        app.use((error: Record<string, unknown>, request: Request, response: Response, _next: NextFunction) => {
          logger.error('Unhandled home-server request error.', {
            method: request.method,
            url: sanitizeRequestUrlForLogging(request.url),
            snjs: request.headers['x-snjs-version'],
            application: request.headers['x-application-version'],
            userId: response.locals.user ? response.locals.user.uuid : undefined,
          })

          if ('type' in error && error.type === 'entity.too.large') {
            response.status(413).send({
              error: {
                message: 'The request payload is too large.',
              },
            })

            return
          }

          response.status(500).send({
            error: {
              message:
                "Unfortunately, we couldn't handle your request. Please try again or contact our support if the error persists.",
            },
          })
        })
      })

      const port = env.get('PORT', true) ? +env.get('PORT', true) : 3000
      const bindAddress = env.get('BIND_ADDRESS', true) || undefined

      // Standard Red Notes: build() mounts the inversify controller router at '/'. The
      // CalDAV router is registered INSIDE setConfig above (before this call),
      // ahead of the controller router — see the note there.
      const app = await server.build()

      // Standard Red Notes: cosmetic welcome page (GET /) + JSON 404 fallback for the
      // bundled home-server. This replaces the former @controller('') FallbackController
      // catch-all, which declared an empty base that mergePaths turned into a
      // never-matching '//{*splat}' under Express 5 — so it was INERT and unmatched
      // requests fell through to Express's default `Cannot GET /path` HTML. Registered
      // as a POST-BUILD app.use() so it runs strictly AFTER the controller router of
      // ALL five bundled services (and the setErrorConfig 500-handler): it catches only
      // genuinely-unmatched requests and cannot shadow any bundled controller or the
      // pre-build CalDAV routes. A live in-router catch-all here would front
      // every bundled service (FallbackController registered first), which is exactly
      // why this is a post-build handler and not a repaired controller.
      app.use(createFallbackHandler({ welcomeHtml: HOME_SERVER_WELCOME_HTML }))

      const serverInstance = http.createServer(app)

      const readinessState = container.get<{ markReady(): void; markUnavailable(): void }>(
        ApiGatewayTypes.ApiGateway_ReadinessState,
      )
      const emailDeliveryRuntime = container.isBound(ApiGatewayTypes.ApiGateway_EmailDeliveryRuntime)
        ? container.get<HomeServerRuntimeEmailDelivery>(ApiGatewayTypes.ApiGateway_EmailDeliveryRuntime)
        : undefined

      const keepAliveTimeout = env.get('HTTP_KEEP_ALIVE_TIMEOUT', true)
        ? +env.get('HTTP_KEEP_ALIVE_TIMEOUT', true)
        : 5000

      serverInstance.keepAliveTimeout = keepAliveTimeout

      const gatewayLogger = {
        info: (...args: unknown[]) => logger.info(args.map(String).join(' ')),
        warn: (...args: unknown[]) => logger.warn(args.map(String).join(' ')),
        error: (...args: unknown[]) => logger.error(args.map(String).join(' ')),
      }
      const webSocketRuntime = new SyncWebSocketRuntime()
      let syncStateRedis: Redis | undefined
      let inviteAvailabilityRedis: Redis | undefined
      let inviteEventAvailability: RedisInviteEventAvailabilityBus | undefined
      let inviteDomainEventBridge: InviteRealtimeDomainEventBridge | undefined
      let filesAdapter: HomeServerSyncFilesAdapter | undefined
      let realtime: { stop(): Promise<void> } | undefined
      const redisHost = env.get('REDIS_HOST', true) || undefined
      const connectionTokenSecret = env.get('WEB_SOCKET_CONNECTION_TOKEN_SECRET', true) || undefined
      if (connectionTokenSecret && redisHost) {
        try {
          let sync: SyncGatewayOptions | undefined
          if (webSocketSyncEnabled) {
            syncStateRedis = new Redis({
              host: redisHost,
              port: env.get('REDIS_PORT', true) ? +env.get('REDIS_PORT', true) : 6379,
              lazyConnect: false,
              maxRetriesPerRequest: 1,
            })
            syncStateRedis.on('error', () => logger.warn('WebSocket sync shared-state Redis connection error.'))
            inviteAvailabilityRedis = syncStateRedis.duplicate()
            inviteAvailabilityRedis.on('error', () =>
              logger.warn('WebSocket invite availability Redis connection error.'),
            )
            inviteEventAvailability = new RedisInviteEventAvailabilityBus(
              syncStateRedis as unknown as RedisInviteEventPublisher,
              inviteAvailabilityRedis as unknown as RedisInviteEventSubscriber,
            )
            const inviteEventComposition = createSharedInviteEventComposition({
              store: new RedisInviteEventStore(syncStateRedis as unknown as RedisInviteEventClient, {
                cursorSecret: connectionTokenSecret,
              }),
              availability: inviteEventAvailability,
            })
            inviteDomainEventBridge = createInviteRealtimeDomainEventBridge({
              dispatcher: inviteEventComposition.dispatcher,
              directCallPublisher: directCallDomainEventPublisher,
            })
            inviteDomainEventBridge.start()
            filesAdapter = await this.createSyncFilesAdapter(env, serviceContainer, container, logger)
            const syncAdapter = new SyncWebSocketCommandAdapter(
              container.get(ApiGatewayTypes.ApiGateway_ServiceProxy),
              new DirectCallSyncCommandPort(serviceContainer),
              env.get('AUTH_JWT_SECRET', true) || '',
              new CollaborationAuthorizationService(
                container.get(ApiGatewayTypes.ApiGateway_ServiceProxy),
                container.get(ApiGatewayTypes.ApiGateway_EndpointResolver),
                container.get(ApiGatewayTypes.ApiGateway_WEB_SOCKET_CONNECTION_TOKEN_SECRET),
                container.get(ApiGatewayTypes.ApiGateway_COLLABORATION_CAPABILITY_TTL),
              ),
            )
            sync = {
              isEnabled: () => webSocketSyncEnabled,
              allowedOrigins: syncAllowedOrigins,
              allowSameOrigin: syncAllowedOrigins.length === 0,
              authorization: syncAdapter,
              backend: syncAdapter,
              collaborationAuthorization: syncAdapter,
              apiRpc: new LoopbackSyncApiRpcAdapter({
                origin: `http://127.0.0.1:${port}`,
                operations: ['API_RPC', 'STREAM_ASSISTANT'],
              }),
              metrics: createLoggerSyncCommandMetrics(gatewayLogger),
              inviteEvents: inviteEventComposition.gatewayAdapter,
              inviteEventDispatcher: inviteEventComposition.dispatcher,
              files: filesAdapter,
              ...createRedisSyncState(syncStateRedis as unknown as SyncRedisClient, syncRedisOptions),
              requireSharedState: true,
            }
          }

          webSocketRuntime.attach({
            httpServer: serverInstance,
            logger: gatewayLogger,
            config: {
              connectionTokenSecret,
              connectionTokenTtl: env.get('WEB_SOCKET_CONNECTION_TOKEN_TTL', true) || '60s',
              internalSecret: env.get('WEBSOCKET_GATEWAY_INTERNAL_SECRET', true) || '',
              authJwtSecret: env.get('AUTH_JWT_SECRET', true) || '',
              redisHost,
              redisPort: env.get('REDIS_PORT', true) ? +env.get('REDIS_PORT', true) : 6379,
              maxConnectionsPerUser: parseOptionalPositiveInteger(
                'WEBSOCKET_MAX_CONNECTIONS_PER_USER',
                env.get('WEBSOCKET_MAX_CONNECTIONS_PER_USER', true) || undefined,
                1_024,
              ),
            },
            sync,
          })
          realtime = {
            stop: async (): Promise<void> => {
              try {
                await webSocketRuntime.stop()
              } finally {
                await inviteDomainEventBridge?.close().catch(() => undefined)
                inviteDomainEventBridge = undefined
                await inviteEventAvailability?.close().catch(() => undefined)
                inviteEventAvailability = undefined
                const availabilityRedis = inviteAvailabilityRedis
                inviteAvailabilityRedis = undefined
                if (availabilityRedis) {
                  try {
                    await availabilityRedis.quit()
                  } catch {
                    availabilityRedis.disconnect()
                  }
                }
                const redis = syncStateRedis
                syncStateRedis = undefined
                if (redis) {
                  try {
                    await redis.quit()
                  } catch {
                    redis.disconnect()
                  }
                }
              }
            },
          }
          logger.info('Realtime WebSocket gateway attached to the HomeServer HTTP server')
        } catch (error) {
          await webSocketRuntime.stop().catch(() => undefined)
          await inviteDomainEventBridge?.close().catch(() => undefined)
          inviteDomainEventBridge = undefined
          await inviteEventAvailability?.close().catch(() => undefined)
          inviteEventAvailability = undefined
          inviteAvailabilityRedis?.disconnect()
          inviteAvailabilityRedis = undefined
          syncStateRedis?.disconnect()
          throw error
        }
      } else if (webSocketSyncEnabled) {
        logger.warn(
          'WebSocket sync capability is unavailable: connection-token secret and shared Redis state are required.',
        )
      }

      try {
        listenHomeServer(serverInstance, port, bindAddress)
      } catch (error) {
        await realtime?.stop().catch(() => undefined)
        await webSocketRedisBridge.close().catch(() => undefined)
        throw error
      }

      await this.runtime.start({
        server: serverInstance,
        bridge: webSocketRedisBridge,
        emailDelivery: emailDeliveryRuntime,
        realtime,
        logger,
        readinessState,
        startScheduler: () => {
          const scheduler = container.get<{ stop(): void }>(ApiGatewayTypes.ApiGateway_ReminderDeliveryScheduler)
          if (startReminderDeliveryScheduler(container)) {
            logger.info('Reminder delivery scheduler started')
          }
          return scheduler
        },
        onSigterm: async () => {
          logger.info('SIGTERM signal received: stopping home server')
          const result = await this.stop()
          if (result.isFailed()) {
            throw new Error(result.getError())
          }
          logger.info('Home server stopped')
        },
      })

      this.authService = authService
      logger.info(`Server started on port ${port}. Log level: ${env.get('LOG_LEVEL', true)}.`)

      return Result.ok('Server started.')
    } catch (error) {
      const startupError = error as Error
      let cleanupError: string | undefined
      if (this.runtime.isActive() || this.logStream !== undefined) {
        const cleanupResult = await this.stopRunningServer()
        if (cleanupResult.isFailed()) {
          cleanupError = cleanupResult.getError()
        }
      } else {
        this.authService = undefined
      }
      console.error('Home server startup failed.')

      return Result.fail(
        cleanupError ? `${startupError.message}; startup cleanup failed: ${cleanupError}` : startupError.message,
      )
    } finally {
      this.starting = false
    }
  }

  async stop(): Promise<Result<string>> {
    if (this.stopPromise) {
      return this.stopPromise
    }
    if (this.starting) {
      return Result.fail('Home server is still starting.')
    }
    if (!this.runtime.isActive()) {
      return Result.fail('Home server is not running.')
    }

    this.stopPromise = this.stopRunningServer()
    try {
      return await this.stopPromise
    } finally {
      this.stopPromise = undefined
    }
  }

  /**
   * Build the canonical FILES_V1 storage adapter for the sync socket.
   *
   * The home server owns both the file bytes (FILE_UPLOAD_PATH, the same root
   * the files service uploads into) and the Auth/Syncing valet-token use cases
   * over the in-process service container, so the socket can authorize and
   * stream file transfers without a second HTTP hop. Returns undefined -- which
   * simply leaves FILES_V1 out of the advertised capability set -- whenever the
   * capability is switched off or its required secrets are missing.
   */
  private async createSyncFilesAdapter(
    env: Env,
    serviceContainer: ServiceContainer,
    container: Container,
    logger: winston.Logger,
  ): Promise<HomeServerSyncFilesAdapter | undefined> {
    if (!parseWebSocketFilesEnabled(env.get('WEBSOCKET_FILES_ENABLED', true) || undefined)) {
      logger.info('WebSocket FILES_V1 transport disabled by WEBSOCKET_FILES_ENABLED.')
      return undefined
    }

    const storageRoot = env.get('FILE_UPLOAD_PATH', true) || ''
    const authJwtSecret = env.get('AUTH_JWT_SECRET', true) || ''
    const valetTokenSecret = env.get('VALET_TOKEN_SECRET', true) || ''
    if (!storageRoot || !authJwtSecret || !valetTokenSecret) {
      logger.warn(
        'WebSocket FILES_V1 transport unavailable: FILE_UPLOAD_PATH, AUTH_JWT_SECRET and VALET_TOKEN_SECRET are required.',
      )
      return undefined
    }

    try {
      const adapter = new HomeServerSyncFilesAdapter({
        storageRoot: resolvePath(storageRoot),
        authorizer: new CanonicalHomeServerFileResourceAuthorizer({
          sessionValidator: container.get(
            ApiGatewayTypes.ApiGateway_ServiceProxy,
          ) as HomeServerSessionValidationPort,
          services: serviceContainer,
          authTokenDecoder: createSyncFilesTokenDecoder<HomeServerCrossServiceToken>(authJwtSecret),
          valetTokenDecoder: createSyncFilesTokenDecoder<
            HomeServerPersonalValetToken | HomeServerSharedVaultValetToken
          >(valetTokenSecret),
        }),
        maxActiveTransfers: parseOptionalPositiveInteger(
          'WEBSOCKET_FILES_MAX_ACTIVE_TRANSFERS',
          env.get('WEBSOCKET_FILES_MAX_ACTIVE_TRANSFERS', true) || undefined,
          4_096,
        ),
      })
      await adapter.initialize()
      logger.info('WebSocket FILES_V1 transport enabled on the realtime sync socket.')
      return adapter
    } catch (error) {
      // A missing or unusable storage root must not take realtime sync down
      // with it; the capability is simply not advertised.
      logger.warn('WebSocket FILES_V1 transport could not be initialized.', {
        error: error instanceof Error ? error.message : String(error),
      })
      return undefined
    }
  }

  private async stopRunningServer(): Promise<Result<string>> {
    const errors: Error[] = []
    try {
      await this.runtime.stop()
    } catch (error) {
      errors.push(error as Error)
    }

    try {
      this.runtimeLogLevelApplier?.stop()
    } catch (error) {
      errors.push(error as Error)
    } finally {
      this.runtimeLogLevelApplier = undefined
    }

    for (const loggerName of this.loggerNames) {
      try {
        winston.loggers.close(loggerName)
      } catch (error) {
        errors.push(error as Error)
      }
    }

    try {
      if (this.logStream) {
        this.logStream.end()
      }
    } catch (error) {
      errors.push(error as Error)
    } finally {
      this.logStream = undefined
      this.authService = undefined
    }

    if (errors.length > 0) {
      return Result.fail(errors.map((error) => error.message).join('; '))
    }

    return Result.ok('Server stopped.')
  }

  async isRunning(): Promise<boolean> {
    return this.runtime.isRunning()
  }

  async activatePremiumFeatures(dto: {
    username: string
    subscriptionId: number
    subscriptionPlanName?: string
    uploadBytesLimit?: number
    endsAt?: Date
    cancelPreviousSubscription?: boolean
  }): Promise<Result<string>> {
    if (!(await this.isRunning()) || !this.authService) {
      return Result.fail('Home server is not running.')
    }

    return this.authService.activatePremiumFeatures(dto)
  }

  private configureLoggers(env: Env, configuration: HomeServerConfiguration): void {
    this.logStream = new PassThrough()

    if (configuration.logStreamCallback) {
      this.logStream.on('data', configuration.logStreamCallback)
    }

    const winstonFormatters = [winston.format.splat(), winston.format.json()]

    const level = env.get('LOG_LEVEL', true) || 'info'

    for (const loggerName of this.loggerNames) {
      winston.loggers.add(loggerName, {
        level,
        format: winston.format.combine(...winstonFormatters),
        transports: [
          new winston.transports.Stream({
            level,
            stream: this.logStream,
          }),
        ],
        defaultMeta: { service: loggerName },
      })
    }

    // The all-in-one topology has one process and six named loggers. One poller
    // updates the complete set (including the outer home-server logger), while
    // injected service containers deliberately avoid starting duplicate polls.
    this.runtimeLogLevelApplier = new RuntimeLogLevelApplier(
      this.loggerNames.map((loggerName) => winston.loggers.get(loggerName)),
      new ServerSettingsLogLevelResolver(
        env.get('SERVER_SETTINGS_PATH', true) || undefined,
        env.get('LOG_LEVEL', true) || undefined,
      ),
    )
    this.runtimeLogLevelApplier.start()
  }
}
