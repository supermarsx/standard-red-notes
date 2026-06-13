import * as zlib from 'node:zlib'
import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type SQSClientConfig,
} from '@aws-sdk/client-sqs'
import { ConnectionRegistry, dispatch, type DispatchMessage, type SendableSocket } from './registry.js'
import type { Logger } from './redisBridge.js'

/**
 * Decode an SQS message body (an SNS->SQS envelope) into the dispatch shape the
 * registry expects, or null if it isn't a WEB_SOCKET_MESSAGE_REQUESTED event.
 *
 * Mirrors the server's SQSEventMessageHandler exactly: the SNS envelope's
 * `Message` field is a base64-encoded, zlib-compressed JSON domain event.
 * Pure + side-effect free so it can be unit-tested without SQS.
 */
export function decodeSqsBodyToDispatch(body: string): DispatchMessage | null {
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

  let event: { type?: unknown; payload?: { userUuid?: unknown; message?: unknown; originatingSessionUuid?: unknown } }
  try {
    event = JSON.parse(eventJson)
  } catch {
    return null
  }

  if (event?.type !== 'WEB_SOCKET_MESSAGE_REQUESTED') {
    return null
  }
  const payload = event.payload ?? {}
  if (typeof payload.userUuid !== 'string' || typeof payload.message !== 'string') {
    return null
  }
  return {
    userUuid: payload.userUuid,
    message: payload.message,
    originatingSessionUuid: typeof payload.originatingSessionUuid === 'string' ? payload.originatingSessionUuid : undefined,
  }
}

export interface SqsConsumerOptions {
  queueUrl: string
  endpoint?: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  logger: Logger
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
    while (running) {
      try {
        const result = await client.send(
          new ReceiveMessageCommand({
            QueueUrl: opts.queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 20,
          }),
        )
        for (const msg of result.Messages ?? []) {
          if (msg.Body) {
            const parsed = decodeSqsBodyToDispatch(msg.Body)
            if (parsed) {
              const sent = dispatch(registry, parsed)
              opts.logger.info(
                `[push:sqs] user=${parsed.userUuid} sockets=${sent}` +
                  (parsed.originatingSessionUuid ? ` excludeSession=${parsed.originatingSessionUuid}` : ''),
              )
            }
          }
          if (msg.ReceiptHandle) {
            await client.send(
              new DeleteMessageCommand({ QueueUrl: opts.queueUrl, ReceiptHandle: msg.ReceiptHandle }),
            )
          }
        }
      } catch (err) {
        if (running) {
          opts.logger.error('[sqs] poll error', err instanceof Error ? err.message : err)
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
