import 'reflect-metadata'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { AssistantController } from './AssistantController'
import {
  CHAT_RUN_LEASE_RENEW_MS,
  CHAT_RUN_STREAM_MAX_MS,
  RedisAssistantChatRunLease,
} from '../../Service/Assistant/RedisAssistantChatRunLease'
import type { Provider, ProviderEvent } from '../../Service/Assistant/providers/types'

const proof = {
  chatId: 'legacy-chat',
  requestId: '11111111-1111-4111-8111-111111111111',
  leaseId: '22222222-2222-4222-8222-222222222222',
  fence: 1,
}
const controller = (redis: unknown = { eval: jest.fn(async () => []) }) =>
  new AssistantController({} as never, 'openai', 'test', 0, [], redis as never)
const request = (body: unknown): Request => Object.assign(new EventEmitter(), { body, headers: {} }) as Request
function response() {
  const value = Object.assign(new EventEmitter(), {
    locals: { user: { uuid: 'verified-user' }, roles: [] },
    status: jest.fn(),
    json: jest.fn(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    writableEnded: false,
  })
  value.status.mockReturnValue(value)
  value.end.mockImplementation(() => {
    value.writableEnded = true
  })
  return value as unknown as Response & typeof value
}
function mockProvider(instance: AssistantController, provider: Provider) {
  return jest
    .spyOn(instance as unknown as { resolveStreamProvider: () => Promise<unknown> }, 'resolveStreamProvider')
    .mockResolvedValue({ provider, isSubscription: false, generation: {} })
}
beforeEach(() => jest.restoreAllMocks())
afterEach(() => jest.useRealTimers())

it('uses verified account identity for acquisition and ignores caller-supplied account fields', async () => {
  const acquire = jest
    .spyOn(RedisAssistantChatRunLease.prototype, 'acquire')
    .mockResolvedValue({ acquired: true, leaseId: proof.leaseId, fence: 1, expiresAt: 31000 })
  const res = response()
  await controller().acquireChatRunLease(request({ ...proof, userUuid: 'another-user' }), res)
  expect(acquire).toHaveBeenCalledWith('verified-user', expect.objectContaining({ chatId: proof.chatId }))
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ acquired: true }))
})

it('requires authentication, validates identities, and fails closed when Redis is unavailable', async () => {
  const noUser = response()
  noUser.locals.user = undefined
  await controller().acquireChatRunLease(request(proof), noUser)
  expect(noUser.status).toHaveBeenCalledWith(401)
  const invalid = response()
  await controller().renewChatRunLease(request({ ...proof, fence: 1.5 }), invalid)
  expect(invalid.status).toHaveBeenCalledWith(400)
  const unavailable = response()
  await controller(null).releaseChatRunLease(request(proof), unavailable)
  expect(unavailable.status).toHaveBeenCalledWith(503)
})

it('refuses invalid/expired or concurrent stream proofs before contacting the provider', async () => {
  const instance = controller()
  const provider = { id: 'test', send: jest.fn() } as unknown as Provider
  mockProvider(instance, provider)
  jest.spyOn(RedisAssistantChatRunLease.prototype, 'beginStream').mockResolvedValue(undefined)
  const res = response()
  await instance.streamCompletion(request({ messages: [], chatRunLease: proof }), res)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(provider.send).not.toHaveBeenCalled()
  const malformed = response()
  await instance.streamCompletion(request({ chatRunLease: { ...proof, leaseId: 'invalid' } }), malformed)
  expect(malformed.status).toHaveBeenCalledWith(400)
})

it.each(['renewal-lost', 'watchdog', 'ignores-abort'] as const)(
  'aborts a lease-protected upstream and cleans its stream reservation on %s',
  async (cause) => {
    jest.useFakeTimers()
    const instance = controller()
    let signal: AbortSignal | undefined
    const send = jest.fn((input: { signal?: AbortSignal }): AsyncIterable<ProviderEvent> =>
      cause === 'ignores-abort'
        ? {
            [Symbol.asyncIterator]() {
              signal = input.signal
              return {
                next: () => new Promise<IteratorResult<ProviderEvent>>(() => undefined),
                return: async () => ({ done: true, value: undefined }),
              }
            },
          }
        : {
            async *[Symbol.asyncIterator]() {
              signal = input.signal
              await new Promise<void>((_resolve, reject) =>
                input.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
              )
              yield { kind: 'finish', stopReason: 'end_turn' }
            },
          },
    )
    mockProvider(instance, { id: 'test', send })
    jest.spyOn(RedisAssistantChatRunLease.prototype, 'beginStream').mockResolvedValue('stream-id')
    const renew = jest
      .spyOn(RedisAssistantChatRunLease.prototype, 'renewStream')
      .mockResolvedValue(cause !== 'renewal-lost')
    const end = jest.spyOn(RedisAssistantChatRunLease.prototype, 'endStream').mockResolvedValue(undefined)
    const res = response()
    const pending = instance.streamCompletion(request({ messages: [], chatRunLease: proof }), res)
    for (let index = 0; index < 30 && !send.mock.calls.length; index++) {
      await Promise.resolve()
    }
    expect(send).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(cause !== 'renewal-lost' ? CHAT_RUN_STREAM_MAX_MS : CHAT_RUN_LEASE_RENEW_MS)
    await pending
    expect(signal?.aborted).toBe(true)
    expect(renew).toHaveBeenCalled()
    expect(end).toHaveBeenCalledWith('verified-user', proof, 'stream-id')
    expect(res.end).toHaveBeenCalledTimes(1)
    expect(res.write.mock.calls.map((call) => call[0]).join('')).toContain(
      cause !== 'renewal-lost' ? 'five-minute server limit' : 'lost its server lease',
    )
    const count = renew.mock.calls.length
    await jest.advanceTimersByTimeAsync(CHAT_RUN_LEASE_RENEW_MS * 2)
    expect(renew).toHaveBeenCalledTimes(count)
  },
)
