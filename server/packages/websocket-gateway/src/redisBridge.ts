import { Redis } from 'ioredis'
import { ConnectionRegistry, dispatch, parseDispatchMessage, type SendableSocket } from './registry.js'
import { safeErrorLogMetadata } from './safeLog.js'

/** Redis pub/sub channel carrying push messages, per the SN contract. */
export const WEBSOCKET_MESSAGES_CHANNEL = 'websocket-messages'

/**
 * Per-deployment Redis namespace (`WEBSOCKET_REDIS_NAMESPACE`, contract C10).
 * Empty keeps today's unprefixed names so a rolling upgrade keeps replicas
 * talking; a non-empty value must match this pattern and is applied as
 * `<namespace>:<original>` to every shared channel and key.
 */
export const REDIS_NAMESPACE_PATTERN = /^[a-z0-9:_-]{1,64}$/u

/**
 * Prefix a shared Redis name with the deployment namespace. The separator is
 * added here, so callers pass the raw env value (`prod`, not `prod:`); a value
 * that already carries a leading or trailing colon is rejected rather than
 * silently producing `prod::websocket-messages` on one side of the bridge.
 */
export function applyRedisNamespace(namespace: string | undefined, original: string): string {
  if (namespace === undefined || namespace === '') {
    return original
  }
  if (!REDIS_NAMESPACE_PATTERN.test(namespace) || namespace.startsWith(':') || namespace.endsWith(':')) {
    throw new Error('WEBSOCKET_REDIS_NAMESPACE must match ^[a-z0-9:_-]{1,64}$ with no leading or trailing colon.')
  }
  return `${namespace}:${original}`
}

/** The push channel for a namespace: `websocket-messages` or `<ns>:websocket-messages`. */
export function namespacedPushChannel(namespace?: string): string {
  return applyRedisNamespace(namespace, WEBSOCKET_MESSAGES_CHANNEL)
}

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  /**
   * Optional so the existing host adapters (api-gateway, home-server) that only
   * bridge info/warn/error keep satisfying this interface. Callers must treat it
   * as possibly absent; `createConsoleLogger` always provides it.
   */
  debug?(...args: unknown[]): void
}

/** Invoked after every push dispatched from the bridge with the number of sockets it reached. */
export type PushDispatchedHook = (socketCount: number) => void

export interface RedisBridgeOptions {
  host: string
  port: number
  logger: Logger
  /**
   * Raw `WEBSOCKET_REDIS_NAMESPACE` value (C10). When non-empty the bridge
   * subscribes to `<channelPrefix>:websocket-messages` (see `namespacedPushChannel`)
   * so the home-server publisher and the gateway agree on the channel name.
   */
  channelPrefix?: string
  /** Feeds `AttachedGateway.health().pushesDispatched` (C9). */
  onDispatched?: PushDispatchedHook
}

/**
 * Subscribes to the Redis `websocket-messages` channel (namespaced per C10) and
 * dispatches each received message to the in-memory registry. Returns the
 * ioredis client so the caller can close it on shutdown.
 */
export function startRedisBridge<S extends SendableSocket>(
  registry: ConnectionRegistry<S>,
  opts: RedisBridgeOptions,
): Redis {
  const channel = namespacedPushChannel(opts.channelPrefix)
  const client = new Redis({
    host: opts.host,
    port: opts.port,
    // Keep the process alive but don't crash on transient Redis outages.
    lazyConnect: false,
    maxRetriesPerRequest: null,
    // Standard Red Notes: bounded exponential reconnection backoff (cap 5s) so a
    // brief Redis blip self-heals instead of reconnecting in a tight loop.
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
  })

  client.on('error', (err) => {
    opts.logger.error('[redis] connection error', safeErrorLogMetadata(err))
  })

  client.on('ready', () => {
    opts.logger.info(`[redis] connected ${opts.host}:${opts.port}`)
  })

  client.subscribe(channel, (err, count) => {
    if (err) {
      opts.logger.error('[redis] subscribe failed', safeErrorLogMetadata(err))
      return
    }
    opts.logger.info(`[redis] subscribed to ${channel} (${count} channels)`)
  })

  client.on('message', (receivedChannel, raw) => {
    if (receivedChannel !== channel) {
      return
    }
    handleRawMessage(registry, raw, opts.logger, opts.onDispatched)
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
  onDispatched?: PushDispatchedHook,
): number {
  let parsed
  try {
    parsed = parseDispatchMessage(raw)
  } catch (err) {
    logger.warn('[redis] dropping malformed message', safeErrorLogMetadata(err))
    return 0
  }

  const sent = dispatch(registry, parsed)
  onDispatched?.(sent)
  logger.info('[push] dispatched websocket message', {
    userId: parsed.userUuid,
    socketCount: sent,
    originExcluded: parsed.originatingSessionUuid !== undefined,
  })
  return sent
}
