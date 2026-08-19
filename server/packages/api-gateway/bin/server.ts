import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import 'reflect-metadata'

import '../src/Controller/HealthCheckController'

import '../src/Controller/v1/SessionsController'
import '../src/Controller/v1/UsersController'
import '../src/Controller/v1/ActionsController'
import '../src/Controller/v1/AdminController'
import '../src/Controller/v1/InvoicesController'
import '../src/Controller/v1/RevisionsController'
import '../src/Controller/v1/ItemsController'
import '../src/Controller/v1/PaymentsController'
import '../src/Controller/v1/WebSocketsController'
import '../src/Controller/v1/TokensController'
import '../src/Controller/v1/OfflineController'
import '../src/Controller/v1/FilesController'
import '../src/Controller/v1/SubscriptionInvitesController'
import '../src/Controller/v1/AuthenticatorsController'
import '../src/Controller/v1/AppPasswordsController'
import '../src/Controller/v1/MeInviteLinksController'
import '../src/Controller/v1/McpTokensController'
import '../src/Controller/v1/CaldavTokensController'
import '../src/Controller/v1/ReminderDeliveryController'
import '../src/Controller/v1/WebhooksController'
import '../src/Controller/v1/EmailRemindersController'
import '../src/Controller/v1/SharesController'
import '../src/Controller/v1/DeadManSwitchesController'
import '../src/Controller/v1/TrustedDevicesController'
import '../src/Controller/v1/PendingMfaApprovalsController'
import '../src/Controller/v1/MagicLinkController'
import '../src/Controller/v1/MessagesController'
import '../src/Controller/v1/SharedVaultsController'
import '../src/Controller/v1/SharedVaultInvitesController'
import '../src/Controller/v1/SharedVaultUsersController'
import '../src/Controller/v1/AssistantController'
import '../src/Controller/v1/OcrController'
import '../src/Controller/v1/CollaborationController'
import '../src/Controller/v1/WebController'
import '../src/Controller/v1/IntegrationsController'
import '../src/Controller/v1/WorkflowsController'
import '../src/Controller/v1/UpdatesController'
import '../src/Controller/v1/PluginsController'
import '../src/Controller/v1/SyncWebSocketController'

import '../src/Controller/v2/PaymentsControllerV2'
import '../src/Controller/v2/ActionsControllerV2'
import '../src/Controller/v2/RevisionsControllerV2'

import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { text, json, Request, Response, NextFunction } from 'express'
import * as http from 'http'
import * as winston from 'winston'

import { InversifyExpressServer, sanitizeRequestUrlForLogging } from 'inversify-express-utils'
import { ContainerConfigLoader } from '../src/Bootstrap/Container'
import { TYPES } from '../src/Bootstrap/Types'
import { Env } from '../src/Bootstrap/Env'
import { ResponseLocals } from '../src/Controller/ResponseLocals'
import { createFallbackHandler, API_GATEWAY_WELCOME_HTML } from '../src/Controller/FallbackController'
import {
  createSharedServerAccessKeyMiddleware,
  resolveSharedServerAccessKeyConfig,
} from '../src/Controller/SharedServerAccessKeyMiddleware'
import { configureTrustProxy } from '../src/Controller/TrustProxy'
import { parseClientIpHeaderName } from '../src/Controller/ClientIp'
import { decideCorsOrigin, resolveCorsStrictMode } from '../src/Controller/CorsOriginResolver'
import {
  buildDefaultRateLimitRules,
  createRateLimitMiddleware,
  RateLimitConfig,
  RateLimitRedis,
} from '../src/Controller/RateLimitMiddleware'
import { IpAccessListStore } from '../src/Controller/IpAccessList'
import { RateLimitMetricsStore } from '../src/Controller/RateLimitMetrics'
import { ServerSettingsResolver } from '../src/Service/ServerSettings/ServerSettingsResolver'
import { registerCaldavRoutes } from '../src/Caldav/registerCaldavRoutes'
import { startReminderDeliveryScheduler } from '../src/ReminderDelivery/startReminderDeliveryScheduler'
import { requestBodyLogMetadata } from '../src/Logging/RequestBodyLogMetadata'
import {
  createRedisSqsEventDedupStore,
  createLoggerSyncCommandMetrics,
  createSharedInviteEventComposition,
  createRedisSyncState,
  RedisInviteEventAvailabilityBus,
  RedisInviteEventStore,
  type RedisInviteEventClient,
  type RedisInviteEventPublisher,
  type RedisInviteEventSubscriber,
  type RedisSqsEventDedupClient,
  type SyncGatewayOptions,
  type SyncRedisClient,
} from '@standard-red-notes/websocket-gateway'
import { RequiredCrossServiceTokenMiddleware } from '../src/Controller/RequiredCrossServiceTokenMiddleware'
import { createAdminEmailDeliveryRouter } from '../src/Controller/v1/createAdminEmailDeliveryRouter'
import { AdminEmailDeliveryService } from '../src/Service/EmailDelivery/AdminEmailDeliveryService'
import { EmailDeliveryRuntime } from '../src/Service/EmailDelivery/EmailDeliveryRuntime'
import { DurableSyncCommandPort, SyncWebSocketCommandAdapter } from '../src/Service/Sync/SyncWebSocketCommandAdapter'
import { CollaborationAuthorizationService } from '../src/Service/Sync/CollaborationAuthorizationService'
import { LoopbackSyncApiRpcAdapter } from '../src/Service/Sync/LoopbackSyncApiRpcAdapter'
import {
  parseOptionalPositiveInteger,
  parseWebSocketSyncEnabled,
  resolveWebSocketSyncAllowedOrigins,
} from '../src/Service/Sync/SyncWebSocketConfiguration'
import { SyncWebSocketRuntime } from '../src/Service/Sync/SyncWebSocketRuntime'

// Standard Red Notes: fail-fast global crash handlers. A genuinely unhandled
// rejection or uncaught exception leaves the process in an unknown state, so we
// log a clear FATAL line (with stack) and exit non-zero to let the supervisor
// restart us. This keeps crash-loops VISIBLE instead of silently swallowed.
let fatalLogger: { error: (message: string, metadata?: Record<string, unknown>) => void } = console
const logFatal = (label: string, error: unknown): void => {
  fatalLogger.error(`FATAL ${label}.`, safeErrorLogMetadata(error))
}
process.on('unhandledRejection', (reason: unknown) => {
  logFatal('unhandledRejection', reason)
  process.exit(1)
})
process.on('uncaughtException', (error: Error) => {
  logFatal('uncaughtException', error)
  process.exit(1)
})

const container = new ContainerConfigLoader()
void container
  .load()
  .then(async (container) => {
    const env: Env = new Env()
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

    const logger: winston.Logger = container.get(TYPES.ApiGateway_Logger)
    fatalLogger = logger

    // Standard Red Notes: the realtime WS token-mint route is registered on the app
    // INSIDE setConfig (before build(), so the catch-all cannot shadow it), but its
    // handler only exists once the gateway is attached to the owned http.Server.
    // Bridge the two with this late-bound handler: setConfig registers a route that
    // dispatches to it, and the pre-listen gateway attach assigns
    // gateway.handleMintToken into it.
    let mintConnectionTokenHandler: ((request: Request, response: Response) => void) | undefined

    const server = new InversifyExpressServer(container)

    server.setConfig((app) => {
      // Standard Red Notes: honor X-Forwarded-Proto / X-Forwarded-For when the
      // stack runs behind a TLS-terminating reverse proxy, so req.secure,
      // req.protocol and req.ip reflect the real client. Configurable via
      // TRUST_PROXY (see TrustProxy.ts). Default trusts only loopback/private
      // (Docker) networks, so direct access still works and a remote client
      // cannot spoof the forwarded headers.
      configureTrustProxy(app, env.get('TRUST_PROXY', true))

      // Standard Red Notes: optional trusted client-IP header (CLIENT_IP_HEADER; empty
      // = off). Fed into every IP consumer via the canonical resolveClientIp so the
      // rate limiter, IP allow/block list and auth session IP all agree. See ClientIp.ts.
      const clientIpHeader = parseClientIpHeaderName(env.get('CLIENT_IP_HEADER', true))

      app.use((request: Request, _response: Response, next: NextFunction) => {
        if (request.hostname.includes('standardnotes.org')) {
          logger.debug('Request is using deprecated domain', {
            origin: request.headers.origin,
            method: request.method,
            url: sanitizeRequestUrlForLogging(request.url),
            snjs: request.headers['x-snjs-version'],
            application: request.headers['x-application-version'],
          })
        }

        next()
      })
      app.use((_request: Request, response: Response, next: NextFunction) => {
        response.setHeader('X-API-Gateway-Version', container.get(TYPES.ApiGateway_VERSION))
        next()
      })

      // Standard Red Notes: Redis-backed IP rate limiting on the unauthenticated,
      // auth-adjacent endpoints (login, registration, MCP-token authenticate,
      // magic-link request, recovery). Reuses the gateway's existing ioredis client
      // (present unless CACHE_TYPE is in-memory); fail-open when Redis is down so a
      // cache outage never locks users out of auth. Keyed by req.ip, which honors
      // the configured TRUST_PROXY (set above), so a direct client cannot spoof it.
      // Tunable via RATE_LIMIT_* env; disable entirely with RATE_LIMIT_ENABLED=false.
      const rateLimitRedis = container.isBound(TYPES.ApiGateway_Redis)
        ? (container.get(TYPES.ApiGateway_Redis) as RateLimitRedis)
        : undefined
      // Standard Red Notes: the effective tier config is now resolved PER REQUEST
      // from the ServerSettings overlay (admin value wins over RATE_LIMIT_* env wins
      // over the safe defaults that reproduce the historical hardcoded behavior), so
      // an admin can retune the tiers without a restart. IP allow/block lists +
      // throttle telemetry are wired in when Redis is bound.
      const rateLimitResolver = container.get<ServerSettingsResolver>(TYPES.ApiGateway_ServerSettingsResolver)
      const ipAccessList = container.isBound(TYPES.ApiGateway_IpAccessListStore)
        ? container.get<IpAccessListStore>(TYPES.ApiGateway_IpAccessListStore)
        : undefined
      const rateLimitMetrics = container.isBound(TYPES.ApiGateway_RateLimitMetricsStore)
        ? container.get<RateLimitMetricsStore>(TYPES.ApiGateway_RateLimitMetricsStore)
        : undefined
      // Item 5: when adaptive escalation is enabled, flag an IP that trips a tier in
      // Redis (short TTL) so downstream adaptive anti-bot logic can require a
      // proof-of-work challenge on that address's next attempts. Best-effort.
      const escalationRedis = rateLimitRedis as unknown as {
        set?(key: string, value: string, mode: string, seconds: number): Promise<unknown>
      }
      app.use(
        createRateLimitMiddleware({
          redis: rateLimitRedis,
          logger: {
            warn: (message: string, metadata?: Record<string, unknown>) => logger.warn(message, metadata),
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
          ipAccessList,
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

      app.use(cookieParser() as never)

      app.use(json({ limit: requestPayloadLimit }))
      app.use(
        text({
          type: ['text/plain', 'application/x-www-form-urlencoded', 'application/x-www-form-urlencoded; charset=utf-8'],
        }),
      )
      const corsAllowedOrigins = container.get<string[]>(TYPES.ApiGateway_CORS_ALLOWED_ORIGINS)
      // Standard Red Notes: CORS defaults to STRICT for self-host safety. When
      // CORS_ORIGIN_STRICT_MODE_ENABLED is unset we now only reflect origins that
      // legitimately need credentialed cross-origin access (desktop app, the
      // Firefox/Chromium/Safari clippers, a localhost self-host, and anything the
      // operator lists in CORS_ALLOWED_ORIGINS) — NOT any Origin as before. Set
      // CORS_ORIGIN_STRICT_MODE_ENABLED=false to restore the legacy permissive
      // "reflect any Origin" behavior. See CorsOriginResolver for the full model.
      const corsStrictMode = resolveCorsStrictMode(env.get('CORS_ORIGIN_STRICT_MODE_ENABLED', true))
      app.use(
        cors({
          credentials: true,
          exposedHeaders: ['x-captcha-required'],
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
            // header (the cors package treats a falsy origin as "no CORS headers,
            // continue"). The browser then blocks the cross-origin RESPONSE, while
            // SAME-ORIGIN requests — which need no ACAO — keep working on any
            // custom domain. We deliberately do NOT throw here (throwing would 500
            // the request and break same-origin deployments).
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
      // default (zero behavior change). See SharedServerAccessKeyMiddleware for the
      // security model — this is OBFUSCATION/access-gating, not E2E security.
      const sharedServerAccessKeyConfig = resolveSharedServerAccessKeyConfig(
        env.get('SHARED_SERVER_ACCESS_KEY', true),
        env.get('SHARED_SERVER_ACCESS_KEY_MODE', true),
      )
      app.use(createSharedServerAccessKeyMiddleware(sharedServerAccessKeyConfig))

      // The advanced email control plane is boot-mounted ahead of the
      // inversify controller router and catch-all. It reuses the canonical
      // session middleware; CACHE_TYPE=memory deliberately passes no facade so
      // the child reports capability-unavailable while legacy SMTP remains.
      const emailDeliveryAuth = container.get<RequiredCrossServiceTokenMiddleware>(
        TYPES.ApiGateway_RequiredCrossServiceTokenMiddleware,
      )
      const adminEmailDelivery = container.isBound(TYPES.ApiGateway_AdminEmailDeliveryService)
        ? container.get<AdminEmailDeliveryService>(TYPES.ApiGateway_AdminEmailDeliveryService)
        : undefined
      app.use(
        '/v1/admin/email-delivery',
        createAdminEmailDeliveryRouter(adminEmailDelivery, {
          authenticationMiddleware: emailDeliveryAuth.handler.bind(emailDeliveryAuth),
          auditLogger: logger,
        }),
      )

      // Standard Red Notes: mount the CalDAV router and the realtime WS token-mint
      // route INSIDE setConfig — i.e. BEFORE server.build().
      // build() mounts the inversify controller router at '/'. The trailing unmatched
      // handler is now a POST-BUILD app.use() fallback (see after build(), replacing the
      // former inert @controller('') catch-all), so these routes are no longer at risk
      // of being shadowed — but keeping them pre-build (ahead of the controller router)
      // remains the correct, defensive placement and matches the boot-mounted route
      // ordering guard. Registering here also keeps them after all the body/cookie/CORS/
      // rate-limit/shared-key middleware above. CalDAV gates itself internally
      // (404 when CALDAV_ENABLED is off), so mounting it unconditionally is safe.
      try {
        registerCaldavRoutes(app, container)
        logger.info('CalDAV router mounted')
      } catch (error) {
        logger.error('Failed to mount CalDAV router.', safeErrorLogMetadata(error))
      }
      // The realtime WS token-mint endpoint must also precede the catch-all, but its
      // real handler is only available once the gateway is attached to the owned
      // http.Server (before listen, below). Register the route now and dispatch to the late-bound
      // handler; reply 503 until it is wired / when token minting is disabled (no
      // WEB_SOCKET_CONNECTION_TOKEN_SECRET), instead of silently falling through to the
      // catch-all as before.
      app.post('/sockets/tokens', (request: Request, response: Response) => {
        if (mintConnectionTokenHandler) {
          mintConnectionTokenHandler(request, response)
        } else {
          response.status(503).json({ error: { message: 'Realtime token minting is not enabled.' } })
        }
      })
    })

    server.setErrorConfig((app) => {
      app.use((error: Record<string, unknown>, request: Request, response: Response, _next: NextFunction) => {
        const locals = response.locals as ResponseLocals
        const sanitizedRequestUrl = sanitizeRequestUrlForLogging(request.url)

        logger.error('Request failed.', {
          ...safeErrorLogMetadata(error),
          origin: request.headers.origin,
          codeTag: 'server.ts',
          method: request.method,
          url: sanitizedRequestUrl,
          snjs: request.headers['x-snjs-version'],
          application: request.headers['x-application-version'],
          userId: locals.user ? locals.user.uuid : undefined,
        })
        logger.debug(
          `[URL: |${request.method}| ${sanitizedRequestUrl}][SNJS: ${request.headers['x-snjs-version']}][Application: ${
            request.headers['x-application-version']
          }] Request body metadata: ${JSON.stringify(requestBodyLogMetadata(request.body))}`,
        )

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

    // `server.build()` returns the underlying Express application; keep a handle
    // so the realtime WebSocket gateway can register its token route on it, then
    // create the Node http.Server the ws upgrade attaches to.
    // Standard Red Notes: build() mounts the inversify controller router at '/'. The
    // CalDAV router and the WS token-mint route are registered INSIDE setConfig
    // above (before this call), ahead of the controller router — see the note there.
    const app = await server.build()

    // Standard Red Notes: cosmetic welcome page (GET /) + JSON 404 fallback. This
    // replaces the former @controller('') LegacyController catch-all, which declared an
    // empty base that mergePaths turned into a never-matching '//{*splat}' under Express
    // 5 — so it was INERT and unmatched requests fell through to Express's default
    // `Cannot GET /path` HTML. Registered as a POST-BUILD app.use() so it runs strictly
    // AFTER the controller router (and the setErrorConfig 500-handler): it catches only
    // genuinely-unmatched requests and cannot shadow any controller or the pre-build
    // CalDAV/sockets routes. The old LegacyController's un-versioned legacy
    // proxy is intentionally NOT restored (dead since the Express-5 upgrade).
    app.use(createFallbackHandler({ welcomeHtml: API_GATEWAY_WELCOME_HTML }))

    // Start the durable consumer before the HTTP listener can advertise a live
    // API. Its short-lived Redis marker is published only when both the worker
    // and an enabled relay are ready.
    const emailDeliveryRuntime = container.isBound(TYPES.ApiGateway_EmailDeliveryRuntime)
      ? container.get<EmailDeliveryRuntime>(TYPES.ApiGateway_EmailDeliveryRuntime)
      : undefined
    if (emailDeliveryRuntime) {
      try {
        if (await emailDeliveryRuntime.start()) {
          logger.info('Email delivery runtime started')
        }
      } catch (error) {
        logger.error('Failed to start email delivery runtime.', safeErrorLogMetadata(error))
      }
    }

    // Standard Red Notes: start the reminder-delivery scheduler. It gates itself on
    // the REMINDER_DELIVERY_ENABLED master switch (start() no-ops when off).
    try {
      if (startReminderDeliveryScheduler(container)) {
        logger.info('Reminder delivery scheduler started')
      }
    } catch (error) {
      logger.error('Failed to start reminder delivery scheduler.', safeErrorLogMetadata(error))
    }

    const readinessState = container.get<{ markReady(): void; markUnavailable(): void }>(
      TYPES.ApiGateway_ReadinessState,
    )
    readinessState.markUnavailable()
    const serverInstance = http.createServer(app)

    const keepAliveTimeout = env.get('HTTP_KEEP_ALIVE_TIMEOUT', true) ? +env.get('HTTP_KEEP_ALIVE_TIMEOUT', true) : 5000

    serverInstance.keepAliveTimeout = keepAliveTimeout

    // Standard Red Notes: run the realtime WebSocket gateway IN-PROCESS on the same
    // http server / port (3000) instead of a separate listener (formerly :3106).
    // It binds the ws upgrade to `serverInstance` and starts the Redis bridge +
    // (optional) SQS consumer. The `POST /sockets/tokens` route is registered on the
    // Express app in setConfig (before build(), so the catch-all does not shadow it);
    // here we just point that route's late-bound handler at gateway.handleMintToken.
    // Adapt the winston logger to the gateway's minimal Logger interface
    // (variadic info/warn/error returning void). winston's leveled methods accept
    // a message + meta, so join the args into one message string.
    const gatewayLogger = {
      info: (...args: unknown[]) => logger.info(args.map(String).join(' ')),
      warn: (...args: unknown[]) => logger.warn(args.map(String).join(' ')),
      error: (...args: unknown[]) => logger.error(args.map(String).join(' ')),
    }

    const webSocketRuntime = new SyncWebSocketRuntime()
    let stopWebSocketGateway: (() => Promise<void>) | undefined
    let inviteEventAvailability: RedisInviteEventAvailabilityBus | undefined
    let inviteAvailabilityRedis:
      | (RedisInviteEventSubscriber & { quit(): Promise<unknown>; disconnect(): void })
      | undefined
    if (env.get('WEB_SOCKET_CONNECTION_TOKEN_SECRET', true)) {
      try {
        let sync: SyncGatewayOptions | undefined
        if (
          webSocketSyncEnabled &&
          container.isBound(TYPES.ApiGateway_Redis) &&
          container.isBound(TYPES.ApiGateway_GRPCSyncingServerServiceProxy)
        ) {
          const syncAdapter = new SyncWebSocketCommandAdapter(
            container.get(TYPES.ApiGateway_ServiceProxy),
            container.get(TYPES.ApiGateway_GRPCSyncingServerServiceProxy) as DurableSyncCommandPort,
            env.get('AUTH_JWT_SECRET', true) || '',
            new CollaborationAuthorizationService(
              container.get(TYPES.ApiGateway_ServiceProxy),
              container.get(TYPES.ApiGateway_EndpointResolver),
              container.get(TYPES.ApiGateway_WEB_SOCKET_CONNECTION_TOKEN_SECRET),
              container.get(TYPES.ApiGateway_COLLABORATION_CAPABILITY_TTL),
            ),
          )
          const redisClient = container.get(TYPES.ApiGateway_Redis) as SyncRedisClient &
            RedisInviteEventClient &
            RedisInviteEventPublisher & {
              duplicate(): RedisInviteEventSubscriber & { quit(): Promise<unknown>; disconnect(): void }
            }
          const redisState = createRedisSyncState(redisClient, syncRedisOptions)
          inviteAvailabilityRedis = redisClient.duplicate()
          inviteEventAvailability = new RedisInviteEventAvailabilityBus(redisClient, inviteAvailabilityRedis)
          const inviteEventComposition = createSharedInviteEventComposition({
            store: new RedisInviteEventStore(redisClient, {
              cursorSecret: env.get('WEB_SOCKET_CONNECTION_TOKEN_SECRET', true),
            }),
            availability: inviteEventAvailability,
          })
          sync = {
            isEnabled: () => webSocketSyncEnabled,
            allowedOrigins: syncAllowedOrigins,
            allowSameOrigin: syncAllowedOrigins.length === 0,
            authorization: syncAdapter,
            backend: syncAdapter,
            collaborationAuthorization: syncAdapter,
            apiRpc: new LoopbackSyncApiRpcAdapter({
              origin: `http://127.0.0.1:${env.get('PORT', true) || '3000'}`,
              operations: ['API_RPC', 'STREAM_ASSISTANT'],
            }),
            metrics: createLoggerSyncCommandMetrics(gatewayLogger),
            inviteEvents: inviteEventComposition.gatewayAdapter,
            inviteEventDispatcher: inviteEventComposition.dispatcher,
            ...redisState,
            requireSharedState: true,
          }
          // FILES_V1 (`sync.files`) is deliberately NOT supplied here, so the
          // capability is simply absent from this deployment's advertised
          // operations. The only implemented adapter is the home server's, and
          // it needs two things this bootstrap does not have: the canonical file
          // bytes on a local filesystem root, and the in-process Auth/Syncing
          // service container the valet-token authorization path calls into. In
          // the distributed topology the files service owns the bytes (S3 or its
          // own volume) and Auth/Syncing are reached over HTTP, so wiring the
          // filesystem adapter here would authorize transfers against a disk
          // that holds no user files. Serving FILES_V1 from this bootstrap needs
          // a files-service-backed adapter, not extra configuration.
          logger.info(
            'Realtime FILES_V1 transport not advertised: the distributed api-gateway does not own canonical file storage.',
          )
        } else if (webSocketSyncEnabled) {
          logger.warn('WebSocket sync capability is unavailable: durable backend and shared Redis state are required.')
        }

        const gateway = webSocketRuntime.attach({
          httpServer: serverInstance,
          logger: gatewayLogger,
          config: {
            connectionTokenSecret: env.get('WEB_SOCKET_CONNECTION_TOKEN_SECRET', true),
            connectionTokenTtl: env.get('WEB_SOCKET_CONNECTION_TOKEN_TTL', true) || '60s',
            internalSecret: env.get('WEBSOCKET_GATEWAY_INTERNAL_SECRET', true) || '',
            authJwtSecret: env.get('AUTH_JWT_SECRET', true) || '',
            redisHost: env.get('REDIS_HOST', true) || '127.0.0.1',
            redisPort: env.get('REDIS_PORT', true) ? +env.get('REDIS_PORT', true) : 6379,
            maxConnectionsPerUser: env.get('WEBSOCKET_MAX_CONNECTIONS_PER_USER', true)
              ? +env.get('WEBSOCKET_MAX_CONNECTIONS_PER_USER', true)
              : undefined,
            sqs: {
              queueUrl: env.get('SQS_QUEUE_URL', true) || undefined,
              endpoint: env.get('SQS_ENDPOINT', true) || undefined,
              region: env.get('SQS_AWS_REGION', true) || undefined,
              accessKeyId: env.get('SQS_ACCESS_KEY_ID', true) || undefined,
              secretAccessKey: env.get('SQS_SECRET_ACCESS_KEY', true) || undefined,
            },
          },
          sync,
          sqsEventDedupStore: container.isBound(TYPES.ApiGateway_Redis)
            ? createRedisSqsEventDedupStore(container.get(TYPES.ApiGateway_Redis) as RedisSqsEventDedupClient)
            : undefined,
        })
        stopWebSocketGateway = async (): Promise<void> => {
          mintConnectionTokenHandler = undefined
          try {
            await webSocketRuntime.stop()
          } finally {
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
          }
        }
        mintConnectionTokenHandler = gateway.handleMintToken
        logger.info('Realtime WebSocket gateway attached in-process on the api-gateway http server')
      } catch (error) {
        await inviteEventAvailability?.close().catch(() => undefined)
        inviteEventAvailability = undefined
        inviteAvailabilityRedis?.disconnect()
        inviteAvailabilityRedis = undefined
        logger.error('Failed to attach the realtime WebSocket gateway.', safeErrorLogMetadata(error))
        throw error
      }
    } else {
      logger.info(
        'WEB_SOCKET_CONNECTION_TOKEN_SECRET not set; realtime WebSocket gateway not attached (token minting disabled)',
      )
    }

    serverInstance.listen(env.get('PORT'), () => {
      readinessState.markReady()
      logger.info(`Server started on port ${env.get('PORT')}`)
    })

    let shuttingDown = false
    process.on('SIGTERM', () => {
      if (shuttingDown) {
        return
      }
      shuttingDown = true
      readinessState.markUnavailable()
      logger.info('SIGTERM signal received: draining realtime services before closing HTTP')
      void Promise.allSettled([emailDeliveryRuntime?.stop(), stopWebSocketGateway?.()]).then(() => {
        logger.info('Background delivery and realtime services stopped')
        serverInstance.close(() => {
          logger.info('HTTP server closed')
        })
      })
    })
  })
  .catch((error: unknown) => {
    logFatal('startup', error)
    process.exit(1)
  })
