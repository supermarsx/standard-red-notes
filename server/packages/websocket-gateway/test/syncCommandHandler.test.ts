import { describe, expect, it, vi } from 'vitest'

import { InMemorySyncAuthTicketStore } from '../src/auth.js'
import {
  InMemorySyncCommandLeaseRegistry,
  InMemorySyncSocketBudget,
  type SyncCommandLeaseRegistry,
  type SyncSocketBudget,
} from '../src/registry.js'
import {
  SyncCommandHandler,
  type SyncCommandBackendAdapter,
  type SyncLiveAuthorizationAdapter,
  type SyncSocket,
} from '../src/syncCommandHandler.js'
import {
  MAX_SYNC_BUFFERED_BYTES,
  MAX_SYNC_FRAME_BYTES,
  MAX_SYNC_RESUME_SEQUENCE,
  createSyncServerFrame,
  digestSyncCommandBody,
  syncPayloadLength,
  type JsonObject,
} from '../src/syncProtocol.js'

class FakeSocket implements SyncSocket {
  bufferedAmount = 0
  throwOnSend = false
  throwOnClose = false
  readonly frames: JsonObject[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []

  send(data: string): void {
    if (this.throwOnSend) {
      throw new Error('socket send failed')
    }
    this.frames.push(JSON.parse(data) as JsonObject)
  }

  close(code?: number, reason?: string): void {
    if (this.throwOnClose) {
      throw new Error('socket close failed')
    }
    this.closes.push({ code, reason })
  }
}

function rawFrame(frame: JsonObject): string {
  return JSON.stringify(frame)
}

function authFrame(ticket: string, deviceId = 'device-1', resumeSequence?: number): JsonObject {
  const payload = { ticket, deviceId, ...(resumeSequence === undefined ? {} : { resumeSequence }) }
  return {
    version: 1,
    channel: 'sync',
    type: 'AUTH',
    requestId: 'auth-request',
    commandId: 'auth-command',
    sequence: 0,
    payloadLength: syncPayloadLength(payload),
    payload,
  }
}

function commandFrame(
  commandId: string,
  sequence: number,
  body: JsonObject = { api: '20200115', items: [] },
): JsonObject {
  const payload = { command: 'SYNC_ITEMS', body }
  return {
    version: 1,
    channel: 'sync',
    type: 'COMMAND',
    requestId: `request-${commandId}`,
    commandId,
    sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
    digest: digestSyncCommandBody(body),
  }
}

function statusFrame(commandId: string, sequence: number, digest: string): JsonObject {
  return {
    version: 1,
    channel: 'sync',
    type: 'STATUS',
    requestId: `status-${commandId}`,
    commandId,
    sequence,
    payloadLength: 2,
    payload: {},
    digest,
  }
}

function pingFrame(sequence: number): JsonObject {
  return {
    version: 1,
    channel: 'sync',
    type: 'PING',
    requestId: 'ping-request',
    commandId: 'ping-command',
    sequence,
    payloadLength: 2,
    payload: {},
  }
}

function enqueue(handler: SyncCommandHandler, frame: JsonObject): void {
  const raw = rawFrame(frame)
  handler.enqueue(raw, Buffer.byteLength(raw))
}

const allowAuthorization = (): SyncLiveAuthorizationAdapter => ({
  ready: () => true,
  authorize: vi.fn(async () => ({ authorized: true })),
})

const committingBackend = (): SyncCommandBackendAdapter => ({
  ready: () => true,
  execute: vi.fn(async (input) => ({ digest: input.digest, payload: { saved: true } })),
  status: vi.fn(async (input) => ({ status: 'COMMITTED', digest: input.digest, payload: { saved: true } })),
})

async function authenticatedHandler(
  options: {
    tickets?: InMemorySyncAuthTicketStore
    leases?: SyncCommandLeaseRegistry
    socket?: FakeSocket
    authorization?: SyncLiveAuthorizationAdapter
    backend?: SyncCommandBackendAdapter
    deviceId?: string
    resumeSequence?: number
    backendTimeoutMs?: number
    maxBufferedBytes?: number
    isEnabled?: () => boolean
    socketBudget?: SyncSocketBudget
    ownerId?: string
    leaseRenewIntervalMs?: number
    socketBudgetRenewIntervalMs?: number
  } = {},
): Promise<{ handler: SyncCommandHandler; socket: FakeSocket; tickets: InMemorySyncAuthTicketStore }> {
  const tickets = options.tickets ?? new InMemorySyncAuthTicketStore()
  const socket = options.socket ?? new FakeSocket()
  const deviceId = options.deviceId ?? 'device-1'
  const issued = await tickets.issue({
    userUuid: 'user-1',
    sessionUuid: 'session-1',
    deviceId,
    authorization: 'Bearer session-token',
  })
  const handler = new SyncCommandHandler({
    socket,
    ownerId: options.ownerId ?? `owner-${Math.random()}`,
    tickets,
    leases: options.leases ?? new InMemorySyncCommandLeaseRegistry(),
    socketBudget: options.socketBudget ?? new InMemorySyncSocketBudget(),
    authorization: options.authorization ?? allowAuthorization(),
    backend: options.backend ?? committingBackend(),
    isEnabled: options.isEnabled ?? (() => true),
    backendTimeoutMs: options.backendTimeoutMs,
    maxBufferedBytes: options.maxBufferedBytes,
    leaseRenewIntervalMs: options.leaseRenewIntervalMs,
    socketBudgetRenewIntervalMs: options.socketBudgetRenewIntervalMs,
  })
  enqueue(handler, authFrame(issued.ticket, deviceId, options.resumeSequence))
  await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('AUTHENTICATED'))
  return { handler, socket, tickets }
}

describe('SyncCommandHandler', () => {
  it('rejects invalid distributed renewal intervals at construction', () => {
    const base = {
      socket: new FakeSocket(),
      ownerId: 'owner',
      tickets: new InMemorySyncAuthTicketStore(),
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
    }
    expect(() => new SyncCommandHandler({ ...base, leaseRenewIntervalMs: 0 })).toThrow(/renewal interval/i)
    expect(() => new SyncCommandHandler({ ...base, socketBudgetRenewIntervalMs: 1.5 })).toThrow(/renewal interval/i)
  })

  it('enforces the first-frame auth deadline', async () => {
    const socket = new FakeSocket()
    const metrics = { increment: vi.fn() }
    new SyncCommandHandler({
      socket,
      ownerId: 'owner',
      tickets: new InMemorySyncAuthTicketStore(),
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
      authDeadlineMs: 5,
      metrics,
    })

    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1008))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'AUTH_TIMEOUT', retryable: false })
    expect(metrics.increment).toHaveBeenCalledWith('auth', 'timeout')
  })

  it('rejects non-AUTH first frames, malformed frames, and disabled adapters', async () => {
    const build = (isEnabled = true, authorization = allowAuthorization()) => {
      const socket = new FakeSocket()
      const handler = new SyncCommandHandler({
        socket,
        ownerId: 'owner',
        tickets: new InMemorySyncAuthTicketStore(),
        leases: new InMemorySyncCommandLeaseRegistry(),
        socketBudget: new InMemorySyncSocketBudget(),
        authorization,
        backend: committingBackend(),
        isEnabled: () => isEnabled,
      })
      return { socket, handler }
    }

    const authRequired = build()
    enqueue(authRequired.handler, pingFrame(0))
    await vi.waitFor(() =>
      expect(authRequired.socket.frames.at(-1)?.payload).toEqual({ code: 'AUTH_REQUIRED', retryable: false }),
    )

    const malformed = build()
    malformed.handler.enqueue('{', 1)
    await vi.waitFor(() =>
      expect(malformed.socket.frames.at(-1)?.payload).toEqual({ code: 'MALFORMED_JSON', retryable: false }),
    )

    const disabled = build(false)
    enqueue(disabled.handler, pingFrame(0))
    await vi.waitFor(() => expect(disabled.socket.closes.at(-1)?.code).toBe(1012))
    expect(disabled.socket.frames.at(-1)?.payload).toEqual({ code: 'SYNC_DISABLED', retryable: true })

    const adapterNotReady = build(true, { ready: () => false, authorize: vi.fn() })
    enqueue(adapterNotReady.handler, pingFrame(0))
    await vi.waitFor(() => expect(adapterNotReady.socket.closes.at(-1)?.code).toBe(1012))
  })

  it('fails over with a retryable signal when shared authentication state disappears mid-frame', async () => {
    const socket = new FakeSocket()
    const handler = new SyncCommandHandler({
      socket,
      ownerId: 'owner',
      tickets: {
        distribution: 'shared',
        ready: () => true,
        issue: vi.fn(async () => {
          throw new Error('not used')
        }),
        consume: vi.fn(async () => {
          throw new Error('redis outage')
        }),
      },
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
    })
    enqueue(handler, authFrame('x'.repeat(43)))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1013))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'SYNC_DISABLED', retryable: true })
    await handler.stop()
  })

  it('bounds queued input and ignores work after closure', async () => {
    const socket = new FakeSocket()
    const handler = new SyncCommandHandler({
      socket,
      ownerId: 'owner',
      tickets: new InMemorySyncAuthTicketStore(),
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
      maxQueuedFrames: 1,
    })
    handler.enqueue('{}', -1)
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1013))
    const frameCount = socket.frames.length
    handler.enqueue('{}', 2)
    handler.disconnect()
    expect(socket.frames).toHaveLength(frameCount)
  })

  it('authenticates once and emits the frozen ACCEPTED then COMMITTED payloads', async () => {
    const { handler, socket } = await authenticatedHandler()
    const command = commandFrame('command-1', 1)
    enqueue(handler, command)

    await vi.waitFor(() => expect(socket.frames.map((frame) => frame.type)).toContain('COMMITTED'))
    expect(socket.frames[0].payload).toEqual({ capability: 'ws-sync', protocolVersion: 1, nextClientSequence: 1 })
    expect(socket.frames[1]).toMatchObject({
      type: 'ACCEPTED',
      digest: command.digest,
      payload: { status: 'ACCEPTED' },
    })
    expect(socket.frames[2]).toMatchObject({
      type: 'COMMITTED',
      digest: command.digest,
      payload: { status: 'COMMITTED', result: { saved: true } },
    })
    handler.disconnect()
  })

  it('consumes a ticket atomically and rejects replay on another replica', async () => {
    const tickets = new InMemorySyncAuthTicketStore()
    const issued = await tickets.issue({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' })
    const build = (socket: FakeSocket, ownerId: string) =>
      new SyncCommandHandler({
        socket,
        ownerId,
        tickets,
        leases: new InMemorySyncCommandLeaseRegistry(),
        socketBudget: new InMemorySyncSocketBudget(),
        authorization: allowAuthorization(),
        backend: committingBackend(),
        isEnabled: () => true,
      })
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const first = build(firstSocket, 'replica-1')
    const second = build(secondSocket, 'replica-2')

    enqueue(first, authFrame(issued.ticket))
    await vi.waitFor(() => expect(firstSocket.frames.at(-1)?.type).toBe('AUTHENTICATED'))
    enqueue(second, authFrame(issued.ticket))
    await vi.waitFor(() => expect(secondSocket.closes).toHaveLength(1))
    expect(secondSocket.frames.at(-1)?.payload).toEqual({ code: 'AUTH_REJECTED', retryable: false })
    first.disconnect()
  })

  it('rejects an expired ticket', async () => {
    let now = 1_000
    const tickets = new InMemorySyncAuthTicketStore(() => now)
    const issued = await tickets.issue({ userUuid: 'user-1', sessionUuid: 'session-1', deviceId: 'device-1' }, 1_000)
    now += 1_001
    const socket = new FakeSocket()
    const handler = new SyncCommandHandler({
      socket,
      ownerId: 'owner',
      tickets,
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
    })
    enqueue(handler, authFrame(issued.ticket))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1008))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'AUTH_REJECTED', retryable: false })
  })

  it('fails closed when live authorization becomes stale before a command', async () => {
    const backend = committingBackend()
    const authorization: SyncLiveAuthorizationAdapter = {
      ready: () => true,
      authorize: vi.fn(async () => ({ authorized: false, code: 'SESSION_REVOKED' })),
    }
    const { handler, socket } = await authenticatedHandler({ authorization, backend })
    enqueue(handler, commandFrame('revoked-command', 1))

    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'NOT_AUTHORIZED', retryable: false })
    expect(backend.execute).not.toHaveBeenCalled()
    handler.disconnect()
  })

  it('repeats full authorization immediately before execute and honors a just-revoked policy', async () => {
    const backend = committingBackend()
    const authorization: SyncLiveAuthorizationAdapter = {
      ready: () => true,
      authorize: vi
        .fn<SyncLiveAuthorizationAdapter['authorize']>()
        .mockResolvedValueOnce({ authorized: true })
        .mockResolvedValueOnce({ authorized: false, code: 'SESSION_REVOKED' }),
    }
    const { handler, socket } = await authenticatedHandler({ authorization, backend })
    enqueue(handler, commandFrame('revoked-after-accept', 1))

    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(socket.frames.map((frame) => frame.type)).toEqual(['AUTHENTICATED', 'ACCEPTED', 'ERROR'])
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'NOT_AUTHORIZED', retryable: false })
    expect(authorization.authorize).toHaveBeenCalledTimes(2)
    expect(backend.execute).not.toHaveBeenCalled()
    await handler.stop()
  })

  it.each([
    ['READ_ONLY', 'READ_ONLY'],
    ['CONTENT_LIMIT', 'CONTENT_LIMIT'],
    ['SHARED_VAULT_FORBIDDEN', 'NOT_AUTHORIZED'],
  ] as const)('maps %s authorization without leaking policy detail', async (authorizationCode, publicCode) => {
    const authorization: SyncLiveAuthorizationAdapter = {
      ready: () => true,
      authorize: vi.fn(async () => ({ authorized: false, code: authorizationCode })),
    }
    const { handler, socket } = await authenticatedHandler({ authorization })
    enqueue(handler, commandFrame(`denied-${authorizationCode}`, 1))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: publicCode, retryable: false })
    handler.disconnect()
  })

  it('enforces exact client order and resumes server sequence', async () => {
    const { handler, socket } = await authenticatedHandler({ resumeSequence: 7 })
    expect(socket.frames[0].sequence).toBe(8)
    enqueue(handler, pingFrame(2))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1008))
    expect(socket.frames.at(-1)?.payload).toEqual({ code: 'OUT_OF_ORDER', retryable: false })
  })

  it('returns reconnect STATUS using the same digest and next server sequence', async () => {
    const body = { api: '20200115', items: [] }
    const digest = digestSyncCommandBody(body)
    const { handler, socket } = await authenticatedHandler({ resumeSequence: 40 })
    enqueue(handler, statusFrame('command-1', 1, digest))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('STATUS'))
    expect(socket.frames.at(-1)).toMatchObject({
      sequence: 42,
      digest,
      payload: { status: 'COMMITTED', result: { saved: true } },
    })
    handler.disconnect()
  })

  it('authorizes STATUS live and rejects a backend digest conflict', async () => {
    const digest = 'a'.repeat(64)
    const deniedAuthorization: SyncLiveAuthorizationAdapter = {
      ready: () => true,
      authorize: vi.fn(async () => ({ authorized: false, code: 'SESSION_REVOKED' })),
    }
    const denied = await authenticatedHandler({ authorization: deniedAuthorization })
    enqueue(denied.handler, statusFrame('status-denied', 1, digest))
    await vi.waitFor(() => expect(denied.socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(denied.socket.frames.at(-1)?.payload).toEqual({ code: 'NOT_AUTHORIZED', retryable: false })

    const conflictingBackend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async (input) => ({ digest: input.digest })),
      status: vi.fn(async () => ({ status: 'COMMITTED', digest: 'b'.repeat(64) })),
    }
    const conflicting = await authenticatedHandler({ backend: conflictingBackend })
    enqueue(conflicting.handler, statusFrame('status-conflict', 1, digest))
    await vi.waitFor(() => expect(conflicting.socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(conflicting.socket.frames.at(-1)?.payload).toEqual({ code: 'COMMAND_ID_CONFLICT', retryable: false })
    denied.handler.disconnect()
    conflicting.handler.disconnect()
  })

  it('returns backend errors for failed STATUS without closing the authenticated socket', async () => {
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async (input) => ({ digest: input.digest })),
      status: vi.fn(async () => Promise.reject(new Error('status unavailable'))),
    }
    const { handler, socket } = await authenticatedHandler({ backend })
    enqueue(handler, statusFrame('status-error', 1, 'a'.repeat(64)))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'BACKEND_ERROR', retryable: true }))
    expect(socket.closes).toHaveLength(0)
    handler.disconnect()
  })

  it('allows only one in-flight command per user/device across handlers', async () => {
    const tickets = new InMemorySyncAuthTicketStore()
    const leases = new InMemorySyncCommandLeaseRegistry()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async (input) => {
        await gate
        return { digest: input.digest }
      }),
      status: vi.fn(async (input) => ({ status: 'UNKNOWN', digest: input.digest })),
    }
    const first = await authenticatedHandler({ tickets, leases, backend })
    const second = await authenticatedHandler({ tickets, leases, backend })
    enqueue(first.handler, commandFrame('command-A', 1))
    await vi.waitFor(() => expect(first.socket.frames.at(-1)?.type).toBe('ACCEPTED'))
    enqueue(second.handler, commandFrame('command-B', 1))
    await vi.waitFor(() => expect(second.socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(second.socket.frames.at(-1)?.payload).toEqual({ code: 'BUSY', retryable: true })
    release()
    await vi.waitFor(() => expect(first.socket.frames.at(-1)?.type).toBe('COMMITTED'))
    first.handler.disconnect()
    second.handler.disconnect()
  })

  it('renews an active distributed lease and releases it after commit', async () => {
    const leases = new InMemorySyncCommandLeaseRegistry()
    const renew = vi.spyOn(leases, 'renew')
    const releaseLease = vi.fn<() => void>()
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(
        async (input) =>
          new Promise((resolve) => {
            releaseLease.mockImplementation(() => resolve({ digest: input.digest }))
          }),
      ),
      status: vi.fn(async (input) => ({ status: 'UNKNOWN', digest: input.digest })),
    }
    const active = await authenticatedHandler({ leases, backend, leaseRenewIntervalMs: 5 })
    enqueue(active.handler, commandFrame('renewed-command', 1))
    await vi.waitFor(() => expect(active.socket.frames.at(-1)?.type).toBe('ACCEPTED'))
    await vi.waitFor(() => expect(renew).toHaveBeenCalled())
    releaseLease()
    await vi.waitFor(() => expect(active.socket.frames.at(-1)?.type).toBe('COMMITTED'))
    await expect(
      leases.acquire({
        userUuid: 'user-1',
        deviceId: 'device-1',
        commandId: 'next-command',
        digest: 'a'.repeat(64),
        ownerId: 'next-owner',
      }),
    ).resolves.toEqual({ acquired: true })
    await active.handler.stop()
  })

  it('aborts durable execution and returns retryable LEASE_LOST when renewal loses ownership', async () => {
    const backing = new InMemorySyncCommandLeaseRegistry()
    const leases: SyncCommandLeaseRegistry = {
      distribution: 'shared',
      ready: () => true,
      acquire: (input, signal) => backing.acquire(input, signal),
      renew: vi.fn(async () => false),
      release: (input, signal) => backing.release(input, signal),
    }
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(
        async (_input, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
          ),
      ),
      status: vi.fn(async (input) => ({ status: 'UNKNOWN', digest: input.digest })),
    }
    const active = await authenticatedHandler({ leases, backend, leaseRenewIntervalMs: 5 })
    enqueue(active.handler, commandFrame('lost-command', 1))
    await vi.waitFor(() =>
      expect(active.socket.frames.at(-1)?.payload).toEqual({ code: 'LEASE_LOST', retryable: true }),
    )
    expect(leases.renew).toHaveBeenCalled()
    await active.handler.stop()
  })

  it('times out an unresponsive backend, returns a retryable error, and releases the lease', async () => {
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(() => new Promise(() => undefined)),
      status: vi.fn(async (input) => ({ status: 'UNKNOWN', digest: input.digest })),
    }
    const leases = new InMemorySyncCommandLeaseRegistry()
    const { handler, socket } = await authenticatedHandler({ backend, leases, backendTimeoutMs: 5 })
    enqueue(handler, commandFrame('slow-command', 1))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'BACKEND_TIMEOUT', retryable: true }))
    await expect(
      leases.acquire({
        userUuid: 'user-1',
        deviceId: 'device-1',
        commandId: 'next-command',
        digest: 'a'.repeat(64),
        ownerId: 'new-owner',
      }),
    ).resolves.toEqual({ acquired: true })
    handler.disconnect()
  })

  it('detects a committed digest conflict and supports a committed response without result data', async () => {
    const conflictingBackend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async () => ({ digest: 'b'.repeat(64) })),
      status: vi.fn(async (input) => ({ status: 'UNKNOWN', digest: input.digest })),
    }
    const conflict = await authenticatedHandler({ backend: conflictingBackend })
    enqueue(conflict.handler, commandFrame('command-conflict', 1))
    await vi.waitFor(() => expect(conflict.socket.frames.at(-1)?.type).toBe('ERROR'))
    expect(conflict.socket.frames.at(-1)?.payload).toEqual({ code: 'COMMAND_ID_CONFLICT', retryable: false })

    const noResultBackend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async (input) => ({ digest: input.digest })),
      status: vi.fn(async (input) => ({ status: 'UNKNOWN', digest: input.digest })),
    }
    const noResult = await authenticatedHandler({ backend: noResultBackend })
    enqueue(noResult.handler, commandFrame('command-no-result', 1))
    await vi.waitFor(() => expect(noResult.socket.frames.at(-1)?.type).toBe('COMMITTED'))
    expect(noResult.socket.frames.at(-1)?.payload).toEqual({ status: 'COMMITTED' })
    conflict.handler.disconnect()
    noResult.handler.disconnect()
  })

  it('closes a slow consumer without retaining more egress', async () => {
    const { handler, socket } = await authenticatedHandler()
    const frameCount = socket.frames.length
    socket.bufferedAmount = MAX_SYNC_BUFFERED_BYTES
    enqueue(handler, pingFrame(1))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1013))
    expect(socket.frames).toHaveLength(frameCount)
  })

  it('never enqueues an oversized result and emits only a small retryable fallback signal', async () => {
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn(async (input) => ({ digest: input.digest, payload: { huge: 'x'.repeat(MAX_SYNC_FRAME_BYTES) } })),
      status: vi.fn(async (input) => ({ status: 'UNKNOWN', digest: input.digest })),
    }
    const { handler, socket } = await authenticatedHandler({ backend })
    enqueue(handler, commandFrame('large-result', 1))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.payload).toEqual({ code: 'RESULT_TOO_LARGE', retryable: true }))
    expect(socket.frames.some((frame) => frame.type === 'COMMITTED')).toBe(false)
    expect(
      socket.frames.every((frame) => Buffer.byteLength(JSON.stringify(frame), 'utf8') <= MAX_SYNC_FRAME_BYTES),
    ).toBe(true)
    await handler.stop()
  })

  it('uses exact predicted bufferedAmount accounting at the boundary', async () => {
    const { handler, socket } = await authenticatedHandler()
    const firstPong = JSON.stringify(
      createSyncServerFrame({
        type: 'PONG',
        requestId: 'ping-request',
        commandId: 'ping-command',
        sequence: 2,
        payload: {},
      }),
    )
    socket.bufferedAmount = MAX_SYNC_BUFFERED_BYTES - Buffer.byteLength(firstPong, 'utf8')
    enqueue(handler, pingFrame(1))
    await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('PONG'))

    const frameCount = socket.frames.length
    const secondPong = JSON.stringify(
      createSyncServerFrame({
        type: 'PONG',
        requestId: 'ping-request',
        commandId: 'ping-command',
        sequence: 3,
        payload: {},
      }),
    )
    socket.bufferedAmount = MAX_SYNC_BUFFERED_BYTES - Buffer.byteLength(secondPong, 'utf8') + 1
    enqueue(handler, pingFrame(2))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1013))
    expect(socket.frames).toHaveLength(frameCount)
  })

  it('enforces the authenticated per-user socket budget and fully releases it on stop', async () => {
    const budget = new InMemorySyncSocketBudget(1)
    const first = await authenticatedHandler({ socketBudget: budget, ownerId: 'socket-owner-1' })

    const tickets = new InMemorySyncAuthTicketStore()
    const issued = await tickets.issue({ userUuid: 'user-1', sessionUuid: 'session-2', deviceId: 'device-2' })
    const secondSocket = new FakeSocket()
    const second = new SyncCommandHandler({
      socket: secondSocket,
      ownerId: 'socket-owner-2',
      tickets,
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: budget,
      authorization: allowAuthorization(),
      backend: committingBackend(),
      isEnabled: () => true,
    })
    enqueue(second, authFrame(issued.ticket, 'device-2'))
    await vi.waitFor(() =>
      expect(secondSocket.frames.at(-1)?.payload).toEqual({ code: 'SOCKET_LIMIT', retryable: true }),
    )

    await first.handler.stop()
    const third = await authenticatedHandler({ socketBudget: budget, ownerId: 'socket-owner-3' })
    expect(third.socket.frames.at(-1)?.type).toBe('AUTHENTICATED')
    await Promise.all([second.stop(), third.handler.stop()])
  })

  it('fails closed when the fleet socket reservation cannot be renewed', async () => {
    const release = vi.fn(async () => undefined)
    const budget: SyncSocketBudget = {
      distribution: 'shared',
      ready: () => true,
      acquire: vi.fn(async () => true),
      renew: vi.fn(async () => false),
      release,
    }
    const active = await authenticatedHandler({
      socketBudget: budget,
      ownerId: 'expiring-socket',
      socketBudgetRenewIntervalMs: 200,
    })
    await vi.waitFor(() =>
      expect(active.socket.frames.at(-1)?.payload).toEqual({ code: 'SOCKET_BUDGET_LOST', retryable: true }),
    )
    expect(active.socket.closes.at(-1)?.code).toBe(1013)
    await active.handler.stop()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('closes safely when a bounded resume sequence exhausts the server sequence space', async () => {
    const { handler, socket } = await authenticatedHandler({ resumeSequence: MAX_SYNC_RESUME_SEQUENCE })
    expect(socket.frames.at(-1)?.sequence).toBe(MAX_SYNC_RESUME_SEQUENCE + 1)
    const frameCount = socket.frames.length
    enqueue(handler, pingFrame(1))
    await vi.waitFor(() => expect(socket.closes.at(-1)?.code).toBe(1008))
    expect(socket.frames).toHaveLength(frameCount)
  })
})
