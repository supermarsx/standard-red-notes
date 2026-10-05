import type { AccountSyncTransportRequest } from '@standardnotes/services'
import type { HttpResponse, RawSyncResponse } from '@standardnotes/snjs'
import { LANE_LEDGER_TRANSITION_CAPACITY } from './LaneDegradationLedger'
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
      // The cache replays the classified reason; it never rewrites a transient
      // verdict into the permanent one for the request that follows.
      expect(worker.posts).toContainEqual({
        type: 'TICKET_UNAVAILABLE',
        clientRequestId: execute.clientRequestId,
        reason: 'ticket-unavailable',
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

  describe('control-plane failure classification', () => {
    const requestTicket = async (transport: WebSocketSyncTransport) => {
      const fallback = jest.fn().mockResolvedValue(response('http'))
      const execution = transport.execute(request(), fallback)
      await flush()
      const execute = worker.posts.filter((message) => message.type === 'EXECUTE').at(-1) as Extract<
        MainToSyncWorkerMessage,
        { type: 'EXECUTE' }
      >
      worker.emit({ type: 'NEED_TICKET', clientRequestId: execute.clientRequestId, reconnect: false })
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 0))
      const verdict = worker.posts.find(
        (message) => message.type === 'TICKET_UNAVAILABLE' && message.clientRequestId === execute.clientRequestId,
      ) as Extract<MainToSyncWorkerMessage, { type: 'TICKET_UNAVAILABLE' }> | undefined
      worker.emit({
        type: 'HTTP_FALLBACK',
        clientRequestId: execute.clientRequestId,
        reason: verdict?.reason ?? 'worker-error',
        body: request(),
      })
      await execution
      return verdict?.reason
    }

    it('treats a network error on the ticket request as retryable, not as a missing capability', async () => {
      controlPlane.createTicket.mockRejectedValue(new TypeError('Failed to fetch'))
      ;(controlPlane.getCapabilities as jest.Mock).mockRejectedValue(new TypeError('Failed to fetch'))

      await expect(requestTicket(createTransport())).resolves.toBe('ticket-unavailable')
    })

    it('treats a capabilities answer without ws-sync as the capability being absent', async () => {
      controlPlane.createTicket.mockRejectedValue(new TypeError('Failed to fetch'))
      ;(controlPlane.getCapabilities as jest.Mock).mockResolvedValue({ capabilities: [] })

      await expect(requestTicket(createTransport())).resolves.toBe('capability-unavailable')
    })

    it.each([
      [{ refused: true, status: 404 }, 'capability-unavailable'],
      [{ refused: true, status: 501 }, 'capability-unavailable'],
      [{ refused: true, status: 503, code: 'SYNC_DISABLED' }, 'capability-unavailable'],
      [{ refused: true, status: 503, code: 'SYNC_DISABLED', transient: true }, 'ticket-unavailable'],
      [{ refused: true, status: 503 }, 'ticket-unavailable'],
      [{ refused: true, status: 502 }, 'ticket-unavailable'],
      [{ refused: true, status: 429 }, 'ticket-unavailable'],
    ] as const)('classifies a ticket refusal %j as %s', async (refusal, expected) => {
      controlPlane.createTicket.mockResolvedValue(refusal)

      await expect(requestTicket(createTransport())).resolves.toBe(expected)
      expect(controlPlane.getCapabilities).not.toHaveBeenCalled()
    })

    it('lets the invite bootstrap past the negative ticket cache while plain syncs stay cached', async () => {
      // The control plane keeps failing for the whole window, so every request that
      // actually reaches it is visible as one more createTicket call.
      controlPlane.createTicket.mockResolvedValue(undefined)
      const transport = createTransport()
      await expect(requestTicket(transport)).resolves.toBe('ticket-unavailable')
      expect(controlPlane.createTicket).toHaveBeenCalledTimes(1)

      await transport.subscribeInviteEvents({
        applyBatch: jest.fn().mockResolvedValue('cursor-1'),
        reconcile: jest.fn().mockResolvedValue(undefined),
      })
      const subscribe = worker.posts.find((message) => message.type === 'SUBSCRIBE_INVITE_EVENTS') as Extract<
        MainToSyncWorkerMessage,
        { type: 'SUBSCRIBE_INVITE_EVENTS' }
      >
      worker.emit({ type: 'NEED_TICKET', clientRequestId: subscribe.clientRequestId, reconnect: false })
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 0))

      // The bootstrap asked the server itself instead of inheriting the cached verdict.
      expect(controlPlane.createTicket).toHaveBeenCalledTimes(2)
      expect(worker.posts).toContainEqual({
        type: 'TICKET_UNAVAILABLE',
        clientRequestId: subscribe.clientRequestId,
        reason: 'ticket-unavailable',
      })

      // A plain sync in the same window still gets the cached verdict without a request.
      await expect(requestTicket(transport)).resolves.toBe('ticket-unavailable')
      expect(controlPlane.createTicket).toHaveBeenCalledTimes(2)
    })
  })

  describe('ticket expiry on the local clock', () => {
    const connectFor = async (transport: WebSocketSyncTransport) => {
      const fallback = jest.fn().mockResolvedValue(response('http'))
      void transport.execute(request(), fallback)
      await flush()
      const execute = worker.posts.filter((message) => message.type === 'EXECUTE').at(-1) as Extract<
        MainToSyncWorkerMessage,
        { type: 'EXECUTE' }
      >
      worker.emit({ type: 'NEED_TICKET', clientRequestId: execute.clientRequestId, reconnect: false })
      await flush()
      return worker.posts.find((message) => message.type === 'CONNECT') as Extract<
        MainToSyncWorkerMessage,
        { type: 'CONNECT' }
      >
    }

    it('derives the local expiry from the server-reported lifetime, not from the server clock', async () => {
      const localNow = 1_800_000_000_000
      const serverNow = localNow - 60_000 // this browser runs a minute ahead of the server
      jest.spyOn(Date, 'now').mockReturnValue(localNow)
      controlPlane.createTicket.mockResolvedValue({
        ticket: 'ticket'.repeat(8),
        issuedAt: serverNow,
        expiresAt: serverNow + 30_000,
        endpoint: '/sockets/sync',
        capability: 'ws-sync',
        version: 1,
      })

      const connect = await connectFor(createTransport())

      expect(connect.authorization.expiresAt).toBe(serverNow + 30_000)
      expect(connect.authorization.localExpiresAt).toBe(localNow + 30_000)
    })

    it('performs no local pre-check when the server reports no issue time', async () => {
      const connect = await connectFor(createTransport())

      expect(connect.authorization).not.toHaveProperty('localExpiresAt')
    })
  })

  it('clears the negotiated operations when the worker falls back without a DEGRADED transition', async () => {
    const transport = createTransport()
    void transport.execute(request(), jest.fn().mockResolvedValue(response('http')))
    await flush()
    worker.emit({
      type: 'NEGOTIATED',
      sessionScope: SESSION_A,
      protocolVersion: 1,
      endpoint: 'wss://sync.example.test/sockets/sync',
      operations: ['SYNC_ITEMS', 'INVITE_EVENTS'],
    })
    worker.emit({ type: 'STATE', state: 'READY' })
    await flush()
    expect(transport.transportStatus.operations).toEqual(['SYNC_ITEMS', 'INVITE_EVENTS'])

    worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason: 'proxy-failed' })
    await flush()

    expect(transport.transportStatus).toEqual({
      state: 'HTTP_FALLBACK',
      fallbackReason: 'proxy-failed',
      operations: [],
    })
  })

  describe('a session with no socket lane', () => {
    it('stays on HTTP from a non-http page origin without creating a worker or requesting a ticket', async () => {
      // jsdom's `location` is unforgeable, so the page protocol rides the environment seam.
      const transport = createTransport({
        environment: { hasWorker: true, hasWebSocket: true, hasIndexedDb: true, pageProtocol: 'file:' },
      })
      const fallback = jest.fn().mockResolvedValue(response('http'))

      await expect(transport.execute(request(), fallback)).resolves.toEqual({ response: response('http') })

      expect(worker.posts).toHaveLength(0)
      expect(controlPlane.createTicket).not.toHaveBeenCalled()
      expect(transport.transportStatus).toEqual({
        state: 'HTTP_ONLY',
        fallbackReason: 'capability-unavailable',
        operations: [],
      })
    })

    it('stays on HTTP when no websocket URL is configured without consulting the worker', async () => {
      const transport = createTransport({ getConfiguredWebSocketUrl: () => undefined })
      const fallback = jest.fn().mockResolvedValue(response('http'))

      await expect(transport.execute(request(), fallback)).resolves.toEqual({ response: response('http') })

      expect(worker.posts).toHaveLength(0)
      expect(controlPlane.createTicket).not.toHaveBeenCalled()
      expect(transport.transportStatus.fallbackReason).toBe('capability-unavailable')
    })

    it('replays a pending record over HTTP with its identity under the http-only switch', async () => {
      const transport = createTransport({ isHttpOnly: () => true })
      const fallback = jest.fn().mockResolvedValue(response('replayed'))
      const recovery = transport.recoverPending(fallback)
      await flush()
      const recover = worker.posts.find((message) => message.type === 'RECOVER') as Extract<
        MainToSyncWorkerMessage,
        { type: 'RECOVER' }
      >
      expect(recover).toEqual(expect.objectContaining({ sessionScope: SESSION_A, replayOverHttp: 'http-only' }))

      const command = { id: 'command-1', digest: 'a'.repeat(64), sequence: 1 }
      worker.emit({ type: 'COMMAND_PERSISTED', clientRequestId: recover.clientRequestId, body: request(), command })
      worker.emit({
        type: 'HTTP_FALLBACK',
        clientRequestId: recover.clientRequestId,
        reason: 'http-only',
        body: request(),
        command,
      })

      const result = await recovery
      expect(fallback).toHaveBeenCalledWith(request(), command)
      expect(result).toEqual(expect.objectContaining({ response: response('replayed'), request: request() }))
      expect(result?.markCheckpointDurable).toBeDefined()
    })
  })

  describe('in-place session-credential refresh', () => {
    /**
     * Gets a worker created and bound for SESSION_A. The returned execution is
     * deliberately NOT awaited by the caller: it stays pending (or is rejected by a
     * revocation) while the refresh under test runs.
     */
    const startWorker = async (transport: WebSocketSyncTransport) => {
      const execution = transport.execute(request(), jest.fn().mockResolvedValue(response('http')))
      await flush()
      await flush()
      // Wrapped: an async function unwraps a returned promise, so handing the
      // execution back directly would make `await startWorker(...)` wait for the
      // sync itself to settle, which is exactly what must stay pending here.
      return { execution }
    }

    const refreshTicketPost = () =>
      worker.posts.find((message) => message.type === 'SESSION_REFRESH_TICKET') as
        Extract<MainToSyncWorkerMessage, { type: 'SESSION_REFRESH_TICKET' }> | undefined

    it('mints a fresh ticket over authenticated HTTP for a live socket, without dialling anything', async () => {
      const transport = createTransport()
      await startWorker(transport)

      worker.emit({ type: 'NEED_SESSION_REFRESH', refreshId: 'refresh-1', sessionScope: SESSION_A })
      await flush()
      await flush()

      expect(controlPlane.createTicket).toHaveBeenCalledWith('device-1')
      expect(refreshTicketPost()).toEqual({
        type: 'SESSION_REFRESH_TICKET',
        refreshId: 'refresh-1',
        ticket: 'ticket'.repeat(8),
        deviceId: 'device-1',
      })
      // A refresh is presented on the socket the worker already holds. Dialling is
      // what it exists to avoid, so nothing here may ask for a connection.
      expect(worker.posts.filter((message) => message.type === 'CONNECT')).toHaveLength(0)
      expect(controlPlane.getCapabilities).not.toHaveBeenCalled()
    })

    it('reports the refresh unavailable when no ticket can be minted, and leaves the ticket cache alone', async () => {
      const transport = createTransport()
      await startWorker(transport)
      controlPlane.createTicket.mockRejectedValueOnce(new Error('network'))

      worker.emit({ type: 'NEED_SESSION_REFRESH', refreshId: 'refresh-1', sessionScope: SESSION_A })
      await flush()
      await flush()

      expect(worker.posts).toContainEqual({ type: 'SESSION_REFRESH_UNAVAILABLE', refreshId: 'refresh-1' })
      expect(refreshTicketPost()).toBeUndefined()
      // Never classified as a capability verdict: the socket is up and working, and
      // a failed mint says nothing about the deployment.
      expect(controlPlane.getCapabilities).not.toHaveBeenCalled()
    })

    it('refuses to spend a refresh ticket once the authenticated session has changed', async () => {
      let sessionScope = SESSION_A
      const transport = createTransport({ getAuthenticatedSessionScope: async () => sessionScope })
      await startWorker(transport)
      controlPlane.createTicket.mockImplementationOnce(async () => {
        // The sign-out lands inside the mint's round trip.
        sessionScope = SESSION_B
        return {
          ticket: 'ticket'.repeat(8),
          expiresAt: Date.now() + 30_000,
          endpoint: '/sockets/sync',
          capability: 'ws-sync' as const,
          version: 1 as const,
        }
      })

      worker.emit({ type: 'NEED_SESSION_REFRESH', refreshId: 'refresh-1', sessionScope: SESSION_A })
      await flush()
      await flush()

      // The gateway closes a socket that is handed a ticket bound to another
      // identity, so a ticket minted for a session the tab no longer holds is
      // discarded rather than sent.
      expect(refreshTicketPost()).toBeUndefined()
      expect(worker.posts).toContainEqual({ type: 'SESSION_REFRESH_UNAVAILABLE', refreshId: 'refresh-1' })
    })

    it('terminates the lane cleanly when the worker reports the session is no longer authorized', async () => {
      const transport = createTransport()
      const { execution } = await startWorker(transport)
      const rejected = expect(execution).rejects.toThrow('revoked')

      worker.emit({ type: 'SESSION_NOT_AUTHORIZED', sessionScope: SESSION_A })
      await flush()
      const revoke = worker.posts.find((message) => message.type === 'SESSION_REVOKED') as Extract<
        MainToSyncWorkerMessage,
        { type: 'SESSION_REVOKED' }
      >
      expect(revoke).toEqual(expect.objectContaining({ sessionScope: SESSION_A }))
      worker.emit({ type: 'SESSION_REVOKED_ACK', requestId: revoke.requestId, sessionScope: SESSION_A })
      await flush()
      await rejected

      expect(worker.terminated).toBe(true)
      expect(transport.transportState).toBe('HTTP_ONLY')
      // Quarantined: the scope is refused outright, so nothing re-dials and no
      // further one-use ticket is minted for a session that cannot authenticate.
      // The app sees a real failure and re-authentication produces a new scope.
      controlPlane.createTicket.mockClear()
      await expect(transport.execute(request('after'), jest.fn().mockResolvedValue(response('http')))).rejects.toThrow(
        'revoked',
      )
      expect(controlPlane.createTicket).not.toHaveBeenCalled()
      expect(worker.posts.filter((message) => message.type === 'CONNECT')).toHaveLength(0)
    })
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

  /**
   * Standard Red Notes (t103): the worker reports a `deferred` condition — another
   * tab of this account owns the socket — and it must reach the lifecycle owner as a
   * park, not as a retryable error. Routed to `onError` it produced "Durable invite
   * stream failed; reconnecting from its checkpoint" once per coordinator backoff tick
   * for the life of the tab.
   */
  describe('a deferred invite lane', () => {
    let info: jest.SpyInstance
    let error: jest.SpyInstance

    beforeEach(() => {
      info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
      error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
      info.mockRestore()
      error.mockRestore()
    })

    const startInviteSubscription = async () => {
      const transport = createTransport()
      const onError = jest.fn()
      const onDeferred = jest.fn()
      const applyBatch = jest.fn().mockResolvedValue('cursor-1')
      await transport.subscribeInviteEvents({
        cursor: 'cursor-0',
        limit: 50,
        applyBatch,
        reconcile: jest.fn(),
        onError,
        onDeferred,
      })
      const subscribe = worker.posts.find((message) => message.type === 'SUBSCRIBE_INVITE_EVENTS') as Extract<
        MainToSyncWorkerMessage,
        { type: 'SUBSCRIBE_INVITE_EVENTS' }
      >
      return { transport, subscribe, onError, onDeferred, applyBatch }
    }

    it('is reported as a deferral, not an error, and leaves the subscription registered', async () => {
      const { subscribe, onError, onDeferred } = await startInviteSubscription()
      // Precondition: there really is a registered subscription for the worker to
      // address, so the assertions below cannot pass over a dropped message.
      expect(subscribe).toBeDefined()

      worker.emit({
        type: 'INVITE_DEFERRED',
        clientRequestId: subscribe.clientRequestId,
        reason: 'multi-tab-not-owner',
        resumeAfterMilliseconds: 15_000,
      })
      await flush()

      expect(onDeferred).toHaveBeenCalledTimes(1)
      expect(onDeferred).toHaveBeenCalledWith({ reason: 'multi-tab-not-owner', resumeAfterMilliseconds: 15_000 })
      expect(onError).not.toHaveBeenCalled()
      // Nothing is torn down: the worker resumes this exact registration.
      expect(worker.posts.filter((message) => message.type === 'UNSUBSCRIBE_INVITE_EVENTS')).toHaveLength(0)
      expect(worker.posts.filter((message) => message.type === 'SUBSCRIBE_INVITE_EVENTS')).toHaveLength(1)
    })

    it('says it once, as information, and never as a failure', async () => {
      const { subscribe } = await startInviteSubscription()

      for (let answer = 0; answer < 6; answer += 1) {
        worker.emit({
          type: 'INVITE_DEFERRED',
          clientRequestId: subscribe.clientRequestId,
          reason: 'multi-tab-not-owner',
          resumeAfterMilliseconds: 15_000,
        })
      }
      await flush()

      expect(error).not.toHaveBeenCalled()
      expect(info).toHaveBeenCalledTimes(1)
      const line = String(info.mock.calls[0][0])
      expect(line).toContain('Durable invite events are waiting for the socket')
      expect(line).toContain('multi-tab-not-owner')
      expect(line).toContain('not a fault')
    })

    it('delivers the resumed stream on the same registration after ownership transfers', async () => {
      const { subscribe, onDeferred, applyBatch } = await startInviteSubscription()
      worker.emit({
        type: 'INVITE_DEFERRED',
        clientRequestId: subscribe.clientRequestId,
        reason: 'multi-tab-not-owner',
        resumeAfterMilliseconds: 15_000,
      })
      await flush()
      expect(onDeferred).toHaveBeenCalledTimes(1)

      // The worker won the lease and re-sent this subscription on a fresh socket.
      worker.emit({ type: 'INVITE_READY', clientRequestId: subscribe.clientRequestId, cursor: 'cursor-0' })
      worker.emit({
        type: 'INVITE_BATCH',
        clientRequestId: subscribe.clientRequestId,
        batch: {
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
        },
      })
      await flush()

      expect(applyBatch).toHaveBeenCalledTimes(1)
      expect(worker.posts.filter((message) => message.type === 'ACK_INVITE_EVENTS')).toEqual([
        { type: 'ACK_INVITE_EVENTS', clientRequestId: subscribe.clientRequestId, cursor: 'cursor-1' },
      ])
    })
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

  describe('FILES_V1 capability gate', () => {
    const fileRequest = () => ({
      remoteIdentifier: 'remote-identifier-1',
      fileUuid: '11111111-1111-4111-8111-111111111111',
      declaredSize: 10,
      onBytes: jest.fn().mockResolvedValue(undefined),
    })

    const negotiate = async (transport: WebSocketSyncTransport, operations: string[]) => {
      const fallback = jest.fn().mockResolvedValue(response('http'))
      void transport.execute(request(), fallback)
      await flush()
      worker.emit({
        type: 'NEGOTIATED',
        sessionScope: SESSION_A,
        protocolVersion: 1,
        endpoint: 'wss://sync.example.test/sockets/sync',
        operations: operations as never,
      })
      worker.emit({ type: 'STATE', state: 'READY' })
      await flush()
    }

    it('reports the lane unavailable and creates no worker before anything is negotiated', async () => {
      const transport = createTransport()

      expect(transport.isFileLaneAvailable()).toBe(false)
      await expect(transport.downloadFileOverSocket(fileRequest())).resolves.toEqual({ outcome: 'unavailable' })
      // The point of the gate: a deployment without the lane never even builds
      // the worker, requests a ticket, or opens a socket on a file's behalf.
      expect(worker.posts).toHaveLength(0)
      expect(controlPlane.createTicket).not.toHaveBeenCalled()
    })

    it('reports the lane unavailable when the socket is up but does not advertise FILES_V1', async () => {
      const transport = createTransport()
      await negotiate(transport, ['SYNC_ITEMS', 'API_RPC'])

      expect(transport.isFileLaneAvailable()).toBe(false)
      const postsBefore = worker.posts.length
      await expect(transport.downloadFileOverSocket(fileRequest())).resolves.toEqual({ outcome: 'unavailable' })
      expect(worker.posts).toHaveLength(postsBefore)
    })

    it('opens a download and preserves remoteIdentifier once FILES_V1 is negotiated', async () => {
      const transport = createTransport()
      await negotiate(transport, ['SYNC_ITEMS', 'FILES_V1'])

      expect(transport.isFileLaneAvailable()).toBe(true)
      const download = transport.downloadFileOverSocket(fileRequest())
      await flush()

      const open = worker.posts.find((message) => message.type === 'OPEN_FILE_DOWNLOAD') as Extract<
        MainToSyncWorkerMessage,
        { type: 'OPEN_FILE_DOWNLOAD' }
      >
      expect(open.request.resource).toEqual({
        ownershipType: 'user',
        remoteIdentifier: 'remote-identifier-1',
        fileUuid: '11111111-1111-4111-8111-111111111111',
      })
      expect(open.request.declaredSize).toBe(10)

      worker.emit({ type: 'FILE_DOWNLOAD_ACCEPTED', clientRequestId: open.clientRequestId, declaredSize: 10 })
      worker.emit({
        type: 'FILE_DOWNLOAD_CHUNK',
        clientRequestId: open.clientRequestId,
        bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        offset: 0,
      })
      await flush()
      worker.emit({
        type: 'FILE_DOWNLOAD_COMPLETE',
        clientRequestId: open.clientRequestId,
        sha256: 'a'.repeat(64),
        declaredSize: 10,
      })
      await flush()

      await expect(download).resolves.toEqual({ outcome: 'completed', sha256: 'a'.repeat(64) })
    })

    it('opens a shared-vault download with both vault fields present', async () => {
      const transport = createTransport()
      await negotiate(transport, ['SYNC_ITEMS', 'FILES_V1'])

      void transport.downloadFileOverSocket({
        ...fileRequest(),
        sharedVault: {
          sharedVaultUuid: '22222222-2222-4222-8222-222222222222',
          sharedVaultOwnerUuid: '33333333-3333-4333-8333-333333333333',
        },
      })
      await flush()

      const open = worker.posts.find((message) => message.type === 'OPEN_FILE_DOWNLOAD') as Extract<
        MainToSyncWorkerMessage,
        { type: 'OPEN_FILE_DOWNLOAD' }
      >
      expect(open.request.resource).toEqual({
        ownershipType: 'shared-vault',
        remoteIdentifier: 'remote-identifier-1',
        fileUuid: '11111111-1111-4111-8111-111111111111',
        sharedVaultUuid: '22222222-2222-4222-8222-222222222222',
        sharedVaultOwnerUuid: '33333333-3333-4333-8333-333333333333',
      })
    })

    it('refuses to open a shared-vault download whose owner uuid is not a valid identifier', async () => {
      const transport = createTransport()
      await negotiate(transport, ['SYNC_ITEMS', 'FILES_V1'])
      const postsBefore = worker.posts.length

      await expect(
        transport.downloadFileOverSocket({
          ...fileRequest(),
          sharedVault: { sharedVaultUuid: '22222222-2222-4222-8222-222222222222', sharedVaultOwnerUuid: '' },
        }),
      ).resolves.toEqual({ outcome: 'unavailable' })

      // Reported as unavailable rather than failed, so the caller falls back to
      // HTTP: nothing was sent, so nothing can have been half-applied.
      expect(worker.posts).toHaveLength(postsBefore)
    })

    it('returns credit only after the consumer has finished with the bytes', async () => {
      const transport = createTransport()
      await negotiate(transport, ['SYNC_ITEMS', 'FILES_V1'])

      let releaseConsumer = (): void => undefined
      const consumed = new Promise<void>((resolve) => {
        releaseConsumer = resolve
      })
      void transport.downloadFileOverSocket({ ...fileRequest(), onBytes: () => consumed })
      await flush()
      const open = worker.posts.find((message) => message.type === 'OPEN_FILE_DOWNLOAD') as Extract<
        MainToSyncWorkerMessage,
        { type: 'OPEN_FILE_DOWNLOAD' }
      >

      worker.emit({
        type: 'FILE_DOWNLOAD_CHUNK',
        clientRequestId: open.clientRequestId,
        bytes: Uint8Array.from([1, 2, 3, 4]),
        offset: 0,
      })
      await flush()
      expect(worker.posts.some((message) => message.type === 'FILE_DOWNLOAD_CREDIT')).toBe(false)

      releaseConsumer()
      await flush()
      expect(worker.posts).toContainEqual({
        type: 'FILE_DOWNLOAD_CREDIT',
        clientRequestId: open.clientRequestId,
        creditBytes: 4,
      })
    })

    it('will not call a failure safe to replay once bytes have reached the consumer', async () => {
      const transport = createTransport()
      await negotiate(transport, ['SYNC_ITEMS', 'FILES_V1'])

      const download = transport.downloadFileOverSocket(fileRequest())
      await flush()
      const open = worker.posts.find((message) => message.type === 'OPEN_FILE_DOWNLOAD') as Extract<
        MainToSyncWorkerMessage,
        { type: 'OPEN_FILE_DOWNLOAD' }
      >

      worker.emit({
        type: 'FILE_DOWNLOAD_CHUNK',
        clientRequestId: open.clientRequestId,
        bytes: Uint8Array.from([1, 2, 3, 4]),
        offset: 0,
      })
      await flush()
      // The worker believes nothing crossed; this thread knows better, and the
      // stricter of the two answers is the one that reaches the caller.
      worker.emit({
        type: 'FILE_DOWNLOAD_ERROR',
        clientRequestId: open.clientRequestId,
        code: 'SOCKET_CLOSED',
        retryable: true,
        safeToFallback: true,
      })
      await flush()

      await expect(download).resolves.toEqual({
        outcome: 'failed',
        code: 'SOCKET_CLOSED',
        retryable: true,
        safeToFallback: false,
      })
    })

    it('fails a transfer whose completion arrives short of the declared size', async () => {
      const transport = createTransport()
      await negotiate(transport, ['SYNC_ITEMS', 'FILES_V1'])

      const download = transport.downloadFileOverSocket(fileRequest())
      await flush()
      const open = worker.posts.find((message) => message.type === 'OPEN_FILE_DOWNLOAD') as Extract<
        MainToSyncWorkerMessage,
        { type: 'OPEN_FILE_DOWNLOAD' }
      >

      worker.emit({
        type: 'FILE_DOWNLOAD_COMPLETE',
        clientRequestId: open.clientRequestId,
        sha256: 'a'.repeat(64),
        declaredSize: 10,
      })
      await flush()

      await expect(download).resolves.toMatchObject({ outcome: 'failed', code: 'FILE_TRUNCATED' })
    })

    it('stops advertising the lane as soon as the socket degrades', async () => {
      const transport = createTransport()
      await negotiate(transport, ['SYNC_ITEMS', 'FILES_V1'])
      expect(transport.isFileLaneAvailable()).toBe(true)

      worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'proxy-failed' })
      await flush()

      expect(transport.isFileLaneAvailable()).toBe(false)
      await expect(transport.downloadFileOverSocket(fileRequest())).resolves.toEqual({ outcome: 'unavailable' })
    })
  })

  describe('handing the socket between tabs', () => {
    const startExecute = async (transport: WebSocketSyncTransport) => {
      const fallback = jest.fn().mockResolvedValue(response('http'))
      const execution = transport.execute(request(), fallback)
      await flush()
      const execute = worker.posts.filter((message) => message.type === 'EXECUTE').at(-1) as Extract<
        MainToSyncWorkerMessage,
        { type: 'EXECUTE' }
      >
      return { execution, clientRequestId: execute.clientRequestId }
    }

    const settleOverHttp = async (
      execution: Promise<unknown>,
      clientRequestId: string,
      reason: 'multi-tab-not-owner',
    ) => {
      worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason })
      worker.emit({ type: 'HTTP_FALLBACK', clientRequestId, reason, body: request() })
      await expect(execution).resolves.toEqual({ response: response('http') })
    }

    it('stops minting tickets while another tab holds the owner lease', async () => {
      const transport = createTransport()
      const first = await startExecute(transport)
      worker.emit({ type: 'NEED_TICKET', clientRequestId: first.clientRequestId, reconnect: false })
      await flush()
      expect(controlPlane.createTicket).toHaveBeenCalledTimes(1)
      await settleOverHttp(first.execution, first.clientRequestId, 'multi-tab-not-owner')

      const second = await startExecute(transport)
      worker.emit({ type: 'NEED_TICKET', clientRequestId: second.clientRequestId, reconnect: false })
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(controlPlane.createTicket).toHaveBeenCalledTimes(1)
      expect(worker.posts).toContainEqual({
        type: 'TICKET_UNAVAILABLE',
        clientRequestId: second.clientRequestId,
        reason: 'multi-tab-not-owner',
      })
      await settleOverHttp(second.execution, second.clientRequestId, 'multi-tab-not-owner')
    })

    it('applies the lease verdict to a bootstrap too, which retries far more often than a sync', async () => {
      const transport = createTransport()
      const first = await startExecute(transport)
      worker.emit({ type: 'NEED_TICKET', clientRequestId: first.clientRequestId, reconnect: false })
      await flush()
      await settleOverHttp(first.execution, first.clientRequestId, 'multi-tab-not-owner')
      expect(controlPlane.createTicket).toHaveBeenCalledTimes(1)

      await transport.subscribeInviteEvents({
        applyBatch: jest.fn().mockResolvedValue('cursor-1'),
        reconcile: jest.fn().mockResolvedValue(undefined),
      })
      const subscribe = worker.posts.find((message) => message.type === 'SUBSCRIBE_INVITE_EVENTS') as Extract<
        MainToSyncWorkerMessage,
        { type: 'SUBSCRIBE_INVITE_EVENTS' }
      >
      worker.emit({ type: 'NEED_TICKET', clientRequestId: subscribe.clientRequestId, reconnect: false })
      await flush()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(controlPlane.createTicket).toHaveBeenCalledTimes(1)
      expect(worker.posts).toContainEqual({
        type: 'TICKET_UNAVAILABLE',
        clientRequestId: subscribe.clientRequestId,
        reason: 'multi-tab-not-owner',
      })
    })

    it('asks the worker to hand the lease back when the page is hidden', async () => {
      const transport = createTransport()
      const { execution, clientRequestId } = await startExecute(transport)

      globalThis.dispatchEvent(new Event('pagehide'))

      expect(worker.posts).toContainEqual({ type: 'RELEASE_OWNER' })
      await settleOverHttp(execution, clientRequestId, 'multi-tab-not-owner')
    })

    it('gives the worker a moment to release the lease before terminating it', async () => {
      const transport = createTransport()
      const { execution } = await startExecute(transport)

      transport.deinit()
      await expect(execution).rejects.toThrow('deinitialized')

      expect(worker.posts.at(-1)).toEqual({ type: 'SHUTDOWN' })
      expect(worker.terminated).toBe(false)

      worker.emit({ type: 'SHUTDOWN_COMPLETE' })
      await flush()
      expect(worker.terminated).toBe(true)
    })

    it('terminates anyway when the worker never reports that it shut down', async () => {
      jest.useFakeTimers()
      try {
        const transport = createTransport()
        const { execution } = await startExecute(transport)

        transport.deinit()
        await expect(execution).rejects.toThrow('deinitialized')
        expect(worker.terminated).toBe(false)

        jest.advanceTimersByTime(500)
        expect(worker.terminated).toBe(true)
      } finally {
        jest.useRealTimers()
      }
    })
  })
  /**
   * Standard Red Notes (t99): the transport used to change which network path
   * carried every save without emitting a single line anywhere. The only readout
   * was `transportStatus`, rendered exclusively in the admin-gated diagnostics
   * pane, so a non-admin user watching a burst of `POST /v1/items` had no way to
   * learn that saves had left the socket, or why.
   */
  describe('announcing which transport carries saves', () => {
    let warn: jest.SpyInstance
    let info: jest.SpyInstance

    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      info = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    })

    afterEach(() => {
      warn.mockRestore()
      info.mockRestore()
    })

    const connectWorker = async () => {
      const transport = createTransport()
      void transport.execute(request(), jest.fn().mockResolvedValue(response('http')))
      await flush()
      return transport
    }

    it('names the state and the reason when saves fall back to HTTP', async () => {
      await connectWorker()

      worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason: 'operation-unavailable' })
      await flush()

      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0][0])
      expect(line).toContain('[sync-transport]')
      expect(line).toContain('HTTP_FALLBACK')
      expect(line).toContain('operation-unavailable')
      // The explanation is what turns the reason into something actionable.
      expect(line).toContain('did not negotiate the operation this request needed')
      expect(line).toContain('POST /v1/items')
    })

    it('logs one line per genuine transition, not one per sync round', async () => {
      await connectWorker()

      for (let round = 0; round < 5; round += 1) {
        worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason: 'operation-unavailable' })
      }
      await flush()

      expect(warn).toHaveBeenCalledTimes(1)

      // A DIFFERENT reason is a genuine transition and must be announced.
      worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason: 'frame-too-large' })
      await flush()

      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[1][0])).toContain('frame-too-large')
    })

    /**
     * Standard Red Notes (t103): captured live from a second tab of one account. The
     * announced state alternated DEGRADED / HTTP_FALLBACK eight times over an
     * unchanged `multi-tab-not-owner`, because each lane classifies its own refusal
     * and the log signature was keyed per state. That alternation was most of the
     * console flood.
     */
    it('says it once for an unchanged cause, however many states the lanes report', async () => {
      await connectWorker()

      // The exact sequence from the live log, in order.
      const observed = [
        { state: 'DEGRADED' as const, reason: undefined },
        { state: 'DEGRADED' as const, reason: 'multi-tab-not-owner' as const },
        { state: 'HTTP_FALLBACK' as const, reason: 'multi-tab-not-owner' as const },
        { state: 'DEGRADED' as const, reason: 'multi-tab-not-owner' as const },
        { state: 'HTTP_FALLBACK' as const, reason: 'multi-tab-not-owner' as const },
        { state: 'DEGRADED' as const, reason: 'multi-tab-not-owner' as const },
        { state: 'HTTP_FALLBACK' as const, reason: 'multi-tab-not-owner' as const },
        { state: 'DEGRADED' as const, reason: 'multi-tab-not-owner' as const },
      ]
      // Precondition: the sequence really does carry more than one state for the one
      // cause, so "logged once" below is a settling and not an empty replay.
      const causedStates = new Set(observed.filter((entry) => entry.reason !== undefined).map((entry) => entry.state))
      expect(causedStates.size).toBe(2)
      expect(observed).toHaveLength(8)

      for (const entry of observed) {
        worker.emit({
          type: 'STATE',
          state: entry.state,
          ...(entry.reason ? { reason: entry.reason } : {}),
        })
      }
      await flush()

      // Two lines: the reasonless close, then the one cause. Not eight.
      expect(warn).toHaveBeenCalledTimes(2)
      expect(String(warn.mock.calls[1][0])).toContain('multi-tab-not-owner')
      expect(String(warn.mock.calls[1][0])).toContain('Another tab of this account holds the socket')
    })

    it('does not assert a cause for a state that arrived without one', async () => {
      await connectWorker()

      worker.emit({ type: 'STATE', state: 'DEGRADED' })
      await flush()

      expect(warn).toHaveBeenCalledTimes(1)
      const line = String(warn.mock.calls[0][0])
      expect(line).toContain('NO cause was reported')
      // It must not read as a settled, explained HTTP state, which is what
      // "Account sync is using HTTP (state DEGRADED)." claimed with nothing after it.
      expect(line).not.toContain('is using HTTP (state DEGRADED)')
      expect(line).toContain('POST /v1/items')
    })

    it('says so, with the operation list, when the socket does carry sync', async () => {
      await connectWorker()

      worker.emit({
        type: 'NEGOTIATED',
        sessionScope: SESSION_A,
        protocolVersion: 1,
        endpoint: 'wss://sync.example.test/sockets/sync',
        operations: ['SYNC_ITEMS', 'INVITE_EVENTS'],
      })
      await flush()

      expect(info).toHaveBeenCalledTimes(1)
      const line = String(info.mock.calls[0][0])
      expect(line).toContain('Account sync is on the websocket')
      expect(line).toContain('SYNC_ITEMS, INVITE_EVENTS')
      expect(warn).not.toHaveBeenCalled()
    })

    it('calls out a negotiation that omits SYNC_ITEMS, the silent-HTTP case', async () => {
      await connectWorker()

      worker.emit({
        type: 'NEGOTIATED',
        sessionScope: SESSION_A,
        protocolVersion: 1,
        endpoint: 'wss://sync.example.test/sockets/sync',
        operations: ['AUTHORIZE_COLLABORATION', 'API_RPC', 'INVITE_EVENTS', 'FILES_V1'],
      })
      await flush()

      expect(info).toHaveBeenCalledTimes(1)
      const line = String(info.mock.calls[0][0])
      expect(line).toContain('NOT SYNC_ITEMS')
      expect(line).toContain('saves stay on HTTP')
      // The operator-facing precondition code, so the reader can search for it.
      expect(line).toContain('SYNCING_SERVER_GRPC_UNBOUND')
    })

    it('stays quiet through the intermediate states on the way to READY', async () => {
      await connectWorker()

      worker.emit({ type: 'STATE', state: 'CONNECTING' })
      worker.emit({ type: 'STATE', state: 'AUTHENTICATING' })
      await flush()

      expect(warn).not.toHaveBeenCalled()
      expect(info).not.toHaveBeenCalled()
    })
  })

  /**
   * A fallback that deliberately KEEPS a healthy socket used to wipe the negotiated
   * operation list anyway, because the main thread could not tell the two cases
   * apart. The worker posts HTTP_FALLBACK and then immediately posts READY again,
   * and NEGOTIATED is only ever posted after a fresh handshake — so the steady
   * state became `{ state: READY, operations: [] }` on a socket still carrying
   * everything it had negotiated.
   *
   * That is not only a wrong readout. `negotiated` is the field `isFileLaneAvailable()`
   * and the API_RPC gate both read, so one refused operation silently pushed FILES_V1
   * and every control-plane request onto HTTP for the life of the connection — and on
   * a deployment where an operation is permanently unavailable, that fired every round.
   */
  describe('a fallback that keeps a healthy socket keeps what that socket negotiated', () => {
    const connect = async () => {
      const transport = createTransport()
      void transport.execute(request(), jest.fn().mockResolvedValue(response('http')))
      await flush()
      // Order mirrors the worker's own handshake: it transitions to READY and then
      // posts NEGOTIATED. `isFileLaneAvailable()` requires both, so a helper that
      // emitted only NEGOTIATED would assert against a lane that was never up.
      worker.emit({ type: 'STATE', state: 'READY', socketPreserved: true })
      worker.emit({
        type: 'NEGOTIATED',
        sessionScope: SESSION_A,
        protocolVersion: 1,
        endpoint: 'wss://sync.example.test/sockets/sync',
        operations: ['SYNC_ITEMS', 'API_RPC', 'FILES_V1'],
      })
      await flush()
      return transport
    }

    it('reports READY with its operations after an operation-unavailable fallback', async () => {
      const transport = await connect()

      worker.emit({
        type: 'STATE',
        state: 'HTTP_FALLBACK',
        reason: 'operation-unavailable',
        socketPreserved: true,
      })
      worker.emit({ type: 'STATE', state: 'READY', socketPreserved: true })
      await flush()

      expect(transport.transportStatus.state).toBe('READY')
      expect([...transport.transportStatus.operations].sort()).toEqual(['API_RPC', 'FILES_V1', 'SYNC_ITEMS'])
    })

    it('keeps the file lane usable, since the socket still carries FILES_V1', async () => {
      const transport = await connect()
      expect(transport.isFileLaneAvailable()).toBe(true)

      worker.emit({
        type: 'STATE',
        state: 'HTTP_FALLBACK',
        reason: 'operation-unavailable',
        socketPreserved: true,
      })
      worker.emit({ type: 'STATE', state: 'READY', socketPreserved: true })
      await flush()

      expect(transport.isFileLaneAvailable()).toBe(true)
    })

    it('still clears the list when the socket is actually gone', async () => {
      const transport = await connect()

      // No `socketPreserved`: the worker closed the socket after this transition,
      // so the operation list it negotiated is stale and must not be reported.
      worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason: 'server-kill' })
      await flush()

      expect(transport.transportStatus.operations).toEqual([])
      expect(transport.isFileLaneAvailable()).toBe(false)
    })

    it('still clears the list on DEGRADED when the socket is gone', async () => {
      const transport = await connect()

      worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'server-kill' })
      await flush()

      expect(transport.transportStatus.operations).toEqual([])
    })
  })

  describe('uploadFileOverSocket', () => {
    const SHA = 'a'.repeat(64)

    const connectWithLane = async (operations = ['SYNC_ITEMS', 'FILES_V1']) => {
      const transport = createTransport()
      // The bootstrapping request is rejected outright by a session revocation,
      // so it is swallowed here rather than left to crash the worker as an
      // unhandled rejection.
      void transport.execute(request(), jest.fn().mockResolvedValue(response('http'))).catch(() => undefined)
      await flush()
      worker.emit({ type: 'STATE', state: 'READY', socketPreserved: true })
      worker.emit({
        type: 'NEGOTIATED',
        sessionScope: SESSION_A,
        protocolVersion: 1,
        endpoint: 'wss://sync.example.test/sockets/sync',
        operations: operations as never,
      })
      await flush()
      return transport
    }

    const lastPost = <T extends MainToSyncWorkerMessage['type']>(type: T) =>
      [...worker.posts].reverse().find((post) => post.type === type) as Extract<MainToSyncWorkerMessage, { type: T }>

    const openRequest = (overrides: Record<string, unknown> = {}) => ({
      remoteIdentifier: 'remote-1',
      fileUuid: 'file-1',
      decryptedSize: 10,
      declaredSize: 27,
      mimeType: 'application/octet-stream',
      ...overrides,
    })

    const accept = async (overrides: Record<string, unknown> = {}) => {
      const clientRequestId = lastPost('OPEN_FILE_UPLOAD').clientRequestId
      worker.emit({
        type: 'FILE_UPLOAD_ACCEPTED',
        clientRequestId,
        transferId: 'transfer-1',
        generation: 1,
        resumeId: 'resume-1',
        nextIndex: 0,
        nextOffset: 0,
        declaredSize: 27,
        ...overrides,
      } as never)
      await flush()
      return clientRequestId
    }

    it('answers unavailable without touching the worker when the lane was never negotiated', async () => {
      const transport = await connectWithLane(['SYNC_ITEMS'])

      await expect(transport.uploadFileOverSocket(openRequest())).resolves.toEqual({ outcome: 'unavailable' })
      expect(worker.posts.some((post) => post.type === 'OPEN_FILE_UPLOAD')).toBe(false)
    })

    it('answers unavailable once the socket has degraded, with nothing attempted', async () => {
      const transport = await connectWithLane()
      worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'server-kill' })
      await flush()

      await expect(transport.uploadFileOverSocket(openRequest())).resolves.toEqual({ outcome: 'unavailable' })
      expect(worker.posts.some((post) => post.type === 'OPEN_FILE_UPLOAD')).toBe(false)
    })

    it.each([
      ['a zero decrypted size, which the gateway refuses', { decryptedSize: 0 }],
      ['an encrypted total above the 5 GiB transfer cap', { declaredSize: 5 * 1024 * 1024 * 1024 + 1 }],
      ['an empty mime type', { mimeType: '' }],
      ['a mime type carrying a control character', { mimeType: 'text/plain\u0000' }],
      ['an unusable remote identifier', { remoteIdentifier: 'has spaces' }],
    ])('refuses %s before a round trip, so HTTP carries the upload', async (_case, overrides) => {
      const transport = await connectWithLane()

      await expect(transport.uploadFileOverSocket(openRequest(overrides))).resolves.toEqual({ outcome: 'unavailable' })
      expect(worker.posts.some((post) => post.type === 'OPEN_FILE_UPLOAD')).toBe(false)
    })

    it('opens the upload and reports the gateway frame limit with the accepted position', async () => {
      const transport = await connectWithLane()

      const opening = transport.uploadFileOverSocket(openRequest())
      await flush()
      expect(lastPost('OPEN_FILE_UPLOAD').request).toEqual({
        resource: { ownershipType: 'user', remoteIdentifier: 'remote-1', fileUuid: 'file-1' },
        decryptedSize: 10,
        declaredSize: 27,
        mimeType: 'application/octet-stream',
        deadlineMs: 30_000,
      })
      await accept()

      const opened = await opening
      expect(opened).toMatchObject({
        outcome: 'opened',
        position: { transferId: 'transfer-1', generation: 1, nextOffset: 0, declaredSize: 27, maxFrameBytes: 262_144 },
      })
    })

    it('carries the shared vault owner into the resource, never inventing one', async () => {
      const transport = await connectWithLane()

      void transport.uploadFileOverSocket(
        openRequest({ sharedVault: { sharedVaultUuid: 'vault-1', sharedVaultOwnerUuid: 'owner-1' } }),
      )
      await flush()

      expect(lastPost('OPEN_FILE_UPLOAD').request.resource).toEqual({
        ownershipType: 'shared-vault',
        remoteIdentifier: 'remote-1',
        fileUuid: 'file-1',
        sharedVaultUuid: 'vault-1',
        sharedVaultOwnerUuid: 'owner-1',
      })
    })

    it('reports a refused open as a failure that is safe to retry over HTTP', async () => {
      const transport = await connectWithLane()
      const opening = transport.uploadFileOverSocket(openRequest())
      await flush()

      worker.emit({
        type: 'FILE_UPLOAD_ERROR',
        clientRequestId: lastPost('OPEN_FILE_UPLOAD').clientRequestId,
        code: 'FILE_LIMIT_EXCEEDED',
        retryable: false,
        safeToFallback: true,
      } as never)

      await expect(opening).resolves.toEqual({
        outcome: 'failed',
        code: 'FILE_LIMIT_EXCEEDED',
        retryable: false,
        safeToFallback: true,
      })
    })

    it('writes chunks and resolves each one on its acknowledgement', async () => {
      const transport = await connectWithLane()
      const opening = transport.uploadFileOverSocket(openRequest())
      await flush()
      const clientRequestId = await accept()
      const opened = await opening
      if (opened.outcome !== 'opened') {
        throw new Error('expected an opened upload')
      }

      const sending = opened.session.sendChunk({ index: 0, offset: 0, bytes: new Uint8Array([1, 2, 3]) })
      await flush()
      expect(lastPost('SEND_FILE_CHUNK')).toMatchObject({ index: 0, offset: 0, bytes: new Uint8Array([1, 2, 3]) })

      worker.emit({
        type: 'FILE_UPLOAD_CHUNK_ACK',
        clientRequestId,
        transferId: 'transfer-1',
        generation: 1,
        index: 0,
        duplicate: false,
        nextIndex: 1,
        nextOffset: 3,
        resumeId: 'resume-1',
      } as never)

      await expect(sending).resolves.toEqual({
        outcome: 'acknowledged',
        transferId: 'transfer-1',
        generation: 1,
        index: 0,
        duplicate: false,
        nextIndex: 1,
        nextOffset: 3,
        resumeId: 'resume-1',
      })
    })

    it('refuses a second concurrent write, because the next ack would be ambiguous', async () => {
      const transport = await connectWithLane()
      const opening = transport.uploadFileOverSocket(openRequest())
      await flush()
      await accept()
      const opened = await opening
      if (opened.outcome !== 'opened') {
        throw new Error('expected an opened upload')
      }

      void opened.session.sendChunk({ index: 0, offset: 0, bytes: new Uint8Array([1]) })
      await flush()

      await expect(opened.session.sendChunk({ index: 1, offset: 1, bytes: new Uint8Array([2]) })).resolves.toEqual({
        outcome: 'failed',
        code: 'FILE_STEP_IN_FLIGHT',
        retryable: false,
        safeToFallback: false,
      })
    })

    it('reports a finish failure as unsafe to replay, whatever the socket observed', async () => {
      const transport = await connectWithLane()
      const opening = transport.uploadFileOverSocket(openRequest())
      await flush()
      const clientRequestId = await accept()
      const opened = await opening
      if (opened.outcome !== 'opened') {
        throw new Error('expected an opened upload')
      }

      const finishing = opened.session.finish({
        transferId: 'transfer-1',
        generation: 1,
        declaredSize: 27,
        sha256: SHA,
      })
      await flush()
      expect(lastPost('FINISH_FILE_UPLOAD')).toMatchObject({ transferId: 'transfer-1', declaredSize: 27, sha256: SHA })

      // The worker still believes a replay is safe; this thread knows FINISH was
      // written, and the stricter of the two is what the caller is told.
      worker.emit({
        type: 'FILE_UPLOAD_ERROR',
        clientRequestId,
        code: 'SOCKET_CLOSED',
        retryable: true,
        safeToFallback: true,
      } as never)

      await expect(finishing).resolves.toEqual({
        outcome: 'failed',
        code: 'SOCKET_CLOSED',
        retryable: true,
        safeToFallback: false,
      })
    })

    it('resolves finish on the gateway digest and stops tracking the upload', async () => {
      const transport = await connectWithLane()
      const opening = transport.uploadFileOverSocket(openRequest())
      await flush()
      const clientRequestId = await accept()
      const opened = await opening
      if (opened.outcome !== 'opened') {
        throw new Error('expected an opened upload')
      }

      const finishing = opened.session.finish({
        transferId: 'transfer-1',
        generation: 1,
        declaredSize: 27,
        sha256: SHA,
      })
      await flush()
      worker.emit({ type: 'FILE_UPLOAD_COMPLETE', clientRequestId, sha256: SHA } as never)

      await expect(finishing).resolves.toEqual({ outcome: 'completed', sha256: SHA })
      await expect(
        opened.session.sendChunk({ index: 1, offset: 1, bytes: new Uint8Array([2]) }),
      ).resolves.toMatchObject({ outcome: 'failed', code: 'SOCKET_CLOSED' })
    })

    it('cancels the transfer and reports the cancellation to the step in flight', async () => {
      const transport = await connectWithLane()
      const controller = new AbortController()
      const opening = transport.uploadFileOverSocket(openRequest({ signal: controller.signal }))
      await flush()
      await accept()
      const opened = await opening
      if (opened.outcome !== 'opened') {
        throw new Error('expected an opened upload')
      }

      const sending = opened.session.sendChunk({ index: 0, offset: 0, bytes: new Uint8Array([1]) })
      await flush()
      controller.abort()

      await expect(sending).resolves.toEqual({
        outcome: 'failed',
        code: 'FILE_CANCELLED',
        retryable: false,
        safeToFallback: true,
      })
      expect(worker.posts.some((post) => post.type === 'CANCEL_FILE_UPLOAD')).toBe(true)
    })

    it('answers aborted before anything is written when the signal is already aborted', async () => {
      const transport = await connectWithLane()
      const controller = new AbortController()
      controller.abort()

      await expect(transport.uploadFileOverSocket(openRequest({ signal: controller.signal }))).resolves.toEqual({
        outcome: 'aborted',
      })
      expect(worker.posts.some((post) => post.type === 'OPEN_FILE_UPLOAD')).toBe(false)
    })

    it('fails the step in flight when the session is revoked', async () => {
      const transport = await connectWithLane()
      const opening = transport.uploadFileOverSocket(openRequest())
      await flush()
      await accept()
      const opened = await opening
      if (opened.outcome !== 'opened') {
        throw new Error('expected an opened upload')
      }

      const sending = opened.session.sendChunk({ index: 0, offset: 0, bytes: new Uint8Array([1]) })
      await flush()
      void transport.notifySessionRevoked()
      await flush()

      await expect(sending).resolves.toMatchObject({ outcome: 'failed', code: 'SESSION_REVOKED' })
    })
  })

  /* ------------------------------------------------------------------------ */
  /* The lane-degradation ledger, driven through the real transport           */
  /* ------------------------------------------------------------------------ */

  /**
   * The ledger has its own unit tests; these are the ones that can only be written
   * HERE, because they are about the transport's own seams:
   *
   *   - every state assignment reaching the ledger, including the main-thread ones
   *     that never post a STATE message;
   *   - a recovery being recorded from the same path a degradation is;
   *   - the closed reason the pane was missing actually being emitted.
   *
   * A ledger wired to only the worker's STATE messages would look correct in its own
   * suite and still be blind to the half of the degradations this class decides by
   * itself, which is exactly the shape of defect `transportStatus` already had.
   */
  describe('the lane-degradation ledger', () => {
    it('records a degradation, a recovery and a second degradation in the order they happened', async () => {
      const transport = createTransport()
      void transport.execute(request(), jest.fn().mockResolvedValue(response('http')))
      await flush()

      worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason: 'multi-tab-not-owner' })
      worker.emit({ type: 'STATE', state: 'CONNECTING' })
      worker.emit({ type: 'STATE', state: 'READY' })
      worker.emit({
        type: 'NEGOTIATED',
        sessionScope: SESSION_A,
        protocolVersion: 1,
        endpoint: 'wss://sync.example.test/sockets/sync',
        operations: ['SYNC_ITEMS'],
      })
      worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'server-kill' })
      await flush()

      const ledger = transport.laneDegradationLedger

      expect(ledger.transitions.map((entry) => [entry.state, entry.reason])).toEqual([
        ['HTTP_FALLBACK', 'multi-tab-not-owner'],
        ['CONNECTING', undefined],
        ['READY', undefined],
        ['DEGRADED', 'server-kill'],
      ])
      expect(ledger.fallbackCounts).toEqual({ 'multi-tab-not-owner': 1, 'server-kill': 1 })
      expect(ledger.transitionsDropped).toBe(0)
    })

    it('records whether the socket survived, as the worker reported it', async () => {
      const transport = createTransport()
      void transport.execute(request(), jest.fn().mockResolvedValue(response('http')))
      await flush()

      worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason: 'operation-unavailable', socketPreserved: true })
      worker.emit({ type: 'STATE', state: 'READY' })
      worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'server-kill' })
      await flush()

      expect(transport.laneDegradationLedger.transitions.map((entry) => entry.socketPreserved)).toEqual([
        true,
        false,
        false,
      ])
    })

    /**
     * *** THE REASON THE PANE WAS MISSING. ***
     *
     * `unsupported-browser` has been in the protocol since the lane was written, with
     * its own explanation sentence, and the only code that ever emitted it lives
     * inside the worker — which a browser failing this check never gets to start. So
     * the one client that can NEVER use the socket was also the one whose
     * "Reported fallback reason" row read "not reported".
     */
    it('names the browser as the reason when the environment cannot carry a socket at all', async () => {
      const transport = createTransport({
        environment: { hasWorker: false, hasWebSocket: true, hasIndexedDb: true },
      })
      const fallback = jest.fn().mockResolvedValue(response('http'))

      await expect(transport.execute(request(), fallback)).resolves.toEqual({ response: response('http') })

      expect(transport.transportStatus).toEqual({
        state: 'HTTP_ONLY',
        fallbackReason: 'unsupported-browser',
        operations: [],
      })
      expect(transport.laneDegradationLedger.fallbackCounts).toEqual({ 'unsupported-browser': 1 })
    })

    it('names the worker as the reason when the worker itself cannot be constructed', async () => {
      const transport = createTransport({
        workerFactory: () => {
          throw new Error('blocked by policy')
        },
      })
      const fallback = jest.fn().mockResolvedValue(response('http'))

      await expect(transport.execute(request(), fallback)).resolves.toEqual({ response: response('http') })

      expect(transport.transportStatus.fallbackReason).toBe('worker-error')
      expect(transport.laneDegradationLedger.fallbackCounts).toEqual({ 'worker-error': 1 })
    })

    /**
     * A STALE reason is worse than none: it pairs a state with a cause that has
     * already cleared, and the pane prints the two side by side as one reading.
     */
    it('clears a reason that no longer applies rather than carrying it into a shutdown', async () => {
      const transport = createTransport()
      // `deinit` rejects whatever is still in flight, which is the point of the
      // case; the rejection is absorbed here so it cannot fail the run as an
      // unhandled one.
      const inFlight = transport.execute(request(), jest.fn().mockResolvedValue(response('http')))
      inFlight.catch(() => undefined)
      await flush()
      worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason: 'multi-tab-not-owner' })
      await flush()
      expect(transport.transportStatus.fallbackReason).toBe('multi-tab-not-owner')

      transport.deinit()
      await expect(inFlight).rejects.toThrow('deinitialized')

      expect(transport.transportStatus).toEqual({ state: 'HTTP_ONLY', operations: [] })
      // The degradation that DID happen is still in the ledger — clearing the live
      // reason loses the current reading, never the history.
      expect(transport.laneDegradationLedger.fallbackCounts).toEqual({ 'multi-tab-not-owner': 1 })
    })

    it('does not open the ledger with the state the transport was constructed in', async () => {
      const transport = createTransport({ getAuthenticatedSessionScope: async () => undefined })

      await transport.execute(request(), jest.fn().mockResolvedValue(response('http')))

      expect(transport.transportStatus).toEqual({ state: 'HTTP_ONLY', operations: [] })
      expect(transport.laneDegradationLedger.transitions).toEqual([])
    })

    it('records a lane standing down on a socket that stays up', async () => {
      const transport = createTransport()
      const authorizing = transport.authorizeCollaborationRoom('note-1')
      await flush()
      worker.emit({ type: 'STATE', state: 'READY' })
      await flush()
      const open = worker.posts.find((message) => message.type === 'AUTHORIZE_COLLABORATION') as Extract<
        MainToSyncWorkerMessage,
        { type: 'AUTHORIZE_COLLABORATION' }
      >
      worker.emit({ type: 'COLLABORATION_FALLBACK', clientRequestId: open.clientRequestId, reason: 'proxy-failed' })
      await flush()
      await authorizing

      const ledger = transport.laneDegradationLedger
      const last = ledger.transitions[ledger.transitions.length - 1]

      expect(last).toMatchObject({ state: 'READY', reason: 'proxy-failed', socketPreserved: true })
      // READY is not a state that serves saves over HTTP, so this is NOT counted as
      // a degradation of the transport: one lane stood down, the rest did not.
      expect(ledger.fallbackCounts).toEqual({})
    })

    it('counts a refused control-plane read against the status it was refused with', () => {
      const transport = createTransport()

      transport.recordControlPlaneRejection(401)
      transport.recordControlPlaneRejection(498)
      transport.recordControlPlaneRejection(498)
      transport.recordControlPlaneRejection(503)

      expect(transport.laneDegradationLedger.controlPlaneRejections).toBe(3)
      expect(transport.laneDegradationLedger.controlPlaneRejectionsByStatus).toEqual({ 401: 1, 498: 2 })
    })

    it('stays bounded when the lane flaps far past the ring, and says how much it dropped', async () => {
      const transport = createTransport()
      void transport.execute(request(), jest.fn().mockResolvedValue(response('http')))
      await flush()

      for (let round = 0; round < 60; round += 1) {
        worker.emit({ type: 'STATE', state: 'HTTP_FALLBACK', reason: 'ack-timeout' })
        worker.emit({ type: 'STATE', state: 'READY' })
      }
      await flush()

      const ledger = transport.laneDegradationLedger

      expect(ledger.transitions).toHaveLength(LANE_LEDGER_TRANSITION_CAPACITY)
      expect(ledger.transitions.length + ledger.transitionsDropped).toBe(120)
      // The ring forgot most of them; the per-cause counter did not.
      expect(ledger.fallbackCounts).toEqual({ 'ack-timeout': 60 })
    })

    it('publishes nothing but closed codes, booleans, counts and relative ages', async () => {
      const transport = createTransport()
      void transport.execute(request(), jest.fn().mockResolvedValue(response('http')))
      await flush()
      worker.emit({ type: 'STATE', state: 'READY' })
      worker.emit({
        type: 'NEGOTIATED',
        sessionScope: SESSION_A,
        protocolVersion: 1,
        endpoint: 'wss://sync.example.test/sockets/sync',
        operations: ['SYNC_ITEMS'],
      })
      worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'server-kill' })
      await flush()

      const serialised = JSON.stringify(transport.laneDegradationLedger)

      expect(serialised).not.toContain('sync.example.test')
      expect(serialised).not.toContain('sockets/sync')
      expect(serialised).not.toContain('device-1')
      expect(serialised).not.toContain(SESSION_A)
      expect(serialised).not.toContain('ticketticket')
      // Not vacuous: the ledger really does carry this session's transitions.
      expect(serialised).toContain('server-kill')
    })
  })
})
