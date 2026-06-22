import 'reflect-metadata'

import '../src/Controller/LegacyController'
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
import '../src/Controller/v1/McpTokensController'
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
import '../src/Controller/v1/IntegrationsController'

import '../src/Controller/v2/PaymentsControllerV2'
import '../src/Controller/v2/ActionsControllerV2'
import '../src/Controller/v2/RevisionsControllerV2'

import helmet from 'helmet'
import cors from 'cors'
import cookieParser from 'cookie-parser'
import { text, json, Request, Response, NextFunction } from 'express'
import * as winston from 'winston'

import { InversifyExpressServer } from 'inversify-express-utils'
import { ContainerConfigLoader } from '../src/Bootstrap/Container'
import { TYPES } from '../src/Bootstrap/Types'
import { Env } from '../src/Bootstrap/Env'
import { ResponseLocals } from '../src/Controller/ResponseLocals'
import {
  createSharedServerAccessKeyMiddleware,
  resolveSharedServerAccessKeyConfig,
} from '../src/Controller/SharedServerAccessKeyMiddleware'
import { configureTrustProxy } from '../src/Controller/TrustProxy'
import { attachWebSocketGateway } from '@standard-red-notes/websocket-gateway'

const container = new ContainerConfigLoader()
void container.load().then((container) => {
  const env: Env = new Env()
  env.load()

  const requestPayloadLimit = env.get('HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES', true)
    ? `${+env.get('HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES', true)}mb`
    : '50mb'

  const logger: winston.Logger = container.get(TYPES.ApiGateway_Logger)

  const server = new InversifyExpressServer(container)

  server.setConfig((app) => {
    // Standard Red Notes: honor X-Forwarded-Proto / X-Forwarded-For when the
    // stack runs behind a TLS-terminating reverse proxy, so req.secure,
    // req.protocol and req.ip reflect the real client. Configurable via
    // TRUST_PROXY (see TrustProxy.ts). Default trusts only loopback/private
    // (Docker) networks, so direct access still works and a remote client
    // cannot spoof the forwarded headers.
    configureTrustProxy(app, env.get('TRUST_PROXY', true))

    app.use((request: Request, _response: Response, next: NextFunction) => {
      if (request.hostname.includes('standardnotes.org')) {
        logger.debug('Request is using deprecated domain', {
          origin: request.headers.origin,
          method: request.method,
          url: request.url,
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
    app.use(
      cors({
        credentials: true,
        exposedHeaders: ['x-captcha-required'],
        origin: (requestOrigin: string | undefined, callback: (err: Error | null, origin?: string[]) => void) => {
          const originStrictModeEnabled = env.get('CORS_ORIGIN_STRICT_MODE_ENABLED', true)
            ? env.get('CORS_ORIGIN_STRICT_MODE_ENABLED', true) === 'true'
            : false

          if (!originStrictModeEnabled) {
            callback(null, [requestOrigin as string])

            return
          }

          const requstOriginIsNotFilled = !requestOrigin || requestOrigin === 'null'
          const requestOriginatesFromTheDesktopApp = requestOrigin?.startsWith('file://')
          const requestOriginatesFromClipperForFirefox = requestOrigin?.startsWith('moz-extension://')
          const requestOriginatesFromSelfHostedAppOnHttpPort = requestOrigin === 'http://localhost'
          const requestOriginatesFromSelfHostedAppOnCustomPort = requestOrigin?.match(/http:\/\/localhost:\d+/) !== null
          const requestOriginatesFromSelfHostedApp =
            requestOriginatesFromSelfHostedAppOnHttpPort || requestOriginatesFromSelfHostedAppOnCustomPort

          const requestIsWhitelisted =
            corsAllowedOrigins.length === 0 ||
            requstOriginIsNotFilled ||
            requestOriginatesFromTheDesktopApp ||
            requestOriginatesFromClipperForFirefox ||
            requestOriginatesFromSelfHostedApp

          if (requestIsWhitelisted) {
            callback(null, [requestOrigin as string])
          } else {
            if (corsAllowedOrigins.includes(requestOrigin)) {
              callback(null, [requestOrigin])
            } else {
              callback(new Error('Not allowed by CORS', { cause: 'origin not allowed' }))
            }
          }
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
  })

  server.setErrorConfig((app) => {
    app.use((error: Record<string, unknown>, request: Request, response: Response, _next: NextFunction) => {
      const locals = response.locals as ResponseLocals

      logger.error(`${error.stack}`, {
        origin: request.headers.origin,
        codeTag: 'server.ts',
        method: request.method,
        url: request.url,
        snjs: request.headers['x-snjs-version'],
        application: request.headers['x-application-version'],
        userId: locals.user ? locals.user.uuid : undefined,
      })
      logger.debug(
        `[URL: |${request.method}| ${request.url}][SNJS: ${request.headers['x-snjs-version']}][Application: ${
          request.headers['x-application-version']
        }] Request body: ${JSON.stringify(request.body)}`,
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
  // `.listen()` to get the Node http.Server the ws upgrade attaches to.
  const app = server.build()
  const serverInstance = app.listen(env.get('PORT'))

  const keepAliveTimeout = env.get('HTTP_KEEP_ALIVE_TIMEOUT', true) ? +env.get('HTTP_KEEP_ALIVE_TIMEOUT', true) : 5000

  serverInstance.keepAliveTimeout = keepAliveTimeout

  // Standard Red Notes: run the realtime WebSocket gateway IN-PROCESS on the same
  // http server / port (3000) instead of a separate listener (formerly :3106).
  // It binds the ws upgrade to `serverInstance`, registers `POST /sockets/tokens`
  // on the Express app, and starts the Redis bridge + (optional) SQS consumer.
  // Adapt the winston logger to the gateway's minimal Logger interface
  // (variadic info/warn/error returning void). winston's leveled methods accept
  // a message + meta, so join the args into one message string.
  const gatewayLogger = {
    info: (...args: unknown[]) => logger.info(args.map(String).join(' ')),
    warn: (...args: unknown[]) => logger.warn(args.map(String).join(' ')),
    error: (...args: unknown[]) => logger.error(args.map(String).join(' ')),
  }

  let stopWebSocketGateway: (() => Promise<void>) | undefined
  if (env.get('WEB_SOCKET_CONNECTION_TOKEN_SECRET', true)) {
    try {
      const gateway = attachWebSocketGateway({
        httpServer: serverInstance,
        app,
        logger: gatewayLogger,
        config: {
          connectionTokenSecret: env.get('WEB_SOCKET_CONNECTION_TOKEN_SECRET', true),
          connectionTokenTtl: env.get('WEB_SOCKET_CONNECTION_TOKEN_TTL', true) || '60s',
          internalSecret: env.get('WEBSOCKET_GATEWAY_INTERNAL_SECRET', true) || '',
          authJwtSecret: env.get('AUTH_JWT_SECRET', true) || '',
          redisHost: env.get('REDIS_HOST', true) || '127.0.0.1',
          redisPort: env.get('REDIS_PORT', true) ? +env.get('REDIS_PORT', true) : 6379,
          sqs: {
            queueUrl: env.get('SQS_QUEUE_URL', true) || undefined,
            endpoint: env.get('SQS_ENDPOINT', true) || undefined,
            region: env.get('SQS_AWS_REGION', true) || undefined,
            accessKeyId: env.get('SQS_ACCESS_KEY_ID', true) || undefined,
            secretAccessKey: env.get('SQS_SECRET_ACCESS_KEY', true) || undefined,
          },
        },
      })
      stopWebSocketGateway = gateway.stop
      logger.info('Realtime WebSocket gateway attached in-process on the api-gateway http server')
    } catch (error) {
      logger.error(`Failed to attach the realtime WebSocket gateway: ${(error as Error).message}`)
    }
  } else {
    logger.info(
      'WEB_SOCKET_CONNECTION_TOKEN_SECRET not set; realtime WebSocket gateway not attached (token minting disabled)',
    )
  }

  process.on('SIGTERM', () => {
    logger.info('SIGTERM signal received: closing HTTP server')
    void Promise.resolve(stopWebSocketGateway?.()).finally(() => {
      serverInstance.close(() => {
        logger.info('HTTP server closed')
      })
    })
  })

  logger.info(`Server started on port ${process.env.PORT}`)
})
