import type { AccountSyncTransportRequest } from '@standardnotes/services'
import type { HttpResponse, RawSyncResponse } from '@standardnotes/snjs'
import { MainToSyncWorkerMessage, SyncWorkerToMainMessage } from './syncTransportProtocol'
import {
  deriveOpaqueSyncSessionScope,
  SyncTransportControlPlane,
  WebSocketSyncTransport,
} from './WebSocketSyncTransport'

class FakeWorker {
  onmessage: ((event: MessageEvent<SyncWorkerToMainMessage>) => void) | null = null
  onerror: (() => void) | null = null
  posts: MainToSyncWorkerMessage[] = []
  terminated = false

  postMessage(message: MainToSyncWorkerMessage): void {
    this.posts.push(message)
  }

  emit(message: SyncWorkerToMainMessage): void {
    this.onmessage?.({ data: message } as MessageEvent<SyncWorkerToMainMessage>)
  }

  fail(): void {
    this.onerror?.()
  }

  terminate(): void {
    this.terminated = true
  }
}

const request = (suffix = 'one'): AccountSyncTransportRequest => ({
  api: '20240226',
  items: [{ uuid: suffix, content: `cipher-${suffix}` }],
  sync_token: `token-${suffix}`,
  limit: 150,
})

const SESSION_A = `sync-session-v1:${'a'.repeat(64)}`
const SESSION_B = `sync-session-v1:${'b'.repeat(64)}`

const response = (token = 'next'): HttpResponse<RawSyncResponse> =>
  ({ status: 200, data: { retrieved_items: [], saved_items: [], sync_token: token } }) as never

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('WebSocketSyncTransport', () => {
  const configuredUrl = 'wss://sync.example.test'
  let worker: FakeWorker
  let controlPlane: jest.Mocked<SyncTransportControlPlane>

  beforeEach(() => {
    worker = new FakeWorker()
    controlPlane = {
      getCapabilities: jest.fn().mockResolvedValue({
        capabilities: [{ id: 'ws-sync', version: 1, endpoint: '/sockets/sync' }],
      }),
      createTicket: jest.fn().mockResolvedValue({
        ticket: 'ticket'.repeat(8),
        expiresAt: Date.now() + 30_000,
        endpoint: '/sockets/sync',
        capability: 'ws-sync',
        version: 1,
      }),
    }
  })

  const createTransport = (overrides: Partial<ConstructorParameters<typeof WebSocketSyncTransport>[0]> = {}) =>
    new WebSocketSyncTransport({
      controlPlane,
      getConfiguredWebSocketUrl: () => configuredUrl,
      getAuthenticatedSessionScope: async () => SESSION_A,
      deviceId: 'device-1',
      workerFactory: () => worker,
      environment: { hasWorker: true, hasWebSocket: true, hasIndexedDb: true },
      isHttpOnly: () => false,
      ...overrides,
    })

  it('keeps the opaque scope stable across token refresh and rotates it for a new session or account', async () => {
    const subtle = {
      digest: jest.fn(async (_algorithm: string, input: Uint8Array) => {
        let hash = 0x811c9dc5
        for (const byte of input) {
          hash = Math.imul(hash ^ byte, 0x01000193)
        }
        const output = new Uint8Array(32)
        for (let index = 0; index < output.length; index += 1) {
          output[index] = (hash >>> ((index % 4) * 8)) & 0xff
        }
        return output.buffer
      }),
    } as unknown as SubtleCrypto
    const base = {
      applicationIdentifier: 'workspace-1',
      host: 'https://notes.example.test',
      userUuid: 'user-a',
      accessToken: '2:session-a:secret-before-refresh',
    }
    const beforeRefresh = await deriveOpaqueSyncSessionScope(base, subtle)
    const afterRefresh = await deriveOpaqueSyncSessionScope(
      {
        ...base,
        accessToken: '2:session-a:secret-after-refresh',
      },
      subtle,
    )
    const newSession = await deriveOpaqueSyncSessionScope({ ...base, accessToken: '2:session-b:secret' }, subtle)
    const otherAccount = await deriveOpaqueSyncSessionScope({ ...base, userUuid: 'user-b' }, subtle)

    expect(afterRefresh).toBe(beforeRefresh)
    expect(newSession).not.toBe(beforeRefresh)
    expect(otherAccount).not.toBe(beforeRefresh)
    expect(beforeRefresh).toMatch(/^sync-session-v1:[a-f0-9]{64}$/u)
    expect(beforeRefresh).not.toContain('user-a')
    expect(beforeRefresh).not.toContain('session-a')
  })

  it('negotiates capability/ticket, returns a committed result, and acknowledges only after local checkpoint', async () => {
    const transport = createTransport()
    const fallback = jest.fn().mockResolvedValue(response('http'))
    const execution = transport.execute(request(), fallback)
    await flush()
    const execute = worker.posts.find((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >

    worker.emit({ type: 'NEED_TICKET', clientRequestId: execute.clientRequestId, reconnect: false })
    await flush()
    const connect = worker.posts.find((message) => message.type === 'CONNECT') as Extract<
      MainToSyncWorkerMessage,
      { type: 'CONNECT' }
    >
    expect(connect.authorization).toEqual(
      expect.objectContaining({
        endpoint: 'wss://sync.example.test/sockets/sync',
        deviceId: 'device-1',
        ticket: 'ticket'.repeat(8),
      }),
    )
    expect(controlPlane.createTicket).toHaveBeenCalledWith('device-1')

    worker.emit({
      type: 'COMMAND_PERSISTED',
      clientRequestId: execute.clientRequestId,
      body: request(),
      command: { id: 'command-1', digest: 'a'.repeat(64), sequence: 1 },
    })
    worker.emit({
      type: 'RESULT',
      clientRequestId: execute.clientRequestId,
      commandId: 'command-1',
      result: { retrieved_items: [], saved_items: [], sync_token: 'ws-next' },
    })

    const result = await execution
    expect(result.response).toEqual(response('ws-next'))
    expect(fallback).not.toHaveBeenCalled()
    expect(worker.posts).not.toContainEqual({ type: 'CHECKPOINT_DURABLE', commandId: 'command-1' })

    const checkpoint = result.markCheckpointDurable?.() as Promise<void>
    await flush()
    const checkpointMessage = worker.posts.find((message) => message.type === 'CHECKPOINT_DURABLE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'CHECKPOINT_DURABLE' }
    >
    expect(checkpointMessage).toEqual(
      expect.objectContaining({ type: 'CHECKPOINT_DURABLE', sessionScope: SESSION_A, commandId: 'command-1' }),
    )
    worker.emit({
      type: 'CHECKPOINT_CLEARED',
      requestId: checkpointMessage.requestId,
      sessionScope: SESSION_A,
      commandId: 'command-1',
    })
    await checkpoint
  })

  it('forwards a stable action context to the worker unchanged', async () => {
    const transport = createTransport()
    const fallback = jest.fn().mockResolvedValue(response('http'))
    const execution = transport.execute(request('folder'), fallback, {
      operationId: 'folder-action-1',
      operationIndex: 2,
    })
    await flush()
    const execute = worker.posts.find((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >

    expect(execute.context).toEqual({ operationId: 'folder-action-1', operationIndex: 2 })

    worker.emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: execute.clientRequestId,
      reason: 'worker-error',
      body: request('folder'),
    })
    await expect(execution).resolves.toEqual({ response: response('http') })
  })

  it('reuses one healthy negotiated worker socket without repeating ticket or capability requests', async () => {
    const transport = createTransport()
    const fallback = jest.fn().mockResolvedValue(response('http'))

    const first = transport.execute(request('first'), fallback)
    await flush()
    let executePosts = worker.posts.filter((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >[]
    worker.emit({ type: 'NEED_TICKET', clientRequestId: executePosts[0].clientRequestId, reconnect: false })
    await flush()
    worker.emit({
      type: 'NEGOTIATED',
      sessionScope: SESSION_A,
      protocolVersion: 1,
      endpoint: 'wss://sync.example.test/sockets/sync',
      operations: ['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION'],
    })
    worker.emit({
      type: 'COMMAND_PERSISTED',
      clientRequestId: executePosts[0].clientRequestId,
      body: request('first'),
      command: { id: 'command-first', digest: 'a'.repeat(64), sequence: 1 },
    })
    worker.emit({
      type: 'RESULT',
      clientRequestId: executePosts[0].clientRequestId,
      commandId: 'command-first',
      result: { retrieved_items: [], saved_items: [], sync_token: 'ws-first' },
    })
    await first

    const second = transport.execute(request('second'), fallback)
    await flush()
    executePosts = worker.posts.filter((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >[]
    expect(executePosts).toHaveLength(2)
    worker.emit({
      type: 'COMMAND_PERSISTED',
      clientRequestId: executePosts[1].clientRequestId,
      body: request('second'),
      command: { id: 'command-second', digest: 'b'.repeat(64), sequence: 2 },
    })
    worker.emit({
      type: 'RESULT',
      clientRequestId: executePosts[1].clientRequestId,
      commandId: 'command-second',
      result: { retrieved_items: [], saved_items: [], sync_token: 'ws-second' },
    })
    await second

    expect(controlPlane.createTicket).toHaveBeenCalledTimes(1)
    expect(controlPlane.getCapabilities).not.toHaveBeenCalled()
    expect(fallback).not.toHaveBeenCalled()
  })

  it('replays an uncertain accepted command over HTTP with the exact same metadata', async () => {
    const transport = createTransport()
    const fallback = jest.fn().mockResolvedValue(response('replayed'))
    const originalBody = request('accepted')
    const execution = transport.execute(originalBody, fallback)
    await flush()
    const execute = worker.posts.find((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
    const command = { id: 'command-accepted', digest: 'b'.repeat(64), sequence: 7 }
    worker.emit({ type: 'COMMAND_PERSISTED', clientRequestId: execute.clientRequestId, body: originalBody, command })
    worker.emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: execute.clientRequestId,
      reason: 'reconnect-gap',
      body: originalBody,
      command,
    })

    const result = await execution
    expect(fallback).toHaveBeenCalledWith(originalBody, command)
    const checkpoint = result.markCheckpointDurable?.() as Promise<void>
    await flush()
    const checkpointMessage = worker.posts.find((message) => message.type === 'CHECKPOINT_DURABLE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'CHECKPOINT_DURABLE' }
    >
    expect(checkpointMessage).toEqual(
      expect.objectContaining({ type: 'CHECKPOINT_DURABLE', sessionScope: SESSION_A, commandId: command.id }),
    )
    worker.emit({
      type: 'CHECKPOINT_CLEARED',
      requestId: checkpointMessage.requestId,
      sessionScope: SESSION_A,
      commandId: command.id,
    })
    await checkpoint
  })

  it('claims an uncertain command once when timeout and close emit duplicate HTTP fallback signals', async () => {
    const transport = createTransport()
    let resolveFallback: ((value: HttpResponse<RawSyncResponse>) => void) | undefined
    const fallback = jest.fn(
      () =>
        new Promise<HttpResponse<RawSyncResponse>>((resolve) => {
          resolveFallback = resolve
        }),
    )
    const originalBody = request('folder-create')
    const execution = transport.execute(originalBody, fallback)
    await flush()
    const execute = worker.posts.find((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
    const command = { id: 'command-folder-create', digest: 'c'.repeat(64), sequence: 11 }
    worker.emit({ type: 'COMMAND_PERSISTED', clientRequestId: execute.clientRequestId, body: originalBody, command })

    const duplicateFallback = {
      type: 'HTTP_FALLBACK' as const,
      clientRequestId: execute.clientRequestId,
      reason: 'reconnect-gap' as const,
      body: originalBody,
      command,
    }
    worker.emit(duplicateFallback)
    worker.emit(duplicateFallback)
    await flush()

    expect(fallback).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledWith(originalBody, command)
    resolveFallback?.(response('replayed-once'))
    await expect(execution).resolves.toEqual(expect.objectContaining({ response: response('replayed-once') }))

    const result = await execution
    const firstCheckpoint = result.markCheckpointDurable?.() as Promise<void>
    const secondCheckpoint = result.markCheckpointDurable?.() as Promise<void>
    await flush()
    const checkpointMessages = worker.posts.filter(
      (message): message is Extract<MainToSyncWorkerMessage, { type: 'CHECKPOINT_DURABLE' }> =>
        message.type === 'CHECKPOINT_DURABLE' && message.commandId === command.id,
    )
    expect(checkpointMessages).toHaveLength(1)
    for (const checkpoint of checkpointMessages) {
      worker.emit({
        type: 'CHECKPOINT_CLEARED',
        requestId: checkpoint.requestId,
        sessionScope: SESSION_A,
        commandId: command.id,
      })
    }
    await Promise.all([firstCheckpoint, secondCheckpoint])
    expect(fallback).toHaveBeenCalledTimes(1)
  })

  it('never replays a persisted command over HTTP when the worker crashes at the dispatch boundary', async () => {
    const transport = createTransport()
    const fallback = jest.fn().mockResolvedValue(response('must-not-replay'))
    const originalBody = request('worker-crash')
    const execution = transport.execute(originalBody, fallback, {
      operationId: 'worker-crash-operation',
      operationIndex: 0,
    })
    await flush()
    const execute = worker.posts.find((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
    const command = {
      id: 'worker-crash-operation',
      operationId: 'worker-crash-operation',
      digest: 'd'.repeat(64),
      sequence: 1,
    }
    worker.emit({ type: 'COMMAND_PERSISTED', clientRequestId: execute.clientRequestId, body: originalBody, command })

    worker.fail()

    await expect(execution).rejects.toThrow('durable recovery is required')
    expect(fallback).not.toHaveBeenCalled()
  })

  it('returns recovered A under the recovery contract and only then executes fresh B', async () => {
    const transport = createTransport()
    const fallback = jest.fn().mockResolvedValue(response('http-recovered'))
    const recoveryPromise = transport.recoverPending(fallback)
    await flush()
    const recover = worker.posts.find((message) => message.type === 'RECOVER') as Extract<
      MainToSyncWorkerMessage,
      { type: 'RECOVER' }
    >
    expect(recover.sessionScope).toBe(SESSION_A)

    const command = { id: 'command-a', digest: 'd'.repeat(64), sequence: 3 }
    worker.emit({ type: 'COMMAND_PERSISTED', clientRequestId: recover.clientRequestId, body: request('a'), command })
    worker.emit({
      type: 'RESULT',
      clientRequestId: recover.clientRequestId,
      commandId: command.id,
      result: { retrieved_items: [], saved_items: [], sync_token: 'after-a' },
    })
    const recovered = await recoveryPromise
    expect(recovered?.request).toEqual(request('a'))
    expect(recovered?.response).toEqual(response('after-a'))

    const checkpoint = recovered?.markCheckpointDurable?.() as Promise<void>
    await flush()
    const checkpointMessage = worker.posts.find(
      (message) => message.type === 'CHECKPOINT_DURABLE' && message.commandId === command.id,
    ) as Extract<MainToSyncWorkerMessage, { type: 'CHECKPOINT_DURABLE' }>
    worker.emit({
      type: 'CHECKPOINT_CLEARED',
      requestId: checkpointMessage.requestId,
      sessionScope: SESSION_A,
      commandId: command.id,
    })
    await checkpoint

    const executePromise = transport.execute(request('b'), fallback)
    await flush()
    const executes = worker.posts.filter((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >[]
    expect(executes).toHaveLength(1)
    expect(executes[0]).toEqual(expect.objectContaining({ body: request('b'), sessionScope: SESSION_A }))
    worker.emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: executes[0].clientRequestId,
      reason: 'capability-unavailable',
      body: request('b'),
    })
    await executePromise
  })

  it('normalizes realistic values once and gives HTTP replay the exact WS body, id, and digest', async () => {
    const transport = createTransport()
    const fallback = jest.fn().mockResolvedValue(response('replayed-current'))
    const createdAt = new Date('2026-08-18T12:34:56.789Z')
    const originalBody = {
      api: '20240226',
      items: [
        {
          uuid: 'note-1',
          content: 'ciphertext',
          content_type: 'Note',
          deleted: false,
          created_at: createdAt,
          updated_at_timestamp: 1_787_056_496_789,
          auth_hash: undefined,
        },
      ],
      sync_token: 'token',
      cursor_token: undefined,
      limit: 150,
      shared_vault_uuids: ['vault-1'],
    } as unknown as AccountSyncTransportRequest
    const execution = transport.execute(originalBody, fallback)
    await flush()
    const execute = worker.posts.find((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
    expect(execute.body).toEqual({
      api: '20240226',
      items: [
        {
          uuid: 'note-1',
          content: 'ciphertext',
          content_type: 'Note',
          deleted: false,
          created_at: '2026-08-18T12:34:56.789Z',
          updated_at_timestamp: 1_787_056_496_789,
        },
      ],
      sync_token: 'token',
      limit: 150,
      shared_vault_uuids: ['vault-1'],
    })
    expect(originalBody.items[0]).toEqual(expect.objectContaining({ created_at: createdAt, auth_hash: undefined }))

    const command = {
      id: 'command-current',
      digest: 'ad38335b0a6e0a2ca113211f95ae13922faad67d066ba7b3ede390125f470f61',
      sequence: 8,
    }
    worker.emit({ type: 'COMMAND_PERSISTED', clientRequestId: execute.clientRequestId, body: execute.body, command })
    worker.emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: execute.clientRequestId,
      reason: 'reconnect-gap',
      body: execute.body,
      command,
    })

    await expect(execution).resolves.toEqual(expect.objectContaining({ response: response('replayed-current') }))
    expect(fallback).toHaveBeenCalledWith(execute.body, command)
  })

  it('serializes edits so only one command is in flight', async () => {
    const transport = createTransport()
    const fallback = jest.fn().mockResolvedValue(response())
    const first = transport.execute(request('first'), fallback)
    const second = transport.execute(request('second'), fallback)
    await flush()

    let executePosts = worker.posts.filter((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >[]
    expect(executePosts).toHaveLength(1)
    worker.emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: executePosts[0].clientRequestId,
      reason: 'capability-unavailable',
      body: request('first'),
    })
    await first
    await flush()

    executePosts = worker.posts.filter((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >[]
    expect(executePosts).toHaveLength(2)
    worker.emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: executePosts[1].clientRequestId,
      reason: 'capability-unavailable',
      body: request('second'),
    })
    await second
    expect(fallback.mock.calls.map(([syncBody]) => syncBody.items[0])).toEqual([
      { uuid: 'first', content: 'cipher-first' },
      { uuid: 'second', content: 'cipher-second' },
    ])
  })

  it('uses HTTP immediately in unsupported browsers or legacy http-only mode', async () => {
    const fallback = jest.fn().mockResolvedValue(response('http'))
    const unsupported = createTransport({
      environment: { hasWorker: false, hasWebSocket: true, hasIndexedDb: true },
    })
    await expect(unsupported.execute(request(), fallback)).resolves.toEqual({ response: response('http') })
    expect(worker.posts).toHaveLength(0)

    const httpOnly = createTransport({ isHttpOnly: () => true })
    await expect(httpOnly.execute(request('legacy'), fallback)).resolves.toEqual({ response: response('http') })
    expect(worker.posts).toHaveLength(0)
  })

  it('falls back when capability negotiation is absent and never exposes a session token to the worker', async () => {
    controlPlane.createTicket.mockResolvedValue(undefined)
    ;(controlPlane.getCapabilities as jest.Mock).mockResolvedValue({ capabilities: [] })
    const transport = createTransport()
    const fallback = jest.fn().mockResolvedValue(response('http'))
    const execution = transport.execute(request(), fallback)
    await flush()
    const execute = worker.posts.find((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
    worker.emit({ type: 'NEED_TICKET', clientRequestId: execute.clientRequestId, reconnect: false })
    await flush()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(worker.posts).toContainEqual({
      type: 'TICKET_UNAVAILABLE',
      clientRequestId: execute.clientRequestId,
      reason: 'capability-unavailable',
    })
    expect(JSON.stringify(worker.posts)).not.toContain('access-token')
    worker.emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: execute.clientRequestId,
      reason: 'capability-unavailable',
      body: request(),
    })
    await expect(execution).resolves.toEqual({ response: response('http') })

    const retry = transport.execute(request('retry'), fallback)
    await flush()
    const retryExecute = worker.posts.filter((message) => message.type === 'EXECUTE').at(-1) as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
    worker.emit({ type: 'NEED_TICKET', clientRequestId: retryExecute.clientRequestId, reconnect: false })
    await flush()
    expect(worker.posts).toContainEqual({
      type: 'TICKET_UNAVAILABLE',
      clientRequestId: retryExecute.clientRequestId,
      reason: 'capability-unavailable',
    })
    worker.emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: retryExecute.clientRequestId,
      reason: 'capability-unavailable',
      body: request('retry'),
    })
    await expect(retry).resolves.toEqual({ response: response('http') })
    expect(controlPlane.createTicket).toHaveBeenCalledTimes(1)
    expect(controlPlane.getCapabilities).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledTimes(2)
  })

  it('backs off ticket and capability probes when capability exists but ticket issuance is unavailable', async () => {
    controlPlane.createTicket.mockResolvedValue(undefined)
    const transport = createTransport()
    const fallback = jest.fn().mockResolvedValue(response('http'))

    for (const suffix of ['first', 'second']) {
      const execution = transport.execute(request(suffix), fallback)
      await flush()
      const execute = worker.posts.filter((message) => message.type === 'EXECUTE').at(-1) as Extract<
        MainToSyncWorkerMessage,
        { type: 'EXECUTE' }
      >
      worker.emit({ type: 'NEED_TICKET', clientRequestId: execute.clientRequestId, reconnect: false })
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(worker.posts).toContainEqual({
        type: 'TICKET_UNAVAILABLE',
        clientRequestId: execute.clientRequestId,
        reason: suffix === 'first' ? 'ticket-unavailable' : 'capability-unavailable',
      })
      worker.emit({
        type: 'HTTP_FALLBACK',
        clientRequestId: execute.clientRequestId,
        reason: 'capability-unavailable',
        body: request(suffix),
      })
      await execution
    }

    expect(controlPlane.createTicket).toHaveBeenCalledTimes(1)
    expect(controlPlane.getCapabilities).toHaveBeenCalledTimes(1)
    expect(fallback).toHaveBeenCalledTimes(2)
  })

  it('closes and rejects an active execution when the session is revoked', async () => {
    const transport = createTransport()
    const execution = transport.execute(request(), jest.fn())
    await flush()

    const revocation = transport.notifySessionRevoked()
    await flush()
    const revokeMessage = worker.posts.find((message) => message.type === 'SESSION_REVOKED') as Extract<
      MainToSyncWorkerMessage,
      { type: 'SESSION_REVOKED' }
    >
    worker.emit({
      type: 'SESSION_REVOKED_ACK',
      requestId: revokeMessage.requestId,
      sessionScope: SESSION_A,
    })
    await revocation

    await expect(execution).rejects.toThrow('revoked')
    expect(revokeMessage).toEqual(expect.objectContaining({ type: 'SESSION_REVOKED', sessionScope: SESSION_A }))
    expect(worker.terminated).toBe(true)
    expect(transport.transportState).toBe('HTTP_ONLY')
  })

  it('waits for revocation acknowledgement, terminates the old worker, and lazily creates a fresh session worker', async () => {
    const workers = [new FakeWorker(), new FakeWorker()]
    let workerIndex = 0
    let sessionScope = SESSION_A
    const transport = createTransport({
      getAuthenticatedSessionScope: async () => sessionScope,
      workerFactory: () => workers[workerIndex++],
    })
    const firstExecution = transport.execute(request('old-session'), jest.fn())
    const firstRejected = expect(firstExecution).rejects.toThrow('revoked')
    await flush()

    const revocation = transport.notifySessionRevoked()
    await flush()
    const revokeMessage = workers[0].posts.find((message) => message.type === 'SESSION_REVOKED') as Extract<
      MainToSyncWorkerMessage,
      { type: 'SESSION_REVOKED' }
    >
    expect(workers[0].terminated).toBe(false)
    workers[0].emit({
      type: 'SESSION_REVOKED_ACK',
      requestId: revokeMessage.requestId,
      sessionScope: SESSION_A,
    })
    await revocation
    await firstRejected
    expect(workers[0].terminated).toBe(true)

    sessionScope = SESSION_B
    const secondExecution = transport.execute(request('new-session'), jest.fn().mockResolvedValue(response('b')))
    await flush()
    const secondExecute = workers[1].posts.find((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
    expect(secondExecute).toEqual(expect.objectContaining({ sessionScope: SESSION_B, body: request('new-session') }))
    workers[1].emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: secondExecute.clientRequestId,
      reason: 'capability-unavailable',
      body: request('new-session'),
    })
    await expect(secondExecution).resolves.toEqual({ response: response('b') })
  })

  it('routes an authenticated read RPC through the worker and resolves its terminal response', async () => {
    const transport = createTransport()
    const result = transport.openAuthenticatedRpcStream({
      method: 'GET',
      path: '/v1/workflows/status',
      headers: { accept: 'application/json' },
    })
    await flush()
    const open = worker.posts.find((message) => message.type === 'OPEN_RPC') as Extract<
      MainToSyncWorkerMessage,
      { type: 'OPEN_RPC' }
    >

    expect(open.request).toEqual({
      method: 'GET',
      path: '/v1/workflows/status',
      headers: { accept: 'application/json' },
      deadlineMs: 30_000,
      initialCreditBytes: 256 * 1024,
      stream: false,
    })
    worker.emit({ type: 'RPC_ACCEPTED', clientRequestId: open.clientRequestId })
    worker.emit({
      type: 'RPC_RESPONSE',
      clientRequestId: open.clientRequestId,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { enabled: true },
      stream: false,
    })
    worker.emit({ type: 'RPC_END', clientRequestId: open.clientRequestId })

    await expect(result).resolves.toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { enabled: true },
      transport: 'websocket',
    })
  })

  it('acknowledges an invite batch only after authoritative application and checkpoint completion', async () => {
    const transport = createTransport()
    let finishApply!: (cursor: string) => void
    const applicationCheckpoint = new Promise<string>((resolve) => {
      finishApply = resolve
    })
    let finishReconcile!: () => void
    const authoritativeSnapshot = new Promise<void>((resolve) => {
      finishReconcile = resolve
    })
    const applyBatch = jest.fn(() => applicationCheckpoint)
    const reconcile = jest.fn(() => authoritativeSnapshot)
    const onError = jest.fn()

    const dispose = await transport.subscribeInviteEvents({
      cursor: 'cursor-0',
      limit: 1,
      applyBatch,
      reconcile,
      onError,
    })
    const subscribe = worker.posts.find((message) => message.type === 'SUBSCRIBE_INVITE_EVENTS') as Extract<
      MainToSyncWorkerMessage,
      { type: 'SUBSCRIBE_INVITE_EVENTS' }
    >
    const batch = {
      previousCursor: 'cursor-0',
      events: [
        {
          version: 1 as const,
          eventId: '11111111-1111-4111-8111-111111111111',
          streamPosition: 'cursor-1',
          kind: 'subscription-invite' as const,
          action: 'created' as const,
          inviteUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          occurredAt: 1,
        },
      ],
      nextCursor: 'cursor-1',
      hasMore: false,
    }

    worker.emit({ type: 'INVITE_BATCH', clientRequestId: subscribe.clientRequestId, batch })
    await flush()
    expect(applyBatch).toHaveBeenCalledWith(batch)
    expect(worker.posts.filter((message) => message.type === 'ACK_INVITE_EVENTS')).toHaveLength(0)

    finishApply('cursor-1')
    await flush()
    expect(worker.posts.filter((message) => message.type === 'ACK_INVITE_EVENTS')).toEqual([
      { type: 'ACK_INVITE_EVENTS', clientRequestId: subscribe.clientRequestId, cursor: 'cursor-1' },
    ])

    worker.emit({
      type: 'INVITE_RECONCILE',
      clientRequestId: subscribe.clientRequestId,
      reason: 'CURSOR_EXPIRED',
      cursor: 'cursor-tail',
    })
    await flush()
    expect(reconcile).toHaveBeenCalledWith({ reason: 'CURSOR_EXPIRED', cursor: 'cursor-tail' })
    expect(worker.posts.filter((message) => message.type === 'SUBSCRIBE_INVITE_EVENTS')).toHaveLength(1)

    finishReconcile()
    await flush()
    expect(worker.posts.filter((message) => message.type === 'SUBSCRIBE_INVITE_EVENTS')).toHaveLength(2)
    expect(worker.posts.at(-1)).toEqual({
      type: 'SUBSCRIBE_INVITE_EVENTS',
      clientRequestId: subscribe.clientRequestId,
      sessionScope: SESSION_A,
      cursor: 'cursor-tail',
      limit: 1,
    })
    expect(onError).not.toHaveBeenCalled()

    dispose()
    expect(worker.posts.at(-1)).toEqual({
      type: 'UNSUBSCRIBE_INVITE_EVENTS',
      clientRequestId: subscribe.clientRequestId,
    })
  })

  it('terminates an unacknowledged invite stream when application fails so lifecycle recovery can replay it', async () => {
    const transport = createTransport()
    const applyBatch = jest.fn().mockRejectedValue(new Error('checkpoint unavailable'))
    const onError = jest.fn()
    const dispose = await transport.subscribeInviteEvents({
      cursor: 'cursor-0',
      applyBatch,
      reconcile: jest.fn(),
      onError,
    })
    const subscribe = worker.posts.find((message) => message.type === 'SUBSCRIBE_INVITE_EVENTS') as Extract<
      MainToSyncWorkerMessage,
      { type: 'SUBSCRIBE_INVITE_EVENTS' }
    >
    const batch = {
      previousCursor: 'cursor-0',
      events: [
        {
          version: 1 as const,
          eventId: '11111111-1111-4111-8111-111111111111',
          streamPosition: 'cursor-1',
          kind: 'subscription-invite' as const,
          action: 'created' as const,
          inviteUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          occurredAt: 1,
        },
      ],
      nextCursor: 'cursor-1',
      hasMore: false,
    }

    worker.emit({ type: 'INVITE_BATCH', clientRequestId: subscribe.clientRequestId, batch })
    await flush()

    expect(applyBatch).toHaveBeenCalledTimes(1)
    expect(worker.posts.filter((message) => message.type === 'ACK_INVITE_EVENTS')).toHaveLength(0)
    expect(worker.posts.filter((message) => message.type === 'UNSUBSCRIBE_INVITE_EVENTS')).toEqual([
      { type: 'UNSUBSCRIBE_INVITE_EVENTS', clientRequestId: subscribe.clientRequestId },
    ])
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVITE_APPLY_FAILED', retryable: true, safeToFallback: false }),
    )

    worker.emit({ type: 'INVITE_BATCH', clientRequestId: subscribe.clientRequestId, batch })
    await flush()
    expect(applyBatch).toHaveBeenCalledTimes(1)
    dispose()
    expect(worker.posts.filter((message) => message.type === 'UNSUBSCRIBE_INVITE_EVENTS')).toHaveLength(1)
  })

  // `expectedRoomEpoch` is the fourth parameter of authorizeCollaborationRoom. No
  // production caller reaches it yet (the WebsocketsService transport seam still
  // declares three), so without this the argument would be silently droppable.
  const collaborationPost = () =>
    worker.posts.find((message) => message.type === 'AUTHORIZE_COLLABORATION') as Extract<
      MainToSyncWorkerMessage,
      { type: 'AUTHORIZE_COLLABORATION' }
    >

  it('forwards an expectedRoomEpoch pin from the four-argument call into the worker request', async () => {
    const transport = createTransport()
    const roomEpoch = 'c'.repeat(64)

    void transport.authorizeCollaborationRoom('note-1', 'lease-1', 'challenge-1', roomEpoch)
    await flush()

    expect(collaborationPost().request).toEqual({
      noteUuid: 'note-1',
      collaborationProtocolVersion: 3,
      leaseRequestId: 'lease-1',
      bootstrapChallenge: 'challenge-1',
      expectedRoomEpoch: roomEpoch,
    })
  })

  it('omits expectedRoomEpoch entirely when the three-argument call is used', async () => {
    const transport = createTransport()

    void transport.authorizeCollaborationRoom('note-1', 'lease-1', 'challenge-1')
    await flush()

    const { request: sent } = collaborationPost()
    expect('expectedRoomEpoch' in sent).toBe(false)
    expect(sent).toEqual({
      noteUuid: 'note-1',
      collaborationProtocolVersion: 3,
      leaseRequestId: 'lease-1',
      bootstrapChallenge: 'challenge-1',
    })
  })
})
