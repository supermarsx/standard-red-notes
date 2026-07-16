import 'reflect-metadata'

import { ControllerContainer, Result, ServiceContainer } from '@standardnotes/domain-core'
import {
  Service as ApiGatewayService,
  configureTrustProxy,
  createSharedServerAccessKeyMiddleware,
  resolveSharedServerAccessKeyConfig,
  registerCaldavRoutes,
  registerWorkflowsUiProxy,
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
  TYPES as ApiGatewayTypes,
} from '@standardnotes/api-gateway'
import { Service as FilesService } from '@standardnotes/files-server'
import { DirectCallDomainEventPublisher } from '@standardnotes/domain-events-infra'
import { Service as AuthService, AuthServiceInterface } from '@standardnotes/auth-server'
import { Service as SyncingService } from '@standardnotes/syncing-server'
import { Service as RevisionsService } from '@standardnotes/revisions-server'
import { Container } from 'inversify'
import { InversifyExpressServer } from 'inversify-express-utils'
import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import * as http from 'http'
import { text, json, Request, Response, NextFunction, raw } from 'express'
import * as winston from 'winston'
import { PassThrough } from 'stream'
import { Env } from '../Bootstrap/Env'
import { HomeServerInterface } from './HomeServerInterface'
import { HomeServerConfiguration } from './HomeServerConfiguration'
import { WebSocketRedisBridge } from './WebSocketRedisBridge'

export class HomeServer implements HomeServerInterface {
  private serverInstance: http.Server | undefined
  private authService: AuthServiceInterface | undefined
  private logStream: PassThrough | undefined
  private readonly loggerNames = [
    'auth-server',
    'syncing-server',
    'revisions-server',
    'files-server',
    'api-gateway',
    'home-server',
  ]

  async start(configuration: HomeServerConfiguration): Promise<Result<string>> {
    try {
      const controllerContainer = new ControllerContainer()
      const serviceContainer = new ServiceContainer()
      const directCallDomainEventPublisher = new DirectCallDomainEventPublisher()

      const environmentOverrides = {
        DB_TYPE: 'sqlite',
        CACHE_TYPE: 'memory',
        DB_SQLITE_DATABASE_PATH: `${configuration.dataDirectoryPath}/database/home_server.sqlite`,
        FILE_UPLOAD_PATH: `${configuration.dataDirectoryPath}/uploads`,
        // Standard Red Notes: default the CalDAV JSON stores under the data dir so
        // published reminders + scoped tokens persist with the rest of the
        // instance. The feature stays OFF until CALDAV_ENABLED=true.
        CALDAV_DATA_PATH: `${configuration.dataDirectoryPath}/caldav`,
        // Standard Red Notes: default the reminder-delivery JSON stores (published
        // reminders + per-user delivery config) under the data dir so they persist
        // with the rest of the instance. The feature stays OFF until
        // REMINDER_DELIVERY_ENABLED=true.
        REMINDER_DELIVERY_DATA_PATH: `${configuration.dataDirectoryPath}/reminder-delivery`,
        ...configuration.environment,
        MODE: 'home-server',
      }

      const env: Env = new Env(environmentOverrides)
      env.load()

      const requestPayloadLimit = env.get('HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES', true)
        ? `${+env.get('HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES', true)}mb`
        : '50mb'

      this.configureLoggers(env, configuration)

      // Bridge in-process WEB_SOCKET_MESSAGE_REQUESTED events onto Redis pub/sub
      // so the self-hosted WebSocket gateway can push them to live clients.
      directCallDomainEventPublisher.register(
        new WebSocketRedisBridge(
          winston.loggers.get('home-server'),
          env.get('REDIS_HOST', true) || undefined,
          env.get('REDIS_PORT', true) ? +env.get('REDIS_PORT', true) : 6379,
        ),
      )

      const apiGatewayService = new ApiGatewayService(serviceContainer)
      const authService = new AuthService(serviceContainer, controllerContainer, directCallDomainEventPublisher)
      this.authService = authService
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
            logger: { warn: (message: string) => winston.loggers.get('home-server').warn(message) },
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

        /* eslint-disable */
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
        /* eslint-enable */
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

        // Standard Red Notes: mount the read-only CalDAV router and the
        // authenticated Workflows-UI proxy INSIDE setConfig — i.e. BEFORE
        // server.build(). build() mounts the inversify controller router at '/'. The
        // trailing unmatched handler is now a POST-BUILD app.use() fallback (see after
        // build(), replacing the former inert @controller('') FallbackController
        // catch-all), so these routes are no longer at risk of being shadowed — but
        // keeping them pre-build (ahead of the controller router) remains the correct,
        // defensive placement. Registering here also keeps them after all the middleware
        // above (like the e2e route just above). Each router gates itself internally
        // (CalDAV 404s when CALDAV_ENABLED is off; Workflows 404s when
        // WORKFLOWS_ENABLED is off and 403s without the UI-access cookie + an active
        // pairing), so mounting them unconditionally is safe.
        const routingLogger = winston.loggers.get('home-server')
        try {
          registerCaldavRoutes(app, container)
          routingLogger.info('CalDAV router mounted')
        } catch (error) {
          routingLogger.error(`Failed to mount CalDAV router: ${(error as Error).message}`)
        }

        try {
          registerWorkflowsUiProxy(app, container)
          routingLogger.info('Workflows editor proxy mounted')
        } catch (error) {
          routingLogger.error(`Failed to mount workflows editor proxy: ${(error as Error).message}`)
        }
      })

      const logger: winston.Logger = winston.loggers.get('home-server')

      server.setErrorConfig((app) => {
        app.use((error: Record<string, unknown>, request: Request, response: Response, _next: NextFunction) => {
          logger.error(`${error.stack}`, {
            method: request.method,
            url: request.url,
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

      // Standard Red Notes: build() mounts the inversify controller router at '/'. The
      // CalDAV router and the Workflows-UI proxy are registered INSIDE setConfig above
      // (before this call), ahead of the controller router — see the note there.
      const app = await server.build()

      // Standard Red Notes: cosmetic welcome page (GET /) + JSON 404 fallback for the
      // bundled home-server. This replaces the former @controller('') FallbackController
      // catch-all, which declared an empty base that mergePaths turned into a
      // never-matching '//{*splat}' under Express 5 — so it was INERT and unmatched
      // requests fell through to Express's default `Cannot GET /path` HTML. Registered
      // as a POST-BUILD app.use() so it runs strictly AFTER the controller router of
      // ALL five bundled services (and the setErrorConfig 500-handler): it catches only
      // genuinely-unmatched requests and cannot shadow any bundled controller or the
      // pre-build CalDAV/Workflows routes. A live in-router catch-all here would front
      // every bundled service (FallbackController registered first), which is exactly
      // why this is a post-build handler and not a repaired controller.
      app.use(createFallbackHandler({ welcomeHtml: HOME_SERVER_WELCOME_HTML }))

      // Standard Red Notes: start the reminder-delivery scheduler. It gates itself
      // on the REMINDER_DELIVERY_ENABLED master switch (start() no-ops when off) and
      // only ever delivers reminders the user explicitly published to a configured,
      // enabled channel.
      try {
        if (startReminderDeliveryScheduler(container)) {
          logger.info('Reminder delivery scheduler started')
        }
      } catch (error) {
        logger.error(`Failed to start reminder delivery scheduler: ${(error as Error).message}`)
      }

      const serverInstance = app.listen(port)

      const keepAliveTimeout = env.get('HTTP_KEEP_ALIVE_TIMEOUT', true)
        ? +env.get('HTTP_KEEP_ALIVE_TIMEOUT', true)
        : 5000

      serverInstance.keepAliveTimeout = keepAliveTimeout

      this.serverInstance = serverInstance

      process.on('SIGTERM', () => {
        logger.info('SIGTERM signal received: closing HTTP server')
        serverInstance.close(() => {
          logger.info('HTTP server closed')
        })
      })

      logger.info(`Server started on port ${port}. Log level: ${env.get('LOG_LEVEL', true)}.`)

      return Result.ok('Server started.')
    } catch (error) {
      console.error((error as Error).stack)

      return Result.fail((error as Error).message)
    }
  }

  async stop(): Promise<Result<string>> {
    try {
      if (!this.serverInstance) {
        return Result.fail('Home server is not running.')
      }

      for (const loggerName of this.loggerNames) {
        winston.loggers.close(loggerName)
      }

      if (this.logStream) {
        this.logStream.end()
      }

      this.serverInstance.close()
      this.serverInstance.unref()

      this.serverInstance = undefined

      return Result.ok('Server stopped.')
    } catch (error) {
      return Result.fail((error as Error).message)
    }
  }

  async isRunning(): Promise<boolean> {
    if (!this.serverInstance) {
      return false
    }

    return this.serverInstance.address() !== null
  }

  async activatePremiumFeatures(dto: {
    username: string
    subscriptionId: number
    subscriptionPlanName?: string
    uploadBytesLimit?: number
    endsAt?: Date
    cancelPreviousSubscription?: boolean
  }): Promise<Result<string>> {
    if (!this.isRunning() || !this.authService) {
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
  }
}
