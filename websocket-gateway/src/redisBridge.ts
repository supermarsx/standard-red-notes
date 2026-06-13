import { Redis } from 'ioredis'
import { ConnectionRegistry, dispatch, parseDispatchMessage, type SendableSocket } from './registry.js'

/** Redis pub/sub channel carrying push messages, per the SN contract. */
export const WEBSOCKET_MESSAGES_CHANNEL = 'websocket-messages'

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/**
 * Subscribes to the Redis `websocket-messages` channel and dispatches each
 * received message to the in-memory registry. Returns the ioredis client so
 * the caller can close it on shutdown.
 */
export function startRedisBridge<S extends SendableSocket>(
  registry: ConnectionRegistry<S>,
  opts: { host: string; port: number; logger: Logger },
): Redis {
  const client = new Redis({
    host: opts.host,
    port: opts.port,
    // Keep the process alive but don't crash on transient Redis outages.
    lazyConnect: false,
    maxRetriesPerRequest: null,
  })

  client.on('error', (err) => {
    opts.logger.error('[redis] connection error', err instanceof Error ? err.message : err)
  })

  client.on('ready', () => {
    opts.logger.info(`[redis] connected ${opts.host}:${opts.port}`)
  })

  client.subscribe(WEBSOCKET_MESSAGES_CHANNEL, (err, count) => {
    if (err) {
      opts.logger.error('[redis] subscribe failed', err.message)
      return
    }
    opts.logger.info(`[redis] subscribed to ${WEBSOCKET_MESSAGES_CHANNEL} (${count} channels)`)
  })

  client.on('message', (channel, raw) => {
    if (channel !== WEBSOCKET_MESSAGES_CHANNEL) return
    handleRawMessage(registry, raw, opts.logger)
  })

  return client
}

/**
 * Parse a raw channel payload and dispatch it. Exposed (and side-effect
 * isolated to the registry + logger) so it can be exercised in tests without
 * a real Redis connection.
 */
export function handleRawMessage<S extends SendableSocket>(
  registry: ConnectionRegistry<S>,
  raw: string,
  logger: Logger,
): number {
  let parsed
  try {
    parsed = parseDispatchMessage(raw)
  } catch (err) {
    logger.warn('[redis] dropping malformed message', err instanceof Error ? err.message : err)
    return 0
  }

  const sent = dispatch(registry, parsed)
  logger.info(
    `[push] user=${parsed.userUuid} sockets=${sent}` +
      (parsed.originatingSessionUuid ? ` excludeSession=${parsed.originatingSessionUuid}` : ''),
  )
  return sent
}
