import 'reflect-metadata'

import '../src/Infra/InversifyExpressUtils/AnnotatedAuthController'
import '../src/Infra/InversifyExpressUtils/AnnotatedAuthenticatorsController'
import '../src/Infra/InversifyExpressUtils/AnnotatedAppPasswordsController'
import '../src/Infra/InversifyExpressUtils/AnnotatedMcpTokensController'
import '../src/Infra/InversifyExpressUtils/AnnotatedSharesController'
import '../src/Infra/InversifyExpressUtils/AnnotatedDeadManSwitchesController'
import '../src/Infra/InversifyExpressUtils/AnnotatedEmailRemindersController'
import '../src/Infra/InversifyExpressUtils/AnnotatedTrustedDevicesController'
import '../src/Infra/InversifyExpressUtils/AnnotatedPendingMfaApprovalsController'
import '../src/Infra/InversifyExpressUtils/AnnotatedMagicLinkController'
import '../src/Infra/InversifyExpressUtils/AnnotatedSessionsController'
import '../src/Infra/InversifyExpressUtils/AnnotatedSubscriptionInvitesController'
import '../src/Infra/InversifyExpressUtils/AnnotatedUserRequestsController'
import '../src/Infra/InversifyExpressUtils/AnnotatedWebSocketsController'
import '../src/Infra/InversifyExpressUtils/AnnotatedUsersController'
import '../src/Infra/InversifyExpressUtils/AnnotatedValetTokenController'
import '../src/Infra/InversifyExpressUtils/AnnotatedAdminController'
import '../src/Infra/InversifyExpressUtils/AnnotatedSubscriptionTokensController'
import '../src/Infra/InversifyExpressUtils/AnnotatedSubscriptionSettingsController'
import '../src/Infra/InversifyExpressUtils/AnnotatedSettingsController'
import '../src/Infra/InversifyExpressUtils/AnnotatedSessionController'
import '../src/Infra/InversifyExpressUtils/AnnotatedOfflineController'
import '../src/Infra/InversifyExpressUtils/AnnotatedInternalController'
import '../src/Infra/InversifyExpressUtils/AnnotatedHealthCheckController'
import '../src/Infra/InversifyExpressUtils/AnnotatedFeaturesController'

import cors from 'cors'
import cookieParser from 'cookie-parser'
import * as grpc from '@grpc/grpc-js'
import { urlencoded, json, Request, Response, NextFunction } from 'express'
import * as winston from 'winston'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

import { InversifyExpressServer } from 'inversify-express-utils'
import { ContainerConfigLoader } from '../src/Bootstrap/Container'
import TYPES from '../src/Bootstrap/Types'
import { Env } from '../src/Bootstrap/Env'
import { AuthServer } from '../src/Infra/gRPC/AuthServer'
import { AuthService } from '@standardnotes/grpc'
import { AuthenticateRequest } from '../src/Domain/UseCase/AuthenticateRequest'
import { CreateCrossServiceToken } from '../src/Domain/UseCase/CreateCrossServiceToken/CreateCrossServiceToken'
import { TokenDecoderInterface, WebSocketConnectionTokenData } from '@standardnotes/security'
import { ResponseLocals } from '../src/Infra/InversifyExpressUtils/ResponseLocals'
import { HeapProfiler } from '../src/Domain/Profiler/HeapProfiler'
import { TriggerDueDeadManSwitches } from '../src/Domain/UseCase/TriggerDueDeadManSwitches/TriggerDueDeadManSwitches'
import { TriggerDueEmailReminders } from '../src/Domain/UseCase/TriggerDueEmailReminders/TriggerDueEmailReminders'

const DEAD_MAN_SWITCH_SCAN_INTERVAL_MS = 5 * 60 * 1000
const EMAIL_REMINDER_SCAN_INTERVAL_MS = 60 * 1000

const container = new ContainerConfigLoader()
void container.load().then(async (container) => {
  dayjs.extend(utc)

  const env: Env = new Env()
  env.load()

  const server = new InversifyExpressServer(container)

  server.setConfig((app) => {
    app.use((_request: Request, response: Response, next: NextFunction) => {
      response.setHeader('X-Auth-Version', container.get(TYPES.Auth_VERSION))
      next()
    })
    app.use(json())
    app.use(urlencoded({ extended: true }))
    app.use(cookieParser() as never)
    app.use(cors() as never)
  })

  const logger: winston.Logger = container.get(TYPES.Auth_Logger)

  server.setErrorConfig((app) => {
    app.use((error: Record<string, unknown>, request: Request, response: Response, _next: NextFunction) => {
      const locals = response.locals as ResponseLocals
      logger.error(`${error.stack}`, {
        method: request.method,
        url: request.url,
        snjs: request.headers['x-snjs-version'],
        application: request.headers['x-application-version'],
        userId: locals.user ? locals.user.uuid : undefined,
      })

      response.status(500).send({
        error: {
          message:
            "Unfortunately, we couldn't handle your request. Please try again or contact our support if the error persists.",
        },
      })
    })
  })

  const serverInstance = server.build().listen(env.get('PORT'))

  const httpKeepAliveTimeout = env.get('HTTP_KEEP_ALIVE_TIMEOUT', true)
    ? +env.get('HTTP_KEEP_ALIVE_TIMEOUT', true)
    : 10_000

  serverInstance.keepAliveTimeout = httpKeepAliveTimeout

  const grpcKeepAliveTime = env.get('GRPC_KEEP_ALIVE_TIME', true) ? +env.get('GRPC_KEEP_ALIVE_TIME', true) : 7_200_000

  const grpcKeepAliveTimeout = env.get('GRPC_KEEP_ALIVE_TIMEOUT', true)
    ? +env.get('GRPC_KEEP_ALIVE_TIMEOUT', true)
    : 20_000

  const grpcMaxMessageSize = env.get('GRPC_MAX_MESSAGE_SIZE', true)
    ? +env.get('GRPC_MAX_MESSAGE_SIZE', true)
    : 1024 * 1024 * 50

  const grpcServer = new grpc.Server({
    'grpc.keepalive_time_ms': grpcKeepAliveTime,
    'grpc.keepalive_timeout_ms': grpcKeepAliveTimeout,
    'grpc.default_compression_algorithm': grpc.compressionAlgorithms.gzip,
    'grpc.max_receive_message_length': grpcMaxMessageSize,
    'grpc.max_send_message_length': grpcMaxMessageSize,
  })

  const gRPCPort = env.get('GRPC_PORT', true) ? +env.get('GRPC_PORT', true) : 50051

  const authServer = new AuthServer(
    container.get<AuthenticateRequest>(TYPES.Auth_AuthenticateRequest),
    container.get<CreateCrossServiceToken>(TYPES.Auth_CreateCrossServiceToken),
    container.get<TokenDecoderInterface<WebSocketConnectionTokenData>>(TYPES.Auth_WebSocketConnectionTokenDecoder),
    container.get<winston.Logger>(TYPES.Auth_Logger),
  )

  grpcServer.addService(AuthService, {
    validate: authServer.validate.bind(authServer),
    validateWebsocket: authServer.validateWebsocket.bind(authServer),
  })
  grpcServer.bindAsync(`0.0.0.0:${gRPCPort}`, grpc.ServerCredentials.createInsecure(), (error, port) => {
    if (error) {
      logger.error(`Failed to bind gRPC server: ${error.message}`)

      return
    }

    logger.info(`gRPC server bound on port ${port}`)

    grpcServer.start()

    logger.info('gRPC server started')
  })

  if (env.get('PROFILER_ENABLED', true) === 'true') {
    try {
      const heapProfiler = container.get<HeapProfiler>(TYPES.Auth_HeapProfiler)
      heapProfiler.start()
      logger.info('Heap profiler started successfully')
    } catch (error) {
      logger.error(`Failed to start heap profiler: ${(error as Error).message}`)
    }
  }

  // Dead man's switch scanner. Runs in-process on the auth server (which has DB
  // and SMTP access). Every interval it triggers any switch whose deadline has
  // elapsed without a check-in, emailing the recipient the share link. The
  // `isRunning` guard prevents overlapping scans; `unref()` keeps the timer from
  // holding the process open during shutdown.
  const triggerDueDeadManSwitches = container.get<TriggerDueDeadManSwitches>(TYPES.Auth_TriggerDueDeadManSwitches)
  let deadManSwitchScanRunning = false
  const scanDeadManSwitches = async (): Promise<void> => {
    if (deadManSwitchScanRunning) {
      return
    }
    deadManSwitchScanRunning = true
    try {
      const result = await triggerDueDeadManSwitches.execute({})
      if (!result.isFailed()) {
        const triggered = result.getValue()
        if (triggered > 0) {
          logger.info(`Dead man switch scan triggered ${triggered} switch(es).`)
        }
      } else {
        logger.error(`Dead man switch scan failed: ${result.getError()}`)
      }
    } catch (error) {
      logger.error(`Dead man switch scan threw: ${(error as Error).message}`)
    } finally {
      deadManSwitchScanRunning = false
    }
  }
  const deadManSwitchInterval = setInterval(() => {
    void scanDeadManSwitches()
  }, DEAD_MAN_SWITCH_SCAN_INTERVAL_MS)
  deadManSwitchInterval.unref()

  // Email reminder scanner. Runs in-process on the auth server (DB + SMTP access).
  // Every interval it emails any due, unsent email reminder whose user has opted in,
  // then marks it sent (or, in EMAIL_REMINDER_NO_RECORDS mode, deletes the record).
  // Gated internally on EMAIL_REMINDERS_ENABLED + SMTP configured + per-user opt-in,
  // so a fresh install scans cheaply and sends nothing. Same isRunning/unref guards.
  const triggerDueEmailReminders = container.get<TriggerDueEmailReminders>(TYPES.Auth_TriggerDueEmailReminders)
  let emailReminderScanRunning = false
  const scanEmailReminders = async (): Promise<void> => {
    if (emailReminderScanRunning) {
      return
    }
    emailReminderScanRunning = true
    try {
      const result = await triggerDueEmailReminders.execute({})
      if (!result.isFailed()) {
        const sent = result.getValue()
        if (sent > 0) {
          logger.info(`Email reminder scan sent ${sent} reminder(s).`)
        }
      } else {
        logger.error(`Email reminder scan failed: ${result.getError()}`)
      }
    } catch (error) {
      logger.error(`Email reminder scan threw: ${(error as Error).message}`)
    } finally {
      emailReminderScanRunning = false
    }
  }
  const emailReminderInterval = setInterval(() => {
    void scanEmailReminders()
  }, EMAIL_REMINDER_SCAN_INTERVAL_MS)
  emailReminderInterval.unref()

  process.on('SIGTERM', () => {
    logger.info('SIGTERM signal received: closing HTTP server')
    clearInterval(deadManSwitchInterval)

    if (env.get('PROFILER_ENABLED', true) === 'true') {
      try {
        const heapProfiler = container.get<HeapProfiler>(TYPES.Auth_HeapProfiler)
        heapProfiler.stop()
        logger.info('Heap profiler stopped')
      } catch (error) {
        logger.error(`Failed to stop heap profiler: ${(error as Error).message}`)
      }
    }

    serverInstance.close(() => {
      logger.info('HTTP server closed')
    })
    grpcServer.tryShutdown((error?: Error) => {
      if (error) {
        logger.error(`Failed to shutdown gRPC server: ${error.message}`)
      } else {
        logger.info('gRPC server closed')
      }
    })
  })

  logger.info(`Server started on port ${process.env.PORT}`)
})
