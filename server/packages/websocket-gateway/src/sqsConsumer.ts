import { createHash, randomUUID } from 'node:crypto'
import * as zlib from 'node:zlib'
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs'
import { ConnectionRegistry, dispatch, type DispatchMessage, type SendableSocket } from './registry.js'
import { applyRedisNamespace, type Logger, type PushDispatchedHook } from './redisBridge.js'
import { safeErrorLogMetadata } from './safeLog.js'
import type { InviteRealtimeDomainEventEnvelope } from './inviteEventDomainEventHandler.js'
import { INVITE_REALTIME_DOMAIN_EVENT_TYPE } from './inviteEventDomainEventBridge.js'

const DEFAULT_DEDUP_RETENTION_MS = 24 * 60 * 60 * 1_000
const DEFAULT_DEDUP_LEASE_MS = 30_000
const COMPLETED_VALUE = 'completed'

/** Redis key prefix of the durable-event dedup store when no namespace is configured. */
export const DEFAULT_SQS_DEDUP_KEY_PREFIX = 'ws:sqs:event:v1:'

/**
 * Dedup key prefix for a deployment namespace (C10): `ws:sqs:event:v1:` when
 * the namespace is empty, `<ns>:ws:sqs:event:v1:` otherwise. Hosts pass the
 * result as `keyPrefix` to `createRedisSqsEventDedupStore`.
 */
export function namespacedDedupPrefix(namespace?: string): string {
  return applyRedisNamespace(namespace, DEFAULT_SQS_DEDUP_KEY_PREFIX)
}

const COMPLETE_SCRIPT = `
-- SRN_WS_SQS_EVENT_DEDUP_COMPLETE_V1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
return 1
`

const RELEASE_SCRIPT = `
-- SRN_WS_SQS_EVENT_DEDUP_RELEASE_V1
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`

export type SqsEventDedupDecision = 'executed' | 'duplicate'

export interface SqsEventDedupStore {
  executeOnce(eventIdentity: string, operation: () => void | Promise<void>): Promise<SqsEventDedupDecision>
}

export interface RedisSqsEventDedupClient {
  readonly status: string
  get(key: string): Promise<string | null>
  set(key: string, value: string, mode: 'PX', ttl: number, condition: 'NX'): Promise<'OK' | null>
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
}

export interface RedisSqsEventDedupOptions {
  keyPrefix?: string
  retentionMilliseconds?: number
  leaseMilliseconds?: number
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`)
  }
  return value
}

export function createRedisSqsEventDedupStore(
  redis: RedisSqsEventDedupClient,
  options: RedisSqsEventDedupOptions = {},
): SqsEventDedupStore {
  const keyPrefix = options.keyPrefix ?? DEFAULT_SQS_DEDUP_KEY_PREFIX
  const retentionMilliseconds = positiveInteger(
    options.retentionMilliseconds ?? DEFAULT_DEDUP_RETENTION_MS,
    'retentionMilliseconds',
  )
  const leaseMilliseconds = positiveInteger(options.leaseMilliseconds ?? DEFAULT_DEDUP_LEASE_MS, 'leaseMilliseconds')

  return {
    async executeOnce(eventIdentity, operation) {
      if (redis.status !== 'ready') {
        throw new Error('Shared SQS event deduplication state is not ready.')
      }

      const digest = createHash('sha256').update(eventIdentity, 'utf8').digest('hex')
      const key = `${keyPrefix}${digest}`
      const claimToken = `processing:${randomUUID()}`
      const acquired = await redis.set(key, claimToken, 'PX', leaseMilliseconds, 'NX')

      if (acquired !== 'OK') {
        const current = await redis.get(key)
        if (current === COMPLETED_VALUE) {
          return 'duplicate'
        }
        throw new Error('Shared SQS event deduplication claim is indeterminate or still in progress.')
      }

      try {
        await operation()
      } catch (error) {
        try {
          await redis.eval(RELEASE_SCRIPT, 1, key, claimToken)
        } catch {
          // The short processing lease is the recovery boundary if Redis fails
          // while releasing. The SQS message remains unacknowledged.
        }
        throw error
      }

      const completed = await redis.eval(COMPLETE_SCRIPT, 1, key, claimToken, COMPLETED_VALUE, retentionMilliseconds)
      if (Number(completed) !== 1) {
        throw new Error('Shared SQS event deduplication completion could not be confirmed.')
      }

      return 'executed'
    },
  }
}

export interface InMemorySqsEventDedupOptions {
  retentionMilliseconds?: number
  maxCompletedEntries?: number
  now?: () => number
}

/** Explicit development/test fallback. Production SQS consumers should use Redis. */
export function createInMemorySqsEventDedupStore(options: InMemorySqsEventDedupOptions = {}): SqsEventDedupStore {
  const retentionMilliseconds = positiveInteger(
    options.retentionMilliseconds ?? DEFAULT_DEDUP_RETENTION_MS,
    'retentionMilliseconds',
  )
  const maxCompletedEntries = positiveInteger(options.maxCompletedEntries ?? 10_000, 'maxCompletedEntries')
  const now = options.now ?? Date.now
  const completed = new Map<string, number>()
  const inFlight = new Map<string, Promise<void>>()

  return {
    async executeOnce(eventIdentity, operation) {
      const oldestAllowed = now() - retentionMilliseconds
      for (const [identity, completedAt] of completed) {
        if (completedAt < oldestAllowed) {
          completed.delete(identity)
        }
      }
      if (completed.has(eventIdentity)) {
        return 'duplicate'
      }

      const existing = inFlight.get(eventIdentity)
      if (existing) {
        await existing
        return 'duplicate'
      }

      const execution = Promise.resolve().then(operation)
      inFlight.set(eventIdentity, execution)
      try {
        await execution
        completed.set(eventIdentity, now())
        while (completed.size > maxCompletedEntries) {
          const oldestIdentity = completed.keys().next().value as string | undefined
          if (!oldestIdentity) {
            break
          }
          completed.delete(oldestIdentity)
        }
      } finally {
        if (inFlight.get(eventIdentity) === execution) {
          inFlight.delete(eventIdentity)
        }
      }
      return 'executed'
    },
  }
}

export type SqsDispatchMessage = DispatchMessage & { eventId?: string }

export function decodeSqsBodyToDomainEvent(body: string): Record<string, unknown> | null {
  let envelope: { Message?: unknown }
  try {
    envelope = JSON.parse(body)
  } catch {
    return null
  }

  const compressed = typeof envelope.Message === 'string' ? envelope.Message : body
  try {
    const event = JSON.parse(zlib.unzipSync(Buffer.from(compressed, 'base64')).toString()) as unknown
    return event && typeof event === 'object' && !Array.isArray(event) ? (event as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Decode an SQS message body (an SNS->SQS envelope) into the dispatch shape the
 * registry expects, or null if it isn't a WEB_SOCKET_MESSAGE_REQUESTED event.
 *
 * Mirrors the server's SQSEventMessageHandler exactly: the SNS envelope's
 * `Message` field is a base64-encoded, zlib-compressed JSON domain event.
 * Pure + side-effect free so it can be unit-tested without SQS.
 */
export function decodeSqsBodyToDispatch(body: string): SqsDispatchMessage | null {
  return domainEventToDispatch(decodeSqsBodyToDomainEvent(body))
}

/**
 * Project an already-decoded domain event onto the dispatch shape, or null when
 * it is not a well-formed WEB_SOCKET_MESSAGE_REQUESTED event. The consumer loop
 * inflates each SQS body exactly once and branches on the decoded type (N7).
 */
export function domainEventToDispatch(domainEvent: Record<string, unknown> | null): SqsDispatchMessage | null {
  const event = domainEvent as {
    eventId?: unknown
    type?: unknown
    payload?: { userUuid?: unknown; message?: unknown; originatingSessionUuid?: unknown }
  } | null

  if (event?.type !== 'WEB_SOCKET_MESSAGE_REQUESTED') {
    return null
  }
  if (
    event.eventId !== undefined &&
    (typeof event.eventId !== 'string' || event.eventId.length === 0 || event.eventId.length > 512)
  ) {
    return null
  }
  const payload = event.payload ?? {}
  if (typeof payload.userUuid !== 'string' || typeof payload.message !== 'string') {
    return null
  }
  return {
    eventId: event.eventId,
    userUuid: payload.userUuid,
    message: payload.message,
    originatingSessionUuid:
      typeof payload.originatingSessionUuid === 'string' ? payload.originatingSessionUuid : undefined,
  }
}

export interface SqsConsumerOptions {
  queueUrl: string
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  logger: Logger
  /** Required for durable events carrying eventId; omit only for legacy events. */
  dedupStore?: SqsEventDedupStore
  /** Recognized invite events are acknowledged only after this strict handler succeeds. */
  inviteRealtimeHandler?: { handle(event: InviteRealtimeDomainEventEnvelope): Promise<void> }
  /** Feeds `AttachedGateway.health().pushesDispatched` (C9); not called for suppressed duplicates. */
  onDispatched?: PushDispatchedHook
}

/**
 * Handle returned by `startSqsConsumer`. Calling it stops the consumer (the
 * original shape); `stop()` is the same operation and `running()` reports the
 * loop flag for `AttachedGateway.health().sqsConsumerRunning` (C9).
 */
export type SqsConsumerHandle = (() => void) & { stop(): void; running(): boolean }

/**
 * Polls an SQS queue (subscribed to the syncing-server SNS topic) for
 * WEB_SOCKET_MESSAGE_REQUESTED events and pushes them to live sockets. This is
 * the path used in the multi-process / SNS+SQS deployment (the Redis bridge is
 * used in single-process home-server mode). Returns a callable stop handle.
 */
export function startSqsConsumer<S extends SendableSocket>(
  registry: ConnectionRegistry<S>,
  opts: SqsConsumerOptions,
): SqsConsumerHandle {
  const config: SQSClientConfig = {
    region: opts.region ?? 'us-east-1',
    credentials: {
      accessKeyId: opts.accessKeyId ?? 'localstack',
      secretAccessKey: opts.secretAccessKey ?? 'localstack',
    },
  }
  if (opts.endpoint) {
    config.endpoint = opts.endpoint
  }
  const client = new SQSClient(config)

  let running = true
  opts.logger.info(`[sqs] consuming ${opts.queueUrl}`)

  /**
   * Process one message and report whether it may be acknowledged. Every
   * failure mode is caught here so the batch loop only ever sees a boolean;
   * a poison body is acknowledged (it would otherwise redeliver forever), a
   * failed dispatch is not (SQS redelivers it after the visibility timeout).
   */
  const processMessage = async (msg: Message): Promise<boolean> => {
    if (!msg.Body) {
      return true
    }
    // N7: inflate the body once; the queue is shared with every other event type.
    const domainEvent = decodeSqsBodyToDomainEvent(msg.Body)
    if (domainEvent?.type === INVITE_REALTIME_DOMAIN_EVENT_TYPE) {
      try {
        if (!opts.inviteRealtimeHandler) {
          throw new Error('Invite realtime SQS handler is unavailable.')
        }
        await opts.inviteRealtimeHandler.handle(domainEvent as InviteRealtimeDomainEventEnvelope)
        opts.logger.info('[invite:sqs] dispatched durable invite invalidation')
        return true
      } catch (error) {
        opts.logger.error('[sqs] invite realtime processing failed', safeErrorLogMetadata(error))
        return false
      }
    }

    const parsed = domainEventToDispatch(domainEvent)
    if (!parsed) {
      return true
    }
    try {
      let sent = 0
      let decision: SqsEventDedupDecision = 'executed'
      const dispatchMessage = (): void => {
        sent = dispatch(registry, parsed)
        opts.onDispatched?.(sent)
      }
      if (parsed.eventId) {
        if (!opts.dedupStore) {
          throw new Error('Shared SQS event deduplication is required for durable websocket events.')
        }
        decision = await opts.dedupStore.executeOnce(`WEB_SOCKET_MESSAGE_REQUESTED:${parsed.eventId}`, dispatchMessage)
      } else {
        dispatchMessage()
      }

      if (decision === 'duplicate') {
        opts.logger.info('[push:sqs] skipped completed websocket duplicate', {
          userId: parsed.userUuid,
        })
      } else {
        opts.logger.info('[push:sqs] dispatched websocket message', {
          userId: parsed.userUuid,
          socketCount: sent,
          originExcluded: parsed.originatingSessionUuid !== undefined,
        })
      }
      return true
    } catch (error) {
      opts.logger.error('[sqs] websocket message processing failed', safeErrorLogMetadata(error))
      return false
    }
  }

  const loop = async (): Promise<void> => {
    // `running` is flipped by stop() through the enclosing closure, which this
    // rule cannot follow.
    // eslint-disable-next-line no-unmodified-loop-condition
    while (running) {
      let received: { Messages?: Message[] }
      try {
        received = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: opts.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
          }),
        )
      } catch (err) {
        if (running) {
          opts.logger.error('[sqs] poll error', safeErrorLogMetadata(err))
          await new Promise((r) => setTimeout(r, 2000))
        }
        continue
      }

      for (const msg of received.Messages ?? []) {
        if (!running) {
          break
        }
        // R35: each message owns its dispatch + acknowledgement. A rejected
        // DeleteMessage used to abort the whole batch, leaving the rest
        // undispatched until SQS redelivered them and the failed one
        // dispatched twice; now it is logged and the batch carries on.
        try {
          const acknowledge = await processMessage(msg)
          if (acknowledge && msg.ReceiptHandle) {
            await client.send(new DeleteMessageCommand({ QueueUrl: opts.queueUrl, ReceiptHandle: msg.ReceiptHandle }))
          }
        } catch (error) {
          if (running) {
            opts.logger.error('[sqs] message acknowledgement failed', safeErrorLogMetadata(error))
          }
        }
      }
    }
  }

  void loop()

  const stop = (): void => {
    running = false
    client.destroy()
  }

  return Object.assign(stop, { stop, running: () => running })
}
