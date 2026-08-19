import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as zlib from 'node:zlib'

const sqs = vi.hoisted(() => {
  interface SentCommand {
    kind: 'receive' | 'delete'
    input: Record<string, unknown>
  }

  const state = {
    configs: [] as Record<string, unknown>[],
    sent: [] as SentCommand[],
    destroyed: 0,
    /** Queued responses for successive ReceiveMessageCommand calls. */
    receiveQueue: [] as Array<{ Messages?: Array<Record<string, unknown>> } | Error>,
    /** Resolves once the loop has drained every queued response. */
    drained: undefined as Promise<void> | undefined,
    signalDrained: undefined as (() => void) | undefined,
  }

  class ReceiveMessageCommand {
    readonly kind = 'receive' as const
    constructor(readonly input: Record<string, unknown>) {}
  }

  class DeleteMessageCommand {
    readonly kind = 'delete' as const
    constructor(readonly input: Record<string, unknown>) {}
  }

  class SQSClient {
    constructor(config: Record<string, unknown>) {
      state.configs.push(config)
    }

    async send(command: ReceiveMessageCommand | DeleteMessageCommand): Promise<unknown> {
      state.sent.push({ kind: command.kind, input: command.input })

      if (command.kind === 'delete') {
        return {}
      }

      const next = state.receiveQueue.shift()
      if (next === undefined) {
        state.signalDrained?.()
        // Nothing left to hand out: park forever so the loop stops doing work.
        return new Promise(() => {})
      }
      if (next instanceof Error) {
        throw next
      }

      return next
    }

    destroy(): void {
      state.destroyed += 1
    }
  }

  return { state, SQSClient, ReceiveMessageCommand, DeleteMessageCommand }
})

vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: sqs.SQSClient,
  ReceiveMessageCommand: sqs.ReceiveMessageCommand,
  DeleteMessageCommand: sqs.DeleteMessageCommand,
}))

import {
  createInMemorySqsEventDedupStore,
  decodeSqsBodyToDispatch,
  startSqsConsumer,
  type SqsEventDedupStore,
} from '../src/sqsConsumer.js'
import { ConnectionRegistry, type SendableSocket } from '../src/registry.js'

function snsEnvelope(event: unknown): string {
  return JSON.stringify({ Message: zlib.gzipSync(Buffer.from(JSON.stringify(event))).toString('base64') })
}

function wsEvent(userUuid: string, message: string, originatingSessionUuid?: string, eventId?: string): unknown {
  return {
    eventId,
    type: 'WEB_SOCKET_MESSAGE_REQUESTED',
    payload: { userUuid, message, originatingSessionUuid },
  }
}

function inviteEvent(): unknown {
  return {
    eventId: 'invite-domain-event-1',
    type: 'INVITE_REALTIME_INVALIDATION_REQUESTED',
    payload: { version: 1, recordId: 'invite-record-1', affectedUserUuids: ['user-1'], event: {} },
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function makeRegistry(): { registry: ConnectionRegistry<SendableSocket>; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  const registry = new ConnectionRegistry<SendableSocket>()
  registry.add('user-1', { socket: { send }, userUuid: 'user-1', sessionUuid: 'session-1', connectionId: 'c1' })

  return { registry, send }
}

/** Resolves once the consumer has consumed every queued receive response. */
function whenDrained(): Promise<void> {
  return new Promise<void>((resolve) => {
    sqs.state.signalDrained = resolve
  })
}

beforeEach(() => {
  sqs.state.configs = []
  sqs.state.sent = []
  sqs.state.destroyed = 0
  sqs.state.receiveQueue = []
  sqs.state.signalDrained = undefined
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('startSqsConsumer', () => {
  it('preserves the durable event id through envelope decoding', () => {
    expect(decodeSqsBodyToDispatch(snsEnvelope(wsEvent('user-1', 'payload', undefined, 'event-1')))).toEqual({
      eventId: 'event-1',
      userUuid: 'user-1',
      message: 'payload',
      originatingSessionUuid: undefined,
    })
  })

  it('defaults the region and credentials and omits the endpoint when none is given', async () => {
    const drained = whenDrained()
    const stop = startSqsConsumer(makeRegistry().registry, { queueUrl: 'https://sqs/q', logger: makeLogger() })
    await drained

    expect(sqs.state.configs).toHaveLength(1)
    expect(sqs.state.configs[0]).toEqual({
      region: 'us-east-1',
      credentials: { accessKeyId: 'localstack', secretAccessKey: 'localstack' },
    })
    expect(sqs.state.configs[0]).not.toHaveProperty('endpoint')
    stop()
  })

  it('passes through an explicit endpoint, region and credentials', async () => {
    const drained = whenDrained()
    const stop = startSqsConsumer(makeRegistry().registry, {
      queueUrl: 'https://sqs/q',
      endpoint: 'http://localstack:4566',
      region: 'eu-west-2',
      accessKeyId: 'AKIA',
      secretAccessKey: 'shh',
      logger: makeLogger(),
    })
    await drained

    expect(sqs.state.configs[0]).toEqual({
      region: 'eu-west-2',
      endpoint: 'http://localstack:4566',
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'shh' },
    })
    stop()
  })

  it('long-polls the queue with the documented batch size and wait time', async () => {
    const drained = whenDrained()
    const logger = makeLogger()
    const stop = startSqsConsumer(makeRegistry().registry, { queueUrl: 'https://sqs/q', logger })
    await drained

    expect(logger.info).toHaveBeenCalledWith('[sqs] consuming https://sqs/q')
    expect(sqs.state.sent[0]).toEqual({
      kind: 'receive',
      input: { QueueUrl: 'https://sqs/q', MaxNumberOfMessages: 10, WaitTimeSeconds: 20 },
    })
    stop()
  })

  it('dispatches a decoded websocket event to the registry and deletes the message', async () => {
    const { registry, send } = makeRegistry()
    const logger = makeLogger()
    sqs.state.receiveQueue = [
      {
        Messages: [{ Body: snsEnvelope(wsEvent('user-1', 'payload-a')), ReceiptHandle: 'rh-1' }],
      },
    ]
    const drained = whenDrained()
    const stop = startSqsConsumer(registry, { queueUrl: 'https://sqs/q', logger })
    await drained

    expect(send).toHaveBeenCalledWith('payload-a')
    expect(logger.info).toHaveBeenCalledWith('[push:sqs] dispatched websocket message', {
      userId: 'user-1',
      socketCount: 1,
      originExcluded: false,
    })
    expect(sqs.state.sent).toContainEqual({
      kind: 'delete',
      input: { QueueUrl: 'https://sqs/q', ReceiptHandle: 'rh-1' },
    })
    stop()
  })

  it('dispatches an invite event through the same consumer and deletes only after success', async () => {
    const { registry, send } = makeRegistry()
    const logger = makeLogger()
    const handle = vi.fn().mockResolvedValue(undefined)
    sqs.state.receiveQueue = [{ Messages: [{ Body: snsEnvelope(inviteEvent()), ReceiptHandle: 'rh-invite' }] }]
    const drained = whenDrained()
    const stop = startSqsConsumer(registry, {
      queueUrl: 'https://sqs/q',
      logger,
      inviteRealtimeHandler: { handle },
    })
    await drained

    expect(handle).toHaveBeenCalledWith(inviteEvent())
    expect(send).not.toHaveBeenCalled()
    expect(sqs.state.sent).toContainEqual({
      kind: 'delete',
      input: { QueueUrl: 'https://sqs/q', ReceiptHandle: 'rh-invite' },
    })
    stop()
  })

  it('does not acknowledge a recognized invite event without a healthy dispatcher', async () => {
    const logger = makeLogger()
    sqs.state.receiveQueue = [
      { Messages: [{ Body: snsEnvelope(inviteEvent()), ReceiptHandle: 'rh-invite-unavailable' }] },
    ]
    const drained = whenDrained()
    const stop = startSqsConsumer(makeRegistry().registry, { queueUrl: 'https://sqs/q', logger })
    await drained

    expect(sqs.state.sent.filter((command) => command.kind === 'delete')).toHaveLength(0)
    expect(logger.error).toHaveBeenCalledWith(
      '[sqs] invite realtime processing failed',
      expect.objectContaining({ errorType: 'Error' }),
    )
    stop()
  })

  it('leaves an invite event unacknowledged when durable dispatch rejects', async () => {
    sqs.state.receiveQueue = [{ Messages: [{ Body: snsEnvelope(inviteEvent()), ReceiptHandle: 'rh-invite-retry' }] }]
    const drained = whenDrained()
    const stop = startSqsConsumer(makeRegistry().registry, {
      queueUrl: 'https://sqs/q',
      logger: makeLogger(),
      inviteRealtimeHandler: { handle: vi.fn().mockRejectedValue(new Error('redis unavailable')) },
    })
    await drained

    expect(sqs.state.sent.filter((command) => command.kind === 'delete')).toHaveLength(0)
    stop()
  })

  it('dispatches a durable event once and deletes its completed duplicate', async () => {
    const { registry, send } = makeRegistry()
    const logger = makeLogger()
    const body = snsEnvelope(wsEvent('user-1', 'payload-a', undefined, 'event-1'))
    sqs.state.receiveQueue = [
      {
        Messages: [
          { Body: body, ReceiptHandle: 'rh-first' },
          { Body: body, ReceiptHandle: 'rh-duplicate' },
        ],
      },
    ]
    const drained = whenDrained()
    const stop = startSqsConsumer(registry, {
      queueUrl: 'https://sqs/q',
      logger,
      dedupStore: createInMemorySqsEventDedupStore(),
    })
    await drained

    expect(send).toHaveBeenCalledTimes(1)
    expect(sqs.state.sent.filter((command) => command.kind === 'delete')).toHaveLength(2)
    expect(logger.info).toHaveBeenCalledWith('[push:sqs] skipped completed websocket duplicate', {
      userId: 'user-1',
    })
    stop()
  })

  it('fails closed and does not delete a durable event when no shared dedup store is configured', async () => {
    const { registry, send } = makeRegistry()
    const logger = makeLogger()
    sqs.state.receiveQueue = [
      {
        Messages: [
          {
            Body: snsEnvelope(wsEvent('user-1', 'payload-a', undefined, 'event-1')),
            ReceiptHandle: 'rh-no-store',
          },
        ],
      },
    ]
    const drained = whenDrained()
    const stop = startSqsConsumer(registry, { queueUrl: 'https://sqs/q', logger })
    await drained

    expect(send).not.toHaveBeenCalled()
    expect(sqs.state.sent.filter((command) => command.kind === 'delete')).toHaveLength(0)
    expect(logger.error).toHaveBeenCalledWith(
      '[sqs] websocket message processing failed',
      expect.objectContaining({ errorType: 'Error' }),
    )
    stop()
  })

  it('does not delete after dispatch when durable completion is indeterminate', async () => {
    const { registry, send } = makeRegistry()
    const logger = makeLogger()
    const indeterminateStore: SqsEventDedupStore = {
      executeOnce: vi.fn(async (_eventIdentity, operation) => {
        await operation()
        throw new Error('completion unavailable')
      }),
    }
    sqs.state.receiveQueue = [
      {
        Messages: [
          {
            Body: snsEnvelope(wsEvent('user-1', 'payload-a', undefined, 'event-1')),
            ReceiptHandle: 'rh-indeterminate',
          },
        ],
      },
    ]
    const drained = whenDrained()
    const stop = startSqsConsumer(registry, {
      queueUrl: 'https://sqs/q',
      logger,
      dedupStore: indeterminateStore,
    })
    await drained

    expect(send).toHaveBeenCalledTimes(1)
    expect(sqs.state.sent.filter((command) => command.kind === 'delete')).toHaveLength(0)
    stop()
  })

  it('reports the excluded originating session when the event carries one', async () => {
    const { registry } = makeRegistry()
    const logger = makeLogger()
    sqs.state.receiveQueue = [
      { Messages: [{ Body: snsEnvelope(wsEvent('user-1', 'm', 'session-1')), ReceiptHandle: 'rh-2' }] },
    ]
    const drained = whenDrained()
    const stop = startSqsConsumer(registry, { queueUrl: 'https://sqs/q', logger })
    await drained

    expect(logger.info).toHaveBeenCalledWith('[push:sqs] dispatched websocket message', {
      userId: 'user-1',
      socketCount: 0,
      originExcluded: true,
    })
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('session-1')
    stop()
  })

  it('deletes an undecodable message without dispatching it', async () => {
    const { registry, send } = makeRegistry()
    sqs.state.receiveQueue = [{ Messages: [{ Body: 'not-an-envelope', ReceiptHandle: 'rh-3' }] }]
    const drained = whenDrained()
    const stop = startSqsConsumer(registry, { queueUrl: 'https://sqs/q', logger: makeLogger() })
    await drained

    expect(send).not.toHaveBeenCalled()
    // Still acknowledged, otherwise a poison message would be redelivered forever.
    expect(sqs.state.sent).toContainEqual({
      kind: 'delete',
      input: { QueueUrl: 'https://sqs/q', ReceiptHandle: 'rh-3' },
    })
    stop()
  })

  it('skips a message with no body and one with no receipt handle', async () => {
    const { registry, send } = makeRegistry()
    sqs.state.receiveQueue = [
      { Messages: [{ ReceiptHandle: 'rh-4' }, { Body: snsEnvelope(wsEvent('user-1', 'no-handle')) }] },
    ]
    const drained = whenDrained()
    const stop = startSqsConsumer(registry, { queueUrl: 'https://sqs/q', logger: makeLogger() })
    await drained

    expect(send).toHaveBeenCalledWith('no-handle')
    const deletes = sqs.state.sent.filter((command) => command.kind === 'delete')
    expect(deletes).toEqual([{ kind: 'delete', input: { QueueUrl: 'https://sqs/q', ReceiptHandle: 'rh-4' } }])
    stop()
  })

  it('tolerates a receive batch with no Messages field', async () => {
    sqs.state.receiveQueue = [{}]
    const logger = makeLogger()
    const drained = whenDrained()
    const stop = startSqsConsumer(makeRegistry().registry, { queueUrl: 'https://sqs/q', logger })
    await drained

    expect(logger.error).not.toHaveBeenCalled()
    stop()
  })

  it('logs a poll failure and keeps polling after a backoff', async () => {
    const logger = makeLogger()
    sqs.state.receiveQueue = [new Error('throttled'), { Messages: [] }]
    const drained = whenDrained()
    const stop = startSqsConsumer(makeRegistry().registry, { queueUrl: 'https://sqs/q', logger })
    await drained

    expect(logger.error).toHaveBeenCalledWith('[sqs] poll error', {
      errorType: 'Error',
      errorCode: undefined,
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('throttled')
    // Three receives: the failing one, the retry, then the park.
    expect(sqs.state.sent.filter((command) => command.kind === 'receive')).toHaveLength(3)
    stop()
  }, 10_000)

  it('stops polling and destroys the client when the returned stop() is called', async () => {
    const drained = whenDrained()
    const stop = startSqsConsumer(makeRegistry().registry, { queueUrl: 'https://sqs/q', logger: makeLogger() })
    await drained

    expect(sqs.state.destroyed).toBe(0)
    stop()
    expect(sqs.state.destroyed).toBe(1)
  })

  it('does not log a poll error for the failure caused by stopping', async () => {
    const logger = makeLogger()
    sqs.state.receiveQueue = [new Error('client destroyed')]
    const stop = startSqsConsumer(makeRegistry().registry, { queueUrl: 'https://sqs/q', logger })
    stop()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(logger.error).not.toHaveBeenCalled()
  })
})
