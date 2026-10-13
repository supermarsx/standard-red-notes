import type { AccountSyncTransportRequest } from '@standardnotes/services'
import type { HttpResponse, RawSyncResponse } from '@standardnotes/snjs'
import { MainToSyncWorkerMessage, SyncWorkerToMainMessage } from './syncTransportProtocol'
import {
  SyncSaveLane,
  SyncTransportControlPlane,
  WebSocketSyncTransport,
  type WebSocketSyncTransportOptions,
} from './WebSocketSyncTransport'

/**
 * *** LIVE COLLABORATION ASKS ONE QUESTION OF THE TRANSPORT: WOULD A SAVE MADE NOW
 * RIDE THE SOCKET? ***
 *
 * A room's body must never be saved over HTTP while other people are in it, so the
 * client that saves for a room is chosen among those whose saves ride the socket.
 * Until now nothing on the main thread could say so: the worker's refusal hold was
 * private to the worker, and a READY socket that negotiated SYNC_ITEMS looked
 * exactly the same while every save was being refused and sent over HTTP.
 */
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

  terminate(): void {
    this.terminated = true
  }
}

const SESSION_A = `sync-session-v1:${'a'.repeat(64)}`

const request = (): AccountSyncTransportRequest => ({
  api: '20240226',
  items: [{ uuid: 'one', content: 'cipher-one' }],
  sync_token: 'token-one',
  limit: 150,
})

const response = (): HttpResponse<RawSyncResponse> =>
  ({ status: 200, data: { retrieved_items: [], saved_items: [], sync_token: 'next' } }) as never

const flush = async () => {
  for (let index = 0; index < 5; index++) {
    await Promise.resolve()
  }
}

describe('WebSocketSyncTransport save lane', () => {
  let worker: FakeWorker
  let controlPlane: jest.Mocked<SyncTransportControlPlane>

  beforeEach(() => {
    localStorage.clear()
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-10-13T12:00:00Z'))
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

  afterEach(() => {
    jest.useRealTimers()
  })

  const createTransport = (options: Partial<WebSocketSyncTransportOptions> = {}) =>
    new WebSocketSyncTransport({
      controlPlane,
      getConfiguredWebSocketUrl: () => 'wss://sync.example.test',
      getAuthenticatedSessionScope: async () => SESSION_A,
      deviceId: 'device-1',
      workerFactory: () => worker,
      environment: { hasWorker: true, hasWebSocket: true, hasIndexedDb: true },
      isHttpOnly: () => false,
      ...options,
    })

  /** A transport whose worker exists, with the socket READY and the given operations negotiated. */
  const readyTransport = async (operations: Array<'SYNC_ITEMS' | 'AUTHORIZE_COLLABORATION'>) => {
    const transport = createTransport()
    void transport.execute(request(), jest.fn().mockResolvedValue(response())).catch(() => undefined)
    await flush()
    worker.emit({ type: 'STATE', state: 'READY' })
    worker.emit({
      type: 'NEGOTIATED',
      sessionScope: SESSION_A,
      protocolVersion: 1,
      endpoint: 'wss://sync.example.test/sockets/sync',
      operations,
    })
    return transport
  }

  it('blocks a live save fallback even after the socket lane fails mid-command', async () => {
    const transport = createTransport()
    transport.requireSocketSavesForItem('one')
    const fallback = jest.fn().mockResolvedValue(response())
    const execution = transport.execute(request(), fallback)
    const outcome = expect(execution).rejects.toThrow('require the socket')
    await flush()
    const message = worker.posts.find((entry) => entry.type === 'EXECUTE')!
    expect(message).toMatchObject({ context: { socketOnly: true } })
    worker.emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: (message as { clientRequestId: string }).clientRequestId,
      reason: 'save-refused',
      body: request(),
    })
    await outcome
    expect(fallback).not.toHaveBeenCalled()
    transport.deinit()
  })

  it('persists socketOnly when a queued request becomes protected before ordered dispatch', async () => {
    const proof = { room: 'one', token: 'a'.repeat(64) }
    const transport = createTransport({ getCollaborationSaveFence: () => proof })
    const execution = transport.execute(request(), jest.fn())
    const rejected = expect(execution).rejects.toThrow('Durable sync recovery')
    // execute() captured an ordinary context; the provider installs before the
    // queued callback reaches its worker boundary.
    transport.requireSocketSavesForItem('one')
    await flush()
    const execute = worker.posts.find((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
    expect(execute.context?.socketOnly).toBe(true)
    expect(execute.body.collaboration_save_fences).toEqual([proof])
    worker.emit({ type: 'RECOVERY_REQUIRED', clientRequestId: execute.clientRequestId })
    await rejected
    transport.deinit()
  })

  it('retains a dirty live constraint across a reload but releases a clean departed room', async () => {
    const transport = createTransport()
    transport.requireSocketSavesForItem('one')
    transport.releaseSocketSavesForItem('one', false)
    const reloaded = createTransport()
    const fallback = jest.fn().mockResolvedValue(response())
    const execution = reloaded.execute(request(), fallback)
    const outcome = expect(execution).rejects.toThrow('require the socket')
    await flush()
    const message = worker.posts.find((entry) => entry.type === 'EXECUTE')!
    worker.emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: (message as { clientRequestId: string }).clientRequestId,
      reason: 'save-refused',
      body: request(),
    })
    await outcome
    reloaded.releaseSocketSavesForItem('one', true)
    expect(localStorage.getItem('standardnotes-collaboration-socket-only:device-1')).toBe('[]')
    transport.deinit()
    reloaded.deinit()
  })

  it('an older acknowledgement cannot clear the marker while a newer revision remains dirty', async () => {
    const transport = createTransport({ isItemServerAcknowledged: () => false })
    transport.requireSocketSavesForItem('one')
    const execution = transport.execute(request(), jest.fn())
    await flush()
    const execute = worker.posts.find((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
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
      result: { retrieved_items: [], saved_items: [{ uuid: 'one' }], sync_token: 'next' },
    })
    const result = await execution
    transport.releaseSocketSavesForItem('one', false)
    const checkpoint = result.markCheckpointDurable!()
    await flush()
    const message = worker.posts.find((entry) => entry.type === 'CHECKPOINT_DURABLE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'CHECKPOINT_DURABLE' }
    >
    worker.emit({
      type: 'CHECKPOINT_CLEARED',
      requestId: message.requestId,
      sessionScope: SESSION_A,
      commandId: 'command-1',
    })
    await checkpoint
    expect(localStorage.getItem('standardnotes-collaboration-socket-only:device-1')).toBe('["one"]')
    transport.deinit()
  })

  it('a delayed former saver batch cannot dispatch after leadership changes', async () => {
    const transport = createTransport({ canSaveCollaborativeItem: () => false })
    transport.requireSocketSavesForItem('one')
    const fallback = jest.fn()
    await expect(transport.execute(request(), fallback)).rejects.toThrow('Only the elected')
    expect(worker.posts.some((entry) => entry.type === 'EXECUTE')).toBe(false)
    expect(fallback).not.toHaveBeenCalled()
    transport.deinit()
  })

  it('allows unrelated ordinary HTTP sync while a paused room remains dirty and protected', async () => {
    const transport = createTransport()
    transport.requireSocketSavesForItem('one')
    transport.setCollaborationSaver('one', false)
    expect(transport.isCollaborativeItemUploadAllowed('one')).toBe(false)
    expect(transport.isCollaborativeItemUploadAllowed('personal')).toBe(true)
    const personal = { ...request(), items: [{ uuid: 'personal', content: 'cipher-personal' }] }
    const fallback = jest.fn().mockResolvedValue(response())
    const execution = transport.execute(personal, fallback)
    await flush()
    const message = worker.posts.find((entry) => entry.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
    worker.emit({
      type: 'HTTP_FALLBACK',
      clientRequestId: message.clientRequestId,
      reason: 'save-refused',
      body: personal,
    })
    await execution
    expect(fallback).toHaveBeenCalledWith(personal, undefined)
    expect(localStorage.getItem('standardnotes-collaboration-socket-only:device-1')).toBe('["one"]')
    transport.deinit()
  })

  it('a reopened failed drain retries only over a healthy socket while an active non-saver stays excluded', async () => {
    const transport = createTransport({ isItemServerAcknowledged: () => true })
    // A failed close retains its body/constraint; there is no live editor now.
    transport.requireSocketSavesForItem('one')
    transport.setCollaborationSaver('one', false)
    transport.releaseSocketSavesForItem('one', false)
    expect(transport.isCollaborativeItemUploadAllowed('one')).toBe(false)
    // Reopening boots the ordinary authenticated socket, with no room lease yet.
    const personal = { ...request(), items: [{ uuid: 'personal' }] }
    const boot = transport.execute(personal, jest.fn())
    const bootRejected = boot.catch(() => undefined)
    await flush()
    worker.emit({ type: 'STATE', state: 'READY' })
    worker.emit({
      type: 'NEGOTIATED',
      sessionScope: SESSION_A,
      protocolVersion: 1,
      endpoint: 'wss://sync.example.test/sockets/sync',
      operations: ['SYNC_ITEMS'],
    })
    expect(transport.isCollaborativeItemUploadAllowed('one')).toBe(true)
    const bootMessage = worker.posts.find((message) => message.type === 'EXECUTE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
    worker.emit({ type: 'RECOVERY_REQUIRED', clientRequestId: bootMessage.clientRequestId })
    await bootRejected
    const fallback = jest.fn()
    const retry = transport.execute(request(), fallback)
    await flush()
    const execute = worker.posts.filter((message) => message.type === 'EXECUTE').at(-1) as Extract<
      MainToSyncWorkerMessage,
      { type: 'EXECUTE' }
    >
    expect(execute.context?.socketOnly).toBe(true)
    expect(worker.posts).toContainEqual({ type: 'SET_COLLABORATION_SAVER', room: 'one', canSave: true })
    worker.emit({
      type: 'COMMAND_PERSISTED',
      clientRequestId: execute.clientRequestId,
      body: request(),
      command: { id: 'retry-command', digest: 'b'.repeat(64), sequence: 2 },
    })
    worker.emit({
      type: 'RESULT',
      clientRequestId: execute.clientRequestId,
      commandId: 'retry-command',
      result: { retrieved_items: [], saved_items: [{ uuid: 'one' }], sync_token: 'recovered' },
    })
    const result = await retry
    const checkpoint = result.markCheckpointDurable!()
    await flush()
    const barrier = worker.posts.find((message) => message.type === 'CHECKPOINT_DURABLE') as Extract<
      MainToSyncWorkerMessage,
      { type: 'CHECKPOINT_DURABLE' }
    >
    worker.emit({
      type: 'CHECKPOINT_CLEARED',
      requestId: barrier.requestId,
      sessionScope: SESSION_A,
      commandId: 'retry-command',
    })
    await checkpoint
    expect(fallback).not.toHaveBeenCalled()
    expect(localStorage.getItem('standardnotes-collaboration-socket-only:device-1')).toBe('[]')
    transport.requireSocketSavesForItem('one')
    transport.setCollaborationSaver('one', false)
    expect(transport.isCollaborativeItemUploadAllowed('one')).toBe(false)
    transport.deinit()
  })

  it('reads unusable before any socket exists', () => {
    expect(createTransport().saveLane).toEqual({ usable: false, code: 'SOCKET_NOT_READY' })
  })

  it('reads usable only on a READY socket that negotiated SYNC_ITEMS', async () => {
    const transport = await readyTransport(['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION'])
    expect(transport.saveLane).toEqual({ usable: true })

    worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'server-kill' })
    expect(transport.saveLane).toEqual({ usable: false, code: 'SOCKET_NOT_READY' })
  })

  it('reads unusable on a READY socket that carries no item sync', async () => {
    const transport = await readyTransport(['AUTHORIZE_COLLABORATION'])
    expect(transport.saveLane).toEqual({ usable: false, code: 'SYNC_ITEMS_UNAVAILABLE' })
  })

  it('is held for the refusal window the worker reports, and usable again when it runs out', async () => {
    const transport = await readyTransport(['SYNC_ITEMS'])
    const seen: SyncSaveLane[] = []
    transport.subscribeSaveLane((lane) => seen.push(lane))

    worker.emit({ type: 'SAVE_LANE', held: true, code: 'NOT_AUTHORIZED', holdForMilliseconds: 30_000 })
    const heldUntil = Date.now() + 30_000
    expect(transport.saveLane).toEqual({ usable: false, code: 'NOT_AUTHORIZED', heldUntil })
    expect(seen).toEqual([{ usable: false, code: 'NOT_AUTHORIZED', heldUntil }])

    jest.advanceTimersByTime(29_999)
    expect(transport.saveLane.usable).toBe(false)
    expect(seen).toHaveLength(1)

    // The window ends by the clock; the worker posts nothing for that.
    jest.advanceTimersByTime(1)
    expect(transport.saveLane).toEqual({ usable: true })
    expect(seen).toEqual([{ usable: false, code: 'NOT_AUTHORIZED', heldUntil }, { usable: true }])
  })

  it('is usable again at once when a socket commit or a fresh socket clears the hold', async () => {
    const transport = await readyTransport(['SYNC_ITEMS'])
    const listener = jest.fn()
    transport.subscribeSaveLane(listener)

    worker.emit({ type: 'SAVE_LANE', held: true, code: 'NOT_AUTHORIZED', holdForMilliseconds: 600_000 })
    worker.emit({ type: 'SAVE_LANE', held: false })

    expect(transport.saveLane).toEqual({ usable: true })
    expect(listener).toHaveBeenLastCalledWith({ usable: true })
  })

  it('stays held after live sync is switched off, however long it waits', async () => {
    const transport = await readyTransport(['SYNC_ITEMS'])
    worker.emit({ type: 'SAVE_LANE', held: true, code: 'LIVE_SYNC_DISABLED' })
    // The worker re-reports READY after its own fallback; the verdict outlives it.
    worker.emit({ type: 'STATE', state: 'READY' })
    jest.advanceTimersByTime(3_600_000)

    expect(transport.saveLane).toEqual({ usable: false, code: 'LIVE_SYNC_DISABLED' })
  })

  it('treats a hold it cannot read as a hold, never as a usable lane', async () => {
    const transport = await readyTransport(['SYNC_ITEMS'])
    worker.emit({ type: 'SAVE_LANE', held: true, code: 'SOMETHING_NEWER' as never, holdForMilliseconds: -5 })

    expect(transport.saveLane.usable).toBe(false)
    jest.advanceTimersByTime(30_000)
    expect(transport.saveLane).toEqual({ usable: true })
  })

  it('tells observers only of changes, and forgets them at deinit', async () => {
    const transport = await readyTransport(['SYNC_ITEMS'])
    const listener = jest.fn()
    const unsubscribe = transport.subscribeSaveLane(listener)

    worker.emit({ type: 'STATE', state: 'READY' })
    worker.emit({ type: 'STATE', state: 'READY' })
    expect(listener).not.toHaveBeenCalled()

    unsubscribe()
    worker.emit({ type: 'STATE', state: 'DEGRADED', reason: 'server-kill' })
    expect(listener).not.toHaveBeenCalled()

    worker.emit({ type: 'STATE', state: 'READY' })
    const second = jest.fn()
    transport.subscribeSaveLane(second)
    worker.emit({ type: 'SAVE_LANE', held: true, code: 'READ_ONLY', holdForMilliseconds: 600_000 })
    transport.deinit()
    // Told once that the lane is gone, then never again: no timer outlives deinit.
    expect(second).toHaveBeenCalledTimes(2)
    expect(second).toHaveBeenLastCalledWith({ usable: false, code: 'SOCKET_NOT_READY' })
    jest.advanceTimersByTime(600_000)
    worker.emit({ type: 'STATE', state: 'READY' })
    expect(second).toHaveBeenCalledTimes(2)
  })
})
