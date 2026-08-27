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
import { createMultiContainerFilesComposition } from '../src/Service/Files/createMultiContainerFilesComposition'
import { DurableSyncCommandPort, SyncWebSocketCommandAdapter } from '../src/Service/Sync/SyncWebSocketCommandAdapter'
import { CollaborationAuthorizationService } from '../src/Service/Sync/CollaborationAuthorizationService'
import { LoopbackSyncApiRpcAdapter } from '../src/Service/Sync/LoopbackSyncApiRpcAdapter'
import {
  parseOptionalPositiveInteger,
  parseWebSocketSyncEnabled,
  resolveWebSocketSyncAllowedOrigins,
} from '../src/Service/Sync/SyncWebSocketConfiguration'
import { SyncWebSocketRuntime } from '../src/Service/Sync/SyncWebSocketRuntime'
import {
  describeUnmetSyncPreconditions,
  resolveUnmetSyncItemsPreconditions,
  resolveUnmetSyncTransportPreconditions,
} from '../src/Service/Sync/SyncWebSocketPreconditions'
import { syncGateDiagnostics, SyncFilesUnmetCondition } from '../src/Service/Sync/SyncGateDiagnostics'

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
    // Standard Red Notes: record WHICH of the sync-lane preconditions held, so the
    // admin diagnostics endpoint can name the missing one instead of repeating the
    // log line's "durable backend and shared Redis state are required" — which
    // never says which of the two is absent. Recorded before the lane is built so
    // a failure inside the try still leaves the gate decision on record; the
    // resolution itself lives in SyncWebSocketPreconditions, shared with the log.
    // Presence only: booleans, never the configured values.
    // The sync lane's invite-event cursor codec HMACs with this secret and
    // REJECTS anything under 32 bytes by throwing. While the lane was gated on
    // the gRPC proxy, a deployment with a short secret and no gRPC never
    // reached that constructor and booted (with a dead socket); now that the
    // lane opens without gRPC it would reach it and take the PROCESS down on a
    // config that used to start. So a too-short secret is treated as an unmet
    // precondition — reported by the gate with a named remedy — rather than as
    // a crash. Length only; the value is never read into a log or a diagnostic.
    const connectionTokenSecret = env.get('WEB_SOCKET_CONNECTION_TOKEN_SECRET', true)
    const connectionTokenSecretUsable = Buffer.byteLength(connectionTokenSecret || '', 'utf8') >= 32
    const gateObservation = {
      connectionTokenSecretPresent: connectionTokenSecretUsable,
      webSocketSyncEnabled,
      redisBound: container.isBound(TYPES.ApiGateway_Redis),
      syncingServerGrpcBound: container.isBound(TYPES.ApiGateway_GRPCSyncingServerServiceProxy),
    }
    syncGateDiagnostics.record({ ...gateObservation, filesAdvertised: false })

    // Standard Red Notes: the DEFINITIVE, once-per-boot verdict on the realtime
    // lane. The gate is evaluated exactly here and never re-evaluated, so this
    // single line is complete — an operator does not need to catch a request in
    // flight to learn why sync is off, and a client retry storm cannot bury it.
    // Per-request refusals (SyncWebSocketController) are throttled precisely
    // because this line is the authoritative one. Names env VARIABLES, never
    // their values: `gateObservation` is booleans and the remedies are constants.
    // The TRANSPORT verdict. Since the socket lane no longer depends on the
    // server-to-server gRPC proxy, this is evaluated over the transport
    // preconditions only; the durable-backend verdict is its own line below.
    const unmetSyncPreconditions = resolveUnmetSyncTransportPreconditions(gateObservation)
    if (unmetSyncPreconditions.length === 0) {
      logger.info('WebSocket sync preconditions are satisfied; the realtime transport will be advertised.')
    } else {
      logger.warn(
        `WebSocket sync is UNAVAILABLE. Unmet preconditions: ${describeUnmetSyncPreconditions(unmetSyncPreconditions)}`,
        { unmetPreconditions: unmetSyncPreconditions.map(({ code }) => code) },
      )
    }
    // The SYNC_ITEMS verdict, stated separately and never folded into the line
    // above. A client whose socket is healthy but carries no SYNC_ITEMS syncs
    // over HTTP while everything else stays realtime, and an operator needs to
    // be able to see exactly that rather than infer it from a silent lane.
    const unmetSyncItemsPreconditions = resolveUnmetSyncItemsPreconditions(gateObservation)
    if (unmetSyncItemsPreconditions.length > 0) {
      logger.warn(
        `Realtime SYNC_ITEMS will NOT be advertised (the socket lane is unaffected and still serves its other capabilities). Unmet preconditions: ${describeUnmetSyncPreconditions(unmetSyncItemsPreconditions)}`,
        { unmetPreconditions: unmetSyncItemsPreconditions.map(({ code }) => code) },
      )
    }

    if (env.get('WEB_SOCKET_CONNECTION_TOKEN_SECRET', true)) {
      try {
        let sync: SyncGatewayOptions | undefined
        // Standard Red Notes: the lane is gated on TRANSPORT prerequisites only
        // — the ticket-signing secret, the kill switch, and the fleet-shared
        // Redis state every capability rides on. The gRPC syncing proxy is a
        // server-to-server dependency of ONE operation (SYNC_ITEMS) and is
        // resolved separately just below; requiring it here is what closed the
        // whole socket with 1013 on every deployment that does not set
        // SERVICE_PROXY_TYPE=grpc, taking AUTHORIZE_COLLABORATION, API_RPC,
        // STREAM_ASSISTANT, INVITE_EVENTS and FILES_V1 down with it.
        // `connectionTokenSecretUsable` (not mere presence) — see the note at
        // the gate. The OUTER `if` still keys off presence alone, so the legacy
        // `/?authToken=` collaboration lane and token minting are untouched by
        // a short secret; only the sync lane, which is what actually consumes
        // it as an HMAC key, declines to build.
        if (connectionTokenSecretUsable && webSocketSyncEnabled && container.isBound(TYPES.ApiGateway_Redis)) {
          // Undefined when this deployment binds no durable command port. The
          // adapter then reports `ready() === false` and the gateway withholds
          // SYNC_ITEMS from negotiation; it never fabricates a second executor.
          const durableSyncPort = container.isBound(TYPES.ApiGateway_GRPCSyncingServerServiceProxy)
            ? (container.get(TYPES.ApiGateway_GRPCSyncingServerServiceProxy) as DurableSyncCommandPort)
            : undefined
          const syncAdapter = new SyncWebSocketCommandAdapter(
            container.get(TYPES.ApiGateway_ServiceProxy),
            durableSyncPort,
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
          // -----------------------------------------------------------------
          // FILES_V1 seam.
          //
          // The distributed deployment does NOT own canonical file storage, so
          // it cannot use the home server's filesystem adapter -- that one
          // authorizes against a local storage root and an in-process
          // Auth/Syncing container, and here the files service owns the bytes
          // (S3 or its own volume) while Auth/Syncing are reached over HTTP.
          // `MultiContainerSyncFilesAdapter` is the counterpart built for this
          // topology: it reaches the files service over HTTP and authorizes
          // every operation with a freshly minted, single-use valet credential.
          //
          // Required configuration (see createMultiContainerFilesComposition):
          //   - an INTERNAL files service URL. WEBSOCKET_SYNC_FILES_URL or
          //     FILES_SERVER_PROBE_URL; FILES_SERVER_URL is used only when it
          //     is demonstrably not PUBLIC_FILES_SERVER_URL, because the
          //     bundled image aliases the two and the public URL is not
          //     reachable from inside the container.
          //   - VALET_TOKEN_SECRET, to verify minted credentials before they
          //     are presented to storage.
          //   - AUTH_JWT_SECRET, to re-validate the session behind a transfer.
          //
          // Absent any of those the composition waives the lane explicitly
          // rather than advertising a capability every transfer would fail.
          // The gateway rejects a shared-state composition that neither
          // supplies nor waives FILES_V1, so this is always a stated decision.
          // -----------------------------------------------------------------
          const filesComposition = createMultiContainerFilesComposition(
            {
              websocketSyncFilesUrl: env.get('WEBSOCKET_SYNC_FILES_URL', true) || undefined,
              filesServerProbeUrl: env.get('FILES_SERVER_PROBE_URL', true) || undefined,
              filesServerUrl: env.get('FILES_SERVER_URL', true) || undefined,
              publicFilesServerUrl: env.get('PUBLIC_FILES_SERVER_URL', true) || undefined,
              authJwtSecret: env.get('AUTH_JWT_SECRET', true) || undefined,
              valetTokenSecret: env.get('VALET_TOKEN_SECRET', true) || undefined,
            },
            {
              serviceProxy: container.get(TYPES.ApiGateway_ServiceProxy),
              endpointResolver: container.get(TYPES.ApiGateway_EndpointResolver),
              httpClient: container.get(TYPES.ApiGateway_HTTPClient),
            },
          )

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
            ...filesComposition.option,
          }
          // Standard Red Notes: re-derive WHICH files precondition failed, as a
          // literal key, for the admin diagnostics endpoint. Deliberately NOT
          // taken from `filesComposition.reason`: the construction-failure branch
          // interpolates the thrown message, which can embed the resolved
          // files-service URL. The reason string stays in the boot log (where the
          // operator already holds the host); the endpoint gets the key only.
          const filesUnmetCondition: SyncFilesUnmetCondition | undefined = filesComposition.advertised
            ? undefined
            : !(
                  env.get('WEBSOCKET_SYNC_FILES_URL', true) ||
                  env.get('FILES_SERVER_PROBE_URL', true) ||
                  env.get('FILES_SERVER_URL', true)
                )
              ? 'FILES_INTERNAL_URL'
              : !env.get('AUTH_JWT_SECRET', true)
                ? 'AUTH_JWT_SECRET'
                : !env.get('VALET_TOKEN_SECRET', true)
                  ? 'VALET_TOKEN_SECRET'
                  : 'TRANSPORT_CONSTRUCTION'
          syncGateDiagnostics.record({
            ...gateObservation,
            filesAdvertised: filesComposition.advertised,
            ...(filesUnmetCondition ? { filesUnmetCondition } : {}),
          })

          if (filesComposition.advertised) {
            logger.info(
              `Realtime FILES_V1 transport advertised against the files service at ${filesComposition.filesServerUrl} (from ${filesComposition.source})`,
            )
          } else {
            logger.info(`Realtime FILES_V1 transport not advertised: ${filesComposition.reason}.`)
          }
        } else if (webSocketSyncEnabled) {
          // This branch means the sync lane was NOT built — which now happens
          // only when a TRANSPORT precondition is unmet (in practice: Redis).
          // An unbound gRPC syncing proxy no longer reaches here; it withholds
          // SYNC_ITEMS and is reported by its own line at the gate above.
          logger.warn(
            `WebSocket sync capability was not built: ${describeUnmetSyncPreconditions(unmetSyncPreconditions)}`,
            { unmetPreconditions: unmetSyncPreconditions.map(({ code }) => code) },
          )
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
