import { safeErrorLogMetadata } from '@standardnotes/domain-core'
import 'reflect-metadata'

import { Logger } from 'winston'

import { ContainerConfigLoader } from '../src/Bootstrap/Container'
import TYPES from '../src/Bootstrap/Types'
import { Env } from '../src/Bootstrap/Env'
import { DomainEventSubscriberInterface } from '@standardnotes/domain-events'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'

// Standard Red Notes: fail-fast global crash handlers (see bin/server.ts). Log a
// clear FATAL line with stack and exit non-zero so the supervisor restarts us
// instead of the worker silently wedging.
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

const container = new ContainerConfigLoader('worker')
void container
  .load()
  .then((container) => {
    dayjs.extend(utc)

    const env: Env = new Env()
    env.load()

    const logger: Logger = container.get(TYPES.Files_Logger)
    fatalLogger = logger

    logger.info('Starting worker...')

    const subscriber = container.get<DomainEventSubscriberInterface>(TYPES.Files_DomainEventSubscriber)

    process.on('SIGTERM', () => {
      logger.info('SIGTERM received. Stopping worker...')
      subscriber.stop()
      logger.info('Worker stopped.')
    })

    subscriber.start()
  })
  .catch((error: unknown) => {
    logFatal('startup', error)
    process.exit(1)
  })
