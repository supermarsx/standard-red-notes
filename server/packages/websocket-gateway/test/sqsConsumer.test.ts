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
    /** DeleteMessage rejects with the mapped error for these receipt handles. */
    deleteRejects: new Map<string, Error>(),
    /** Invoked (before any rejection) when DeleteMessage is sent for the receipt handle. */
    deleteHooks: new Map<string, () => void>(),
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
        const receiptHandle = String(command.input.ReceiptHandle)
        state.deleteHooks.get(receiptHandle)?.()
        const rejection = state.deleteRejects.get(receiptHandle)
        if (rejection) {
          throw rejection
        }
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

/**
 * Counts every inflate the consumer performs. `decodeSqsBodyToDomainEvent` is
 * called internally, so a spy on the export would not see it; the one zlib
 * call per decode is the observable that proves a body is decoded once (N7).
 */
const inflate = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:zlib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:zlib')>()
  const unzipSync: typeof actual.unzipSync = (...args) => {
    inflate.count += 1
    return actual.unzipSync(...args)
  }
  return { ...actual, unzipSync }
})

import {
  createInMemorySqsEventDedupStore,
  decodeSqsBodyToDispatch,
  startSqsConsumer,
  type SqsConsumerHandle,
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
  sqs.state.deleteRejects.clear()
  sqs.state.deleteHooks.clear()
  inflate.count = 0
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

  it('inflates each message body exactly once before branching on its type', async () => {
    const { registry, send } = makeRegistry()
    const handle = vi.fn().mockResolvedValue(undefined)
    sqs.state.receiveQueue = [
      {
        Messages: [
          { Body: snsEnvelope(wsEvent('user-1', 'payload-a')), ReceiptHandle: 'rh-ws' },
          { Body: snsEnvelope(inviteEvent()), ReceiptHandle: 'rh-invite' },
          // The queue is unfiltered (N7): every other syncing-server/auth event lands here too.
          { Body: snsEnvelope({ type: 'USER_SIGNED_IN', payload: { userUuid: 'user-1' } }), ReceiptHandle: 'rh-other' },
        ],
      },
    ]
    const drained = whenDrained()
    const stop = startSqsConsumer(registry, {
      queueUrl: 'https://sqs/q',
      logger: makeLogger(),
      inviteRealtimeHandler: { handle },
    })
    await drained

    expect(inflate.count).toBe(3)
    expect(send).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledTimes(1)
    expect(
      sqs.state.sent.filter((command) => command.kind === 'delete').map((command) => command.input.ReceiptHandle),
    ).toEqual(['rh-ws', 'rh-invite', 'rh-other'])
    stop()
  })

  it('keeps dispatching and acknowledging the rest of a batch when one DeleteMessage rejects', async () => {
    const { registry, send } = makeRegistry()
    const logger = makeLogger()
    sqs.state.deleteRejects.set('rh-b', new Error('delete rejected'))
    sqs.state.receiveQueue = [
      {
        Messages: [
          { Body: snsEnvelope(wsEvent('user-1', 'payload-a')), ReceiptHandle: 'rh-a' },
          { Body: snsEnvelope(wsEvent('user-1', 'payload-b')), ReceiptHandle: 'rh-b' },
          { Body: snsEnvelope(wsEvent('user-1', 'payload-c')), ReceiptHandle: 'rh-c' },
        ],
      },
    ]
    const drained = whenDrained()
    const stop = startSqsConsumer(registry, { queueUrl: 'https://sqs/q', logger })
    await drained

    // R35: b is dispatched once (never re-dispatched), c still goes out and is acknowledged.
    expect(send.mock.calls).toEqual([['payload-a'], ['payload-b'], ['payload-c']])
    expect(
      sqs.state.sent.filter((command) => command.kind === 'delete').map((command) => command.input.ReceiptHandle),
    ).toEqual(['rh-a', 'rh-b', 'rh-c'])
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('[sqs] message acknowledgement failed', {
      errorType: 'Error',
      errorCode: undefined,
    })
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('delete rejected')
    stop()
  })

  it('abandons the remainder of a batch once stopped and stays quiet about the interrupted delete', async () => {
    const { registry, send } = makeRegistry()
    const logger = makeLogger()
    sqs.state.receiveQueue = [
      {
        Messages: [
          { Body: snsEnvelope(wsEvent('user-1', 'payload-a')), ReceiptHandle: 'rh-a' },
          { Body: snsEnvelope(wsEvent('user-1', 'payload-b')), ReceiptHandle: 'rh-b' },
        ],
      },
    ]
    let handle: SqsConsumerHandle | undefined
    sqs.state.deleteHooks.set('rh-a', () => {
      handle?.()
      throw new Error('client destroyed')
    })
    handle = startSqsConsumer(registry, { queueUrl: 'https://sqs/q', logger })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(send.mock.calls).toEqual([['payload-a']])
    expect(handle.running()).toBe(false)
    expect(sqs.state.destroyed).toBe(1)
    expect(logger.error).not.toHaveBeenCalled()
    expect(sqs.state.sent.filter((command) => command.kind === 'receive')).toHaveLength(1)
  })

  it('exposes stop() and running() on the callable handle', async () => {
    const drained = whenDrained()
    const handle = startSqsConsumer(makeRegistry().registry, { queueUrl: 'https://sqs/q', logger: makeLogger() })
    await drained

    expect(handle.running()).toBe(true)
    expect(handle.stop).toBe(handle)
    handle.stop()
    expect(handle.running()).toBe(false)
    expect(sqs.state.destroyed).toBe(1)
  })

  it('reports every dispatched push through onDispatched and skips suppressed duplicates', async () => {
    const { registry } = makeRegistry()
    const onDispatched = vi.fn()
    const durable = snsEnvelope(wsEvent('user-1', 'payload-a', undefined, 'event-1'))
    sqs.state.receiveQueue = [
      {
        Messages: [
          { Body: durable, ReceiptHandle: 'rh-first' },
          { Body: durable, ReceiptHandle: 'rh-duplicate' },
          { Body: snsEnvelope(wsEvent('user-1', 'payload-b', 'session-1')), ReceiptHandle: 'rh-legacy' },
        ],
      },
    ]
    const drained = whenDrained()
    const stop = startSqsConsumer(registry, {
      queueUrl: 'https://sqs/q',
      logger: makeLogger(),
      dedupStore: createInMemorySqsEventDedupStore(),
      onDispatched,
    })
    await drained

    // The duplicate is suppressed; the legacy push reached no socket (origin excluded) but still counts.
    expect(onDispatched.mock.calls).toEqual([[1], [0]])
    stop()
  })
})
