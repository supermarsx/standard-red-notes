import { SharedSyncTransportBroker, type BrokerRuntime, type BrokerPort } from './SharedSyncTransportBroker'
import type { MainToSyncWorkerMessage, SyncWorkerToMainMessage } from './syncTransportProtocol'

const scope = `sync-session-v1:${'a'.repeat(64)}`
const otherScope = `sync-session-v1:${'b'.repeat(64)}`

describe('shared authenticated socket broker', () => {
  let broker: SharedSyncTransportBroker
  let busy: boolean
  let now: number
  let runtime: BrokerRuntime & { handle: jest.Mock; detachBrokerClient: jest.Mock }
  let a: BrokerPort & { postMessage: jest.Mock }
  let b: BrokerPort & { postMessage: jest.Mock }
  const send = (id: 'a' | 'b', message: MainToSyncWorkerMessage) => broker.receive(id, id === 'a' ? a : b, message)
  const last = (port: typeof a) => port.postMessage.mock.calls.at(-1)?.[0] as SyncWorkerToMainMessage
  beforeEach(async () => {
    busy = false
    now = 0
    runtime = {
      handle: jest.fn(async (message: MainToSyncWorkerMessage) => {
        if (['EXECUTE', 'RECOVER', 'AUTHORIZE_COLLABORATION'].includes(message.type)) busy = true
        if (message.type === 'SESSION_REVOKED')
          broker.publish({ type: 'SESSION_REVOKED_ACK', requestId: message.requestId, sessionScope: scope })
      }),
      isBrokerPrimaryIdle: () => !busy,
      detachBrokerClient: jest.fn(async () => undefined),
    }
    broker = new SharedSyncTransportBroker(runtime, 'build', () => now)
    a = { postMessage: jest.fn() }
    b = { postMessage: jest.fn() }
    await broker.receive('a', a, { type: 'BROKER_ATTACH', sessionScope: scope, revision: 'build' })
    await broker.receive('b', b, { type: 'BROKER_ATTACH', sessionScope: scope, revision: 'build' })
  })

  it('broadcasts local storage health to current clients and replays the latest recovery state to late clients', async () => {
    const failure: SyncWorkerToMainMessage = { type: 'LOCAL_STORAGE_HEALTH', code: 'quota-exceeded' }
    broker.publish(failure)
    expect(last(a)).toEqual(failure)
    expect(last(b)).toEqual(failure)
    const late = { postMessage: jest.fn() }
    await broker.receive('late', late, { type: 'BROKER_ATTACH', sessionScope: scope, revision: 'build' })
    expect(last(late)).toEqual(failure)
    const recovered: SyncWorkerToMainMessage = { type: 'LOCAL_STORAGE_HEALTH', code: 'write-ok' }
    broker.publish(recovered)
    expect(last(a)).toEqual(recovered)
    expect(last(late)).toEqual(recovered)
    const later = { postMessage: jest.fn() }
    await broker.receive('later', later, { type: 'BROKER_ATTACH', sessionScope: scope, revision: 'build' })
    expect(last(later)).toEqual(recovered)
  })

  it('isolates colliding tab request IDs and fairly queues both notes through one runtime', async () => {
    const request = (note: string): MainToSyncWorkerMessage => ({
      type: 'EXECUTE',
      clientRequestId: 'same-id',
      sessionScope: scope,
      body: { items: [{ uuid: note }] } as never,
    })
    await send('a', request('note-a'))
    await send('b', request('note-b'))
    expect(runtime.handle).toHaveBeenCalledTimes(1)
    expect(runtime.handle).toHaveBeenLastCalledWith(expect.objectContaining({ clientRequestId: 'a:same-id' }))
    broker.publish({
      type: 'RESULT',
      clientRequestId: 'a:same-id',
      commandId: 'command-a',
      result: { saved_items: [] },
    })
    expect(last(a)).toMatchObject({ type: 'RESULT', clientRequestId: 'same-id' })
    expect(last(b)).toMatchObject({ type: 'WORKER_BUILD' })
    busy = false
    await broker.pump()
    expect(runtime.handle).toHaveBeenLastCalledWith(expect.objectContaining({ clientRequestId: 'b:same-id' }))
    await send('a', {
      type: 'CHECKPOINT_DURABLE',
      requestId: 'checkpoint',
      sessionScope: scope,
      commandId: 'command-a',
    })
    broker.publish({
      type: 'CHECKPOINT_CLEARED',
      requestId: 'a:checkpoint',
      sessionScope: scope,
      commandId: 'command-a',
    })
    expect(last(a)).toMatchObject({ type: 'CHECKPOINT_CLEARED', requestId: 'checkpoint' })
  })

  it('delivers scoped save refusals to every attached tab without caching them as a lane outage', async () => {
    const refusal = {
      type: 'SAVE_ITEMS_REFUSED',
      items: [{ uuid: 'room', fenceToken: 'old-proof' }],
      holdForMilliseconds: 30_000,
    } as const
    broker.publish({ ...refusal, items: [...refusal.items] })
    expect(last(a)).toEqual(refusal)
    expect(last(b)).toEqual(refusal)
    const newcomer = { postMessage: jest.fn() }
    await broker.receive('c', newcomer, { type: 'BROKER_ATTACH', sessionScope: scope, revision: 'build' })
    expect(newcomer.postMessage.mock.calls.some(([message]) => message.type === 'SAVE_ITEMS_REFUSED')).toBe(false)
  })

  it('binds RPC proof ownership to the port and detaches completed work with that identity', async () => {
    runtime.registerBrokerRpcOwner = jest.fn()
    await send('a', {
      type: 'OPEN_RPC',
      clientRequestId: 'claim',
      sessionScope: scope,
      request: {
        method: 'POST',
        path: '/v1/collaboration/save-fence',
        deadlineMs: 2_000,
        initialCreditBytes: 4_096,
        stream: false,
        idempotencyKey: 'claim',
        body: {},
      },
    })
    expect(runtime.registerBrokerRpcOwner).toHaveBeenCalledWith('a:claim', 'a')
    broker.publish({ type: 'RPC_END', clientRequestId: 'a:claim' })
    await broker.receive('a', a, { type: 'BROKER_DETACH' })
    expect(runtime.detachBrokerClient).toHaveBeenCalledWith(new Set(), 'a')
    expect(broker.hasClients).toBe(true)
  })

  it('merges per-room savers without letting a follower disable or impersonate its owning port', async () => {
    await send('a', { type: 'SET_COLLABORATION_SAVER', room: 'same-note', canSave: true })
    await send('b', { type: 'SET_COLLABORATION_SAVER', room: 'same-note', canSave: false })
    expect(runtime.handle).toHaveBeenLastCalledWith({
      type: 'SET_COLLABORATION_SAVER',
      room: 'same-note',
      canSave: true,
    })
    await send('b', {
      type: 'EXECUTE',
      clientRequestId: 'follower',
      sessionScope: scope,
      body: { items: [{ uuid: 'same-note' }, { uuid: 'unrelated-note' }] } as never,
    })
    expect(last(b)).toEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'follower', reason: 'socket-save-refused' })
    expect(b.postMessage).toHaveBeenCalledWith({
      type: 'SAVE_ITEMS_REFUSED',
      protectItems: true,
      items: [{ uuid: 'same-note' }],
      holdForMilliseconds: 30_000,
    })
    expect(a.postMessage.mock.calls.some(([message]) => message.type === 'SAVE_ITEMS_REFUSED')).toBe(false)
    expect(runtime.handle.mock.calls.some(([message]) => message.type === 'EXECUTE')).toBe(false)
    await send('b', {
      type: 'EXECUTE',
      clientRequestId: 'unrelated',
      sessionScope: scope,
      body: { items: [{ uuid: 'unrelated-note' }] } as never,
    })
    expect(runtime.handle).toHaveBeenLastCalledWith(expect.objectContaining({ clientRequestId: 'b:unrelated' }))
    await broker.detach('a')
    expect(runtime.handle).toHaveBeenCalledWith({ type: 'SET_COLLABORATION_SAVER', room: 'same-note', canSave: false })
  })

  it('keeps readiness and socket alive when the first tab closes, including its pending ticket', async () => {
    await send('a', { type: 'KEEP_SOCKET_READY', clientRequestId: 'ready-a', sessionScope: scope })
    await send('b', { type: 'KEEP_SOCKET_READY', clientRequestId: 'ready-b', sessionScope: scope })
    const keep = runtime.handle.mock.calls.find(([message]) => message.type === 'KEEP_SOCKET_READY')![0]
    broker.publish({ type: 'NEED_TICKET', clientRequestId: keep.clientRequestId, reconnect: false })
    expect(last(a)).toMatchObject({ type: 'NEED_TICKET', clientRequestId: 'ready-a' })
    await broker.detach('a')
    expect(last(b)).toMatchObject({ type: 'NEED_TICKET', clientRequestId: 'ready-b' })
    await send('b', {
      type: 'CONNECT',
      clientRequestId: 'ready-b',
      sessionScope: scope,
      authorization: {
        endpoint: 'wss://example.test/sync',
        ticket: 'opaque',
        deviceId: 'same-device',
        expiresAt: 1000,
      },
    })
    expect(runtime.handle).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'CONNECT', clientRequestId: keep.clientRequestId }),
    )
    expect(
      runtime.handle.mock.calls.some(
        ([message]) => message.type === 'SHUTDOWN' || message.type === 'RELEASE_SOCKET_READY',
      ),
    ).toBe(false)
  })

  it.each(['OPEN_RPC', 'OPEN_FILE_DOWNLOAD', 'OPEN_FILE_UPLOAD'] as const)(
    'routes %s chunks, credit and cancellation to the originating port',
    async (type) => {
      await send('a', { type, clientRequestId: 'stream', sessionScope: scope, request: {} } as MainToSyncWorkerMessage)
      await send('b', { type, clientRequestId: 'stream', sessionScope: scope, request: {} } as MainToSyncWorkerMessage)
      const output =
        type === 'OPEN_RPC'
          ? { type: 'RPC_CHUNK', clientRequestId: 'b:stream', bytes: 'ciphertext', byteLength: 10 }
          : type === 'OPEN_FILE_DOWNLOAD'
            ? { type: 'FILE_DOWNLOAD_CHUNK', clientRequestId: 'b:stream', bytes: new Uint8Array([1, 2]), offset: 0 }
            : { type: 'FILE_UPLOAD_COMPLETE', clientRequestId: 'b:stream', sha256: 'ciphertext-digest' }
      broker.publish(output as SyncWorkerToMainMessage)
      expect(last(b)).toMatchObject({ clientRequestId: 'stream', type: output.type })
      expect(last(a)).toMatchObject({ type: 'WORKER_BUILD' })
      if (type === 'OPEN_RPC') {
        await send('b', { type: 'RPC_CREDIT', clientRequestId: 'stream', creditBytes: 10 })
        await send('b', { type: 'CANCEL_RPC', clientRequestId: 'stream' })
        expect(runtime.handle).toHaveBeenLastCalledWith({ type: 'CANCEL_RPC', clientRequestId: 'b:stream' })
      }
    },
  )

  it('fans out one invite stream and waits for all consumers before acknowledging', async () => {
    await send('a', { type: 'SUBSCRIBE_INVITE_EVENTS', clientRequestId: 'invite-a', sessionScope: scope, limit: 50 })
    await send('b', { type: 'SUBSCRIBE_INVITE_EVENTS', clientRequestId: 'invite-b', sessionScope: scope, limit: 50 })
    const subscription = runtime.handle.mock.calls.find(([message]) => message.type === 'SUBSCRIBE_INVITE_EVENTS')![0]
    broker.publish({ type: 'INVITE_READY', clientRequestId: subscription.clientRequestId, cursor: 'cursor-before' })
    broker.publish({
      type: 'INVITE_BATCH',
      clientRequestId: subscription.clientRequestId,
      batch: { nextCursor: 'cursor-after', events: [] } as never,
    })
    expect(last(a)).toMatchObject({ type: 'INVITE_BATCH', clientRequestId: 'invite-a' })
    expect(last(b)).toMatchObject({ type: 'INVITE_BATCH', clientRequestId: 'invite-b' })
    await send('a', { type: 'ACK_INVITE_EVENTS', clientRequestId: 'invite-a', cursor: 'cursor-after' })
    expect(runtime.handle.mock.calls.some(([message]) => message.type === 'ACK_INVITE_EVENTS')).toBe(false)
    await send('b', { type: 'ACK_INVITE_EVENTS', clientRequestId: 'invite-b', cursor: 'cursor-after' })
    expect(runtime.handle).toHaveBeenLastCalledWith({
      type: 'ACK_INVITE_EVENTS',
      clientRequestId: subscription.clientRequestId,
      cursor: 'cursor-after',
    })
  })

  it('sends a credential refresh to a surviving port and admits only its correlated answer', async () => {
    broker.publish({ type: 'NEED_SESSION_REFRESH', refreshId: 'refresh', sessionScope: scope })
    await send('b', { type: 'SESSION_REFRESH_TICKET', refreshId: 'refresh', ticket: 'opaque', deviceId: 'device' })
    expect(runtime.handle).not.toHaveBeenCalled()
    await broker.detach('a')
    expect(last(b)).toEqual({ type: 'NEED_SESSION_REFRESH', refreshId: 'refresh', sessionScope: scope })
    await send('b', { type: 'SESSION_REFRESH_TICKET', refreshId: 'refresh', ticket: 'opaque', deviceId: 'device' })
    expect(runtime.handle).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'SESSION_REFRESH_TICKET' }))
  })

  it('resumes the underlying invite stream after a server reconciliation request', async () => {
    await send('a', { type: 'SUBSCRIBE_INVITE_EVENTS', clientRequestId: 'invite-a', sessionScope: scope, limit: 50 })
    await send('b', { type: 'SUBSCRIBE_INVITE_EVENTS', clientRequestId: 'invite-b', sessionScope: scope, limit: 50 })
    const subscription = runtime.handle.mock.calls.find(([message]) => message.type === 'SUBSCRIBE_INVITE_EVENTS')![0]
    broker.publish({
      type: 'INVITE_RECONCILE',
      clientRequestId: subscription.clientRequestId,
      reason: 'CURSOR_EXPIRED',
      cursor: 'fresh-cursor',
    })
    expect(last(b)).toMatchObject({ type: 'INVITE_RECONCILE', clientRequestId: 'invite-b' })
    await send('b', {
      type: 'SUBSCRIBE_INVITE_EVENTS',
      clientRequestId: 'invite-b',
      sessionScope: scope,
      cursor: 'fresh-cursor',
      limit: 50,
    })
    expect(runtime.handle).toHaveBeenLastCalledWith({
      type: 'SUBSCRIBE_INVITE_EVENTS',
      clientRequestId: subscription.clientRequestId,
      sessionScope: scope,
      cursor: 'fresh-cursor',
      limit: 50,
    })
  })

  it('keeps non-streaming response ownership through END and removes it only after completion', async () => {
    await send('a', {
      type: 'OPEN_RPC',
      clientRequestId: 'claim',
      sessionScope: scope,
      request: {},
    } as MainToSyncWorkerMessage)
    broker.publish({
      type: 'RPC_RESPONSE',
      clientRequestId: 'a:claim',
      status: 200,
      headers: {},
      stream: false,
      body: { room: 'note', token: 'opaque-proof' },
    })
    expect(last(a)).toMatchObject({ type: 'RPC_RESPONSE', clientRequestId: 'claim' })
    broker.publish({ type: 'RPC_END', clientRequestId: 'a:claim' })
    expect(last(a)).toEqual({ type: 'RPC_END', clientRequestId: 'claim' })
    const count = a.postMessage.mock.calls.length
    broker.publish({ type: 'RPC_END', clientRequestId: 'a:claim' })
    expect(a.postMessage).toHaveBeenCalledTimes(count)
  })

  it('quarantines once, notifies siblings, and rejects any subsequent command', async () => {
    await send('a', { type: 'SESSION_REVOKED', requestId: 'revoke-a', sessionScope: scope })
    expect(last(a)).toEqual({ type: 'SESSION_REVOKED_ACK', requestId: 'revoke-a', sessionScope: scope })
    expect(last(b)).toEqual({ type: 'SESSION_NOT_AUTHORIZED', sessionScope: scope })
    await send('b', { type: 'SESSION_REVOKED', requestId: 'revoke-b', sessionScope: scope })
    expect(last(b)).toEqual({ type: 'SESSION_REVOKED_ACK', requestId: 'revoke-b', sessionScope: scope })
    await send('b', { type: 'RECOVER', clientRequestId: 'after-revoke', sessionScope: scope })
    expect(runtime.handle).toHaveBeenCalledTimes(1)
  })

  it('does not fabricate a successful quarantine when durable storage fails', async () => {
    runtime.handle.mockImplementation(async (message: MainToSyncWorkerMessage) => {
      if (message.type === 'SESSION_REVOKED')
        broker.publish({ type: 'SESSION_REVOKED_FAILED', requestId: message.requestId, sessionScope: scope })
    })
    await send('a', { type: 'SESSION_REVOKED', requestId: 'revoke', sessionScope: scope })
    await send('b', { type: 'SESSION_REVOKED', requestId: 'revoke', sessionScope: scope })
    expect(last(a)).toMatchObject({ type: 'SESSION_REVOKED_FAILED' })
    expect(last(b)).toMatchObject({ type: 'SESSION_REVOKED_FAILED' })
  })

  it('refuses cross-session ports and messages and expires only inactive consumers', async () => {
    const foreign = { postMessage: jest.fn() }
    await broker.receive('foreign', foreign, { type: 'BROKER_ATTACH', sessionScope: otherScope, revision: 'build' })
    expect(foreign.postMessage).toHaveBeenCalledWith({ type: 'SESSION_NOT_AUTHORIZED', sessionScope: otherScope })
    await send('b', { type: 'RECOVER', clientRequestId: 'bad-scope', sessionScope: otherScope })
    expect(runtime.handle).not.toHaveBeenCalled()
    now = 120_001
    await broker.receive('b', b, { type: 'BROKER_HEARTBEAT' })
    await broker.expireInactivePorts()
    expect(last(a)).toEqual({ type: 'SHUTDOWN_COMPLETE' })
    expect(broker.hasClients).toBe(true)
    expect(runtime.handle.mock.calls.some(([message]) => message.type === 'SHUTDOWN')).toBe(false)
  })
})
