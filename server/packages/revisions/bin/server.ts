import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import 'reflect-metadata'

import cors from 'cors'
import { urlencoded, json, Request, Response, NextFunction } from 'express'
import * as winston from 'winston'

import { InversifyExpressServer } from 'inversify-express-utils'
import TYPES from '../src/Bootstrap/Types'
import { Env } from '../src/Bootstrap/Env'
import { ContainerConfigLoader } from '../src/Bootstrap/Container'

import '../src/Infra/InversifyExpress/AnnotatedRevisionsController'
import '../src/Infra/InversifyExpress/AnnotatedHealthCheckController'

const container = new ContainerConfigLoader()
void container.load().then(async (container) => {
  const env: Env = container.get(TYPES.Revisions_Env)

  // Standard Red Notes: honour the operator's configured body limit, as every
  // other service does. `json()` with no `limit` is body-parser's own 100 KB
  // default, so HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES read as enforced here and was
  // not. Inert in practice today — this service exposes no POST/PUT/PATCH route at
  // all (revisions are written by the worker from domain events, not over HTTP) —
  // and that is exactly why it is worth setting rather than leaving: the first
  // write route added here would otherwise inherit a 100 KB ceiling nobody chose,
  // on a service whose payloads are whole note snapshots.
  const requestPayloadLimit = env.get('HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES', true)
    ? `${+env.get('HTTP_REQUEST_PAYLOAD_LIMIT_MEGABYTES', true)}mb`
    : '50mb'

  const server = new InversifyExpressServer(container)

  server.setConfig((app) => {
    app.use((_request: Request, response: Response, next: NextFunction) => {
      response.setHeader('X-Revisions-Version', container.get(TYPES.Revisions_VERSION))
      next()
    })
    app.use(json({ limit: requestPayloadLimit }))
    app.use(urlencoded({ extended: true, limit: requestPayloadLimit }))
    app.use(cors())
  })

  const logger: winston.Logger = container.get(TYPES.Revisions_Logger)

  server.setErrorConfig((app) => {
    app.use((error: Record<string, unknown>, _request: Request, response: Response, _next: NextFunction) => {
      logger.error('Unhandled revisions request failed.', safeErrorLogMetadata(error))

      response.status(500).send({
        error: {
          message:
            "Unfortunately, we couldn't handle your request. Please try again or contact our support if the error persists.",
        },
      })
    })
  })

  const app = await server.build()
  const serverInstance = app.listen(env.get('PORT'))

  const keepAliveTimeout = env.get('HTTP_KEEP_ALIVE_TIMEOUT', true) ? +env.get('HTTP_KEEP_ALIVE_TIMEOUT', true) : 5000

  serverInstance.keepAliveTimeout = keepAliveTimeout

  process.on('SIGTERM', () => {
    logger.info('SIGTERM signal received: closing HTTP server')
    serverInstance.close(() => {
      logger.info('HTTP server closed')
    })
  })

  logger.info(`Server started on port ${process.env.PORT}`)
})
