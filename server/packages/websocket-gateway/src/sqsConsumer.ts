import { createHash, randomUUID } from 'node:crypto'
import * as zlib from 'node:zlib'
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient, type SQSClientConfig } from '@aws-sdk/client-sqs'
import { ConnectionRegistry, dispatch, type DispatchMessage, type SendableSocket } from './registry.js'
import type { Logger } from './redisBridge.js'
import { safeErrorLogMetadata } from './safeLog.js'

const DEFAULT_DEDUP_RETENTION_MS = 24 * 60 * 60 * 1_000
const DEFAULT_DEDUP_LEASE_MS = 30_000
const COMPLETED_VALUE = 'completed'

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
  const keyPrefix = options.keyPrefix ?? 'ws:sqs:event:v1:'
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

/**
 * Decode an SQS message body (an SNS->SQS envelope) into the dispatch shape the
 * registry expects, or null if it isn't a WEB_SOCKET_MESSAGE_REQUESTED event.
 *
 * Mirrors the server's SQSEventMessageHandler exactly: the SNS envelope's
 * `Message` field is a base64-encoded, zlib-compressed JSON domain event.
 * Pure + side-effect free so it can be unit-tested without SQS.
 */
export function decodeSqsBodyToDispatch(body: string): SqsDispatchMessage | null {
  let envelope: { Message?: unknown }
  try {
    envelope = JSON.parse(body)
  } catch {
    return null
  }

  const compressed = typeof envelope.Message === 'string' ? envelope.Message : body
  let eventJson: string
  try {
    eventJson = zlib.unzipSync(Buffer.from(compressed, 'base64')).toString()
  } catch {
    return null
  }

  let event: {
    eventId?: unknown
    type?: unknown
    payload?: { userUuid?: unknown; message?: unknown; originatingSessionUuid?: unknown }
  }
  try {
    event = JSON.parse(eventJson)
  } catch {
    return null
  }

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
}

/**
 * Polls an SQS queue (subscribed to the syncing-server SNS topic) for
 * WEB_SOCKET_MESSAGE_REQUESTED events and pushes them to live sockets. This is
 * the path used in the multi-process / SNS+SQS deployment (the Redis bridge is
 * used in single-process home-server mode). Returns a stop() function.
 */
export function startSqsConsumer<S extends SendableSocket>(
  registry: ConnectionRegistry<S>,
  opts: SqsConsumerOptions,
): () => void {
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

  const loop = async (): Promise<void> => {
    while (true) {
      if (!running) {
        break
      }
      try {
        const result = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: opts.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
          }),
        )
        for (const msg of result.Messages ?? []) {
          let acknowledge = true
          if (msg.Body) {
            const parsed = decodeSqsBodyToDispatch(msg.Body)
            if (parsed) {
              try {
                let sent = 0
                let decision: SqsEventDedupDecision = 'executed'
                const dispatchMessage = (): void => {
                  sent = dispatch(registry, parsed)
                }
                if (parsed.eventId) {
                  if (!opts.dedupStore) {
                    throw new Error('Shared SQS event deduplication is required for durable websocket events.')
                  }
                  decision = await opts.dedupStore.executeOnce(
                    `WEB_SOCKET_MESSAGE_REQUESTED:${parsed.eventId}`,
                    dispatchMessage,
                  )
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
              } catch (error) {
                acknowledge = false
                opts.logger.error('[sqs] websocket message processing failed', safeErrorLogMetadata(error))
              }
            }
          }
          if (acknowledge && msg.ReceiptHandle) {
            await client.send(new DeleteMessageCommand({ QueueUrl: opts.queueUrl, ReceiptHandle: msg.ReceiptHandle }))
          }
        }
      } catch (err) {
        if (running) {
          opts.logger.error('[sqs] poll error', safeErrorLogMetadata(err))
          await new Promise((r) => setTimeout(r, 2000))
        }
      }
    }
  }

  void loop()

  return () => {
    running = false
    client.destroy()
  }
}
