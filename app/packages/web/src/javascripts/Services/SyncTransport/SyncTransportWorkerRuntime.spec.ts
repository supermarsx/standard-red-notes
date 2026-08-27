import type { AccountSyncTransportRequest } from '@standardnotes/services'
import { SyncOutboxRecord, SyncOutboxStore } from './SyncTransportOutbox'
import { SyncSocketLike, SyncTransportWorkerRuntime } from './SyncTransportWorkerRuntime'
import {
  CollaborationAuthorizationTransportRequest,
  MainToSyncWorkerMessage,
  payloadByteLength,
  SyncServerFrame,
  SyncWorkerToMainMessage,
  decodeFileBinaryFrame,
  utf8Bytes,
} from './syncTransportProtocol'

class FakeOutbox implements SyncOutboxStore {
  records = new Map<string, SyncOutboxRecord>()
  owners = new Map<string, { sessionScope: string; ownerId: string; expiresAt: number }>()
  failWrites = false

  async put(record: SyncOutboxRecord): Promise<void> {
    if (this.failWrites) {
      throw new Error('idb unavailable')
    }
    this.records.set(record.commandId, { ...record })
  }

  async oldest(sessionScope: string): Promise<SyncOutboxRecord | undefined> {
    return [...this.records.values()]
      .filter((record) => record.sessionScope === sessionScope && record.revoked !== true)
      .sort((left, right) => left.createdAt - right.createdAt)[0]
  }

  async quarantineSessionScope(sessionScope: string): Promise<void> {
    for (const [commandId, record] of this.records) {
      if (record.sessionScope === sessionScope) {
        this.records.set(commandId, { ...record, revoked: true })
      }
    }
  }

  async delete(sessionScope: string, commandId: string): Promise<void> {
    if (this.records.get(commandId)?.sessionScope === sessionScope) {
      this.records.delete(commandId)
    }
  }

  async acquireOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    const current = this.owners.get(transportScope)
    if (current && current.sessionScope === sessionScope && current.ownerId !== ownerId && current.expiresAt > now) {
      return false
    }
    this.owners.set(transportScope, { sessionScope, ownerId, expiresAt: now + ttlMs })
    return true
  }

  async renewOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    const current = this.owners.get(transportScope)
    if (current?.sessionScope !== sessionScope || current.ownerId !== ownerId || current.expiresAt <= now) {
      return false
    }
    this.owners.set(transportScope, { sessionScope, ownerId, expiresAt: now + ttlMs })
    return true
  }

  async releaseOwner(transportScope: string, sessionScope: string, ownerId: string): Promise<void> {
    const current = this.owners.get(transportScope)
    if (current?.sessionScope === sessionScope && current.ownerId === ownerId) {
      this.owners.delete(transportScope)
    }
  }

  close(): void {}
}

class FakeSocket implements SyncSocketLike {
  readyState = 0
  bufferedAmount = 0
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code?: number }) => void) | null = null
  sent: string[] = []

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  send(data: string): void {
    this.sent.push(data)
  }

  sentBinary: Uint8Array[] = []

  sendBinary(data: Uint8Array): void {
    this.sentBinary.push(data)
  }

  receive(frame: SyncServerFrame | string): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) })
  }

  receiveBinary(bytes: Uint8Array): void {
    this.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
  }

  close(code = 1000): void {
    if (this.readyState === 3) {
      return
    }
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const body = (suffix = 'a'): AccountSyncTransportRequest => ({
  api: '20240226',
  items: [{ uuid: `note-${suffix}`, content: `cipher-${suffix}` }],
  sync_token: `token-${suffix}`,
  limit: 150,
})

const SESSION_A = `sync-session-v1:${'a'.repeat(64)}`
const SESSION_B = `sync-session-v1:${'b'.repeat(64)}`
const ROOM_EPOCH = 'room_epoch_00000001'
const SECURITY_EPOCH = 'security_epoch_0001'

const serverFrame = (
  type: SyncServerFrame['type'],
  commandId: string,
  payload: Record<string, unknown>,
  digest?: string,
): SyncServerFrame => ({
  version: 1,
  channel: 'sync',
  type,
  requestId: 'server-request',
  commandId,
  sequence: 1,
  payloadLength: payloadByteLength(payload),
  payload,
  ...(digest ? { digest } : {}),
})

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const REMOTE_IDENTIFIER = 'remote-identifier-9f3c.a:b-1'
const FILE_UUID = '11111111-1111-4111-8111-111111111111'
/** The setup harness stubs SubtleCrypto.digest with a constant 0xab..ab. */
const STUB_DIGEST_HEX = 'ab'.repeat(32)

/** Mirrors the gateway's `encodeFileBinaryFrame` so tests exercise the real decoder. */
const fileBinaryFrame = (header: Record<string, unknown>, bytes: Uint8Array): Uint8Array => {
  const headerBytes = utf8Bytes(JSON.stringify(header))
  const frame = new Uint8Array(8 + headerBytes.byteLength + bytes.byteLength)
  frame.set([0x53, 0x52, 0x4e, 0x46], 0)
  frame[4] = 1
  frame[5] = header.kind === 'UPLOAD_CHUNK' ? 1 : 2
  frame[6] = (headerBytes.byteLength >> 8) & 0xff
  frame[7] = headerBytes.byteLength & 0xff
  frame.set(headerBytes, 8)
  frame.set(bytes, 8 + headerBytes.byteLength)
  return frame
}

const downloadChunkFrame = (input: {
  requestId: string
  transferId: string
  generation: number
  index: number
  offset: number
  declaredSize: number
  bytes: Uint8Array
  sha256?: string
}): Uint8Array =>
  fileBinaryFrame(
    {
      kind: 'DOWNLOAD_CHUNK',
      requestId: input.requestId,
      transferId: input.transferId,
      generation: input.generation,
      index: input.index,
      offset: input.offset,
      declaredSize: input.declaredSize,
      byteLength: input.bytes.byteLength,
      sha256: input.sha256 ?? STUB_DIGEST_HEX,
      final: input.offset + input.bytes.byteLength === input.declaredSize,
    },
    input.bytes,
  )

describe('SyncTransportWorkerRuntime', () => {
  let runtimeNumber = 0

  beforeEach(() => {
    jest.useFakeTimers()
    runtimeNumber = 0
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  const setup = (sharedOutbox = new FakeOutbox(), subtle?: SubtleCrypto) => {
    const messages: SyncWorkerToMainMessage[] = []
    const sockets: FakeSocket[] = []
    let uuid = 0
    const runtimeId = ++runtimeNumber
    const runtime = new SyncTransportWorkerRuntime({
      outbox: sharedOutbox,
      postMessage: (message) => messages.push(message),
      socketFactory: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      uuid: () => `runtime-${runtimeId}-id-${++uuid}`,
      random: () => 0,
      subtle:
        subtle ??
        ({
          digest: jest.fn().mockResolvedValue(Uint8Array.from({ length: 32 }, () => 0xab).buffer),
        } as unknown as SubtleCrypto),
    })
    return { runtime, messages, sockets, outbox: sharedOutbox }
  }

  const authorize = async (
    harness: ReturnType<typeof setup>,
    requestBody = body(),
    ticket = 't'.repeat(40),
    sessionScope = SESSION_A,
    operations: string[] = ['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION'],
    context?: { operationId: string; operationIndex: number },
  ) => {
    await harness.runtime.handle({
      type: 'EXECUTE',
      clientRequestId: 'client-1',
      body: requestBody,
      sessionScope,
      ...(context ? { context } : {}),
    })
    await harness.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'client-1',
      sessionScope,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket,
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    const socket = harness.sockets.at(-1) as FakeSocket
    socket.open()
    const auth = JSON.parse(socket.sent[0]) as { commandId: string }
    socket.receive(
      serverFrame('AUTHENTICATED', auth.commandId, {
        capability: 'ws-sync',
        protocolVersion: 1,
        operations,
        nextClientSequence: 1,
      }),
    )
    // Persisting the command includes an async digest and outbox write before
    // the worker may put the COMMAND frame on the socket.
    await flush()
    await flush()
    return socket
  }

  const startCollaborationHandshake = async (
    harness: ReturnType<typeof setup>,
    request: CollaborationAuthorizationTransportRequest = {
      noteUuid: 'note-1',
      collaborationProtocolVersion: 3,
      expectedRoomEpoch: ROOM_EPOCH,
      leaseRequestId: 'lease-1',
      bootstrapChallenge: 'bootstrap-challenge-1',
    },
  ) => {
    await harness.runtime.handle({
      type: 'AUTHORIZE_COLLABORATION',
      clientRequestId: 'collaboration-client-1',
      sessionScope: SESSION_A,
      request,
    })
    await harness.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'collaboration-client-1',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 'c'.repeat(40),
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    const socket = harness.sockets.at(-1) as FakeSocket
    socket.open()
    const auth = JSON.parse(socket.sent[0]) as { commandId: string }
    socket.receive(
      serverFrame('AUTHENTICATED', auth.commandId, {
        capability: 'ws-sync',
        protocolVersion: 1,
        operations: ['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION'],
        nextClientSequence: 1,
      }),
    )
    await flush()
    const discovery = JSON.parse(socket.sent[1]) as {
      requestId: string
      commandId: string
      payload: Record<string, unknown>
    }
    return { socket, discovery }
  }

  const expectDispatchedRecoveryWithoutHttpFallback = (
    harness: ReturnType<typeof setup>,
    clientRequestId: string,
    commandId: string,
    operationId: string,
  ) => {
    expect(commandId).toBe(operationId)
    expect(harness.messages).toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId })
    expect(harness.messages.filter((message) => message.type === 'HTTP_FALLBACK')).toHaveLength(0)
    expect(harness.outbox.records.get(commandId)).toEqual(
      expect.objectContaining({
        commandId,
        operationId,
        dispatchedAt: expect.any(Number),
      }),
    )
  }

  it('keeps epoch discovery internal and performs exactly one challenged grant retry on the same socket', async () => {
    const harness = setup()
    const { socket, discovery } = await startCollaborationHandshake(harness)

    expect(discovery.payload).toEqual({
      noteUuid: 'note-1',
      collaborationProtocolVersion: 3,
      epochDiscovery: true,
    })
    expect(harness.messages.some((message) => message.type === 'COLLABORATION_RESULT')).toBe(false)

    const challenge = 'challenge_abcdefghijklmnopqrstuvwxyz0123456789'
    socket.receive({
      ...serverFrame('COLLABORATION_AUTHORIZED', discovery.commandId, {
        epochDiscovery: true,
        room: 'note-1',
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 3,
        roomEpoch: ROOM_EPOCH,
        collaborationSecurityEpoch: SECURITY_EPOCH,
        epochDiscoveryChallenge: challenge,
        epochDiscoveryRequestId: discovery.requestId,
        challengeExpiresAt: Date.now() + 10_000,
      }),
      requestId: discovery.requestId,
    })
    await flush()

    const authorizationFrames = socket.sent
      .map((entry) => JSON.parse(entry))
      .filter((frame) => frame.type === 'COLLABORATION_AUTHORIZE')
    expect(authorizationFrames).toHaveLength(2)
    const grant = authorizationFrames[1] as { requestId: string; commandId: string; payload: Record<string, unknown> }
    expect(grant.commandId).not.toBe(discovery.commandId)
    expect(grant.payload).toEqual({
      noteUuid: 'note-1',
      collaborationProtocolVersion: 3,
      expectedRoomEpoch: ROOM_EPOCH,
      epochDiscoveryChallenge: challenge,
      epochDiscoveryRequestId: discovery.requestId,
      leaseRequestId: 'lease-1',
      bootstrapChallenge: 'bootstrap-challenge-1',
    })
    expect(harness.messages.some((message) => message.type === 'COLLABORATION_RESULT')).toBe(false)

    socket.receive({
      ...serverFrame('COLLABORATION_AUTHORIZED', grant.commandId, {
        capability: 'collaboration-capability',
        room: 'note-1',
        expiresIn: 300,
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 3,
        roomEpoch: ROOM_EPOCH,
        collaborationSecurityEpoch: SECURITY_EPOCH,
        leaseRequestId: 'lease-1',
        bootstrapChallenge: 'bootstrap-challenge-1',
      }),
      requestId: grant.requestId,
    })
    await flush()

    expect(harness.messages.filter((message) => message.type === 'COLLABORATION_RESULT')).toEqual([
      {
        type: 'COLLABORATION_RESULT',
        clientRequestId: 'collaboration-client-1',
        result: {
          epochDiscovery: false,
          capability: 'collaboration-capability',
          room: 'note-1',
          expiresIn: 300,
          serverUpdatedAtTimestamp: 123,
          collaborationProtocolVersion: 3,
          roomEpoch: ROOM_EPOCH,
          collaborationSecurityEpoch: SECURITY_EPOCH,
          leaseRequestId: 'lease-1',
          bootstrapChallenge: 'bootstrap-challenge-1',
        },
      },
    ])
  })

  it('rejects a stale discovery without sending a challenged grant', async () => {
    const harness = setup()
    const { socket, discovery } = await startCollaborationHandshake(harness)
    socket.receive({
      ...serverFrame('COLLABORATION_AUTHORIZED', discovery.commandId, {
        epochDiscovery: true,
        room: 'note-1',
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 3,
        roomEpoch: ROOM_EPOCH,
        collaborationSecurityEpoch: SECURITY_EPOCH,
        epochDiscoveryChallenge: 'challenge_abcdefghijklmnopqrstuvwxyz0123456789',
        epochDiscoveryRequestId: discovery.requestId,
        challengeExpiresAt: Date.now() - 1,
      }),
      requestId: discovery.requestId,
    })
    await flush()

    expect(
      socket.sent.map((entry) => JSON.parse(entry)).filter((frame) => frame.type === 'COLLABORATION_AUTHORIZE'),
    ).toHaveLength(1)
    expect(harness.messages).toContainEqual({
      type: 'COLLABORATION_FALLBACK',
      clientRequestId: 'collaboration-client-1',
      reason: 'proxy-failed',
    })
    expect(harness.messages.some((message) => message.type === 'COLLABORATION_RESULT')).toBe(false)
  })

  it('aborts an in-flight discovery when its authenticated socket generation closes', async () => {
    const harness = setup()
    const { socket } = await startCollaborationHandshake(harness)
    socket.close(1006)
    await flush()

    expect(harness.messages).toContainEqual({
      type: 'COLLABORATION_FALLBACK',
      clientRequestId: 'collaboration-client-1',
      reason: 'reconnect-gap',
    })
    expect(harness.messages.some((message) => message.type === 'NEED_TICKET' && message.reconnect === true)).toBe(false)
    expect(harness.messages.some((message) => message.type === 'COLLABORATION_RESULT')).toBe(false)
  })

  it('persists before send, clears only after checkpoint, and reuses one socket without another ticket', async () => {
    const harness = setup()
    const socket = await authorize(harness)
    const commandBytes = socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string
    const command = JSON.parse(commandBytes) as { commandId: string; digest: string; sequence: number }
    const persisted = harness.outbox.records.get(command.commandId)

    expect(persisted).toEqual(
      expect.objectContaining({
        commandId: command.commandId,
        digest: command.digest,
        sequence: command.sequence,
        bytes: commandBytes,
      }),
    )
    expect(commandBytes).not.toContain('t'.repeat(40))

    socket.receive(serverFrame('ACCEPTED', command.commandId, { status: 'ACCEPTED' }, command.digest))
    socket.receive(
      serverFrame(
        'COMMITTED',
        command.commandId,
        { status: 'COMMITTED', result: { sync_token: 'next' } },
        command.digest,
      ),
    )
    socket.receive(
      serverFrame(
        'COMMITTED',
        command.commandId,
        { status: 'COMMITTED', result: { sync_token: 'next' } },
        command.digest,
      ),
    )
    await flush()

    expect(harness.messages.filter((message) => message.type === 'RESULT')).toHaveLength(1)
    expect(harness.outbox.records.has(command.commandId)).toBe(true)

    await harness.runtime.handle({
      type: 'CHECKPOINT_DURABLE',
      requestId: 'checkpoint-1',
      sessionScope: SESSION_A,
      commandId: command.commandId,
    })
    expect(harness.outbox.records.has(command.commandId)).toBe(false)

    const ticketRequestCount = harness.messages.filter((message) => message.type === 'NEED_TICKET').length
    await harness.runtime.handle({
      type: 'EXECUTE',
      clientRequestId: 'client-2',
      body: body('second'),
      sessionScope: SESSION_A,
    })
    await flush()
    expect(harness.sockets).toHaveLength(1)
    expect(harness.messages.filter((message) => message.type === 'NEED_TICKET')).toHaveLength(ticketRequestCount)
    expect(socket.sent.filter((entry) => JSON.parse(entry).type === 'COMMAND')).toHaveLength(2)
    await harness.runtime.handle({ type: 'SHUTDOWN' })
  })

  it('maps a stable UI operation id to the durable sync command id and metadata', async () => {
    const harness = setup()
    await harness.runtime.handle({
      type: 'EXECUTE',
      clientRequestId: 'operation-client',
      body: body('folder'),
      sessionScope: SESSION_A,
      context: { operationId: '11111111-1111-4111-8111-111111111111', operationIndex: 0 },
    })
    await harness.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'operation-client',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 't'.repeat(40),
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    const socket = harness.sockets[0]
    socket.open()
    const auth = JSON.parse(socket.sent[0]) as { commandId: string }
    socket.receive(
      serverFrame('AUTHENTICATED', auth.commandId, {
        capability: 'ws-sync',
        protocolVersion: 1,
        operations: ['SYNC_ITEMS'],
        nextClientSequence: 1,
      }),
    )
    // Persisting the command includes an async digest and outbox write before
    // the worker may put the COMMAND frame on the socket.
    await flush()
    await flush()

    const command = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
      commandId: string
    }
    expect(command.commandId).toBe('11111111-1111-4111-8111-111111111111')
    expect(harness.outbox.records.get(command.commandId)?.operationId).toBe(command.commandId)
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: 'COMMAND_PERSISTED',
        command: expect.objectContaining({ id: command.commandId, operationId: command.commandId }),
      }),
    )
  })

  it('keeps a gateway that advertises no optional lane on exactly SYNC_ITEMS', async () => {
    const harness = setup()
    const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS'])

    expect(harness.messages).toContainEqual(expect.objectContaining({ type: 'NEGOTIATED', operations: ['SYNC_ITEMS'] }))
    expect(harness.messages.some((message) => message.type === 'HTTP_FALLBACK')).toBe(false)
    expect(socket.sent.some((entry) => JSON.parse(entry).type === 'COMMAND')).toBe(true)
  })

  it('negotiates against a FILES_V1 gateway without dropping sync to HTTP', async () => {
    const harness = setup()
    const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])

    // The gateway advertises FILES_V1 whenever a files adapter is ready. Recognizing
    // it must not be confused with consuming it: no lane opens here, but the
    // handshake has to survive, or sync itself would fall back to HTTP.
    expect(harness.messages).toContainEqual(
      expect.objectContaining({ type: 'NEGOTIATED', operations: ['SYNC_ITEMS', 'FILES_V1'] }),
    )
    expect(harness.messages.some((message) => message.type === 'HTTP_FALLBACK')).toBe(false)
    expect(socket.sent.some((entry) => JSON.parse(entry).type === 'COMMAND')).toBe(true)
    expect(socket.sent.some((entry) => String(JSON.parse(entry).type).startsWith('FILES_'))).toBe(false)
  })

  it('still fails the handshake when the gateway advertises an operation this build cannot bound', async () => {
    const harness = setup()
    await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V2'])

    expect(harness.messages).toContainEqual(expect.objectContaining({ type: 'HTTP_FALLBACK', reason: 'auth-failed' }))
    expect(harness.messages.some((message) => message.type === 'NEGOTIATED')).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // A gateway that binds no durable sync command port advertises every other
  // capability and omits SYNC_ITEMS. This client used to reject that handshake
  // outright and drop to HTTP for EVERYTHING -- including the collaboration,
  // RPC, invite and file lanes the socket was perfectly able to serve.
  // ---------------------------------------------------------------------------
  describe('a gateway that does not advertise SYNC_ITEMS', () => {
    const WITHOUT_SYNC_ITEMS = ['AUTHORIZE_COLLABORATION', 'API_RPC', 'INVITE_EVENTS', 'FILES_V1']

    it('completes the handshake instead of failing it', async () => {
      const harness = setup()
      await authorize(harness, body(), 't'.repeat(40), SESSION_A, WITHOUT_SYNC_ITEMS)

      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'NEGOTIATED', operations: WITHOUT_SYNC_ITEMS }),
      )
      // The old behaviour, and the precise regression this guards.
      expect(
        harness.messages.some((message) => message.type === 'HTTP_FALLBACK' && message.reason === 'auth-failed'),
      ).toBe(false)
    })

    it('routes the sync request to HTTP without disturbing the socket', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, WITHOUT_SYNC_ITEMS)

      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'HTTP_FALLBACK', reason: 'operation-unavailable' }),
      )
      // `capability-unavailable` is a PERMANENT fallback reason; reporting it
      // here would tell long-lived consumers to stand down and stop
      // reconnecting a socket that is up and serving four other lanes.
      expect(
        harness.messages.some(
          (message) => message.type === 'HTTP_FALLBACK' && message.reason === 'capability-unavailable',
        ),
      ).toBe(false)
      // Refused before a frame is written, so no command can be in flight and
      // nothing can later be replayed as a phantom commit.
      expect(socket.sent.some((entry) => JSON.parse(entry).type === 'COMMAND')).toBe(false)
      expect(harness.outbox.records.size).toBe(0)
      expect(socket.readyState).not.toBe(3)
    })

    it('keeps serving invite events over the same socket that refused sync', async () => {
      // The coexistence case: this is the user's actual target state, not a
      // corollary. Sync on HTTP, everything else realtime.
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, WITHOUT_SYNC_ITEMS)
      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'HTTP_FALLBACK', reason: 'operation-unavailable' }),
      )

      await harness.runtime.handle({
        type: 'SUBSCRIBE_INVITE_EVENTS',
        clientRequestId: 'invite-client',
        sessionScope: SESSION_A,
        cursor: 'cursor-0',
        limit: 1,
      })
      await flush()

      const subscribe = socket.sent.find((entry) => JSON.parse(entry).type === 'INVITE_SUBSCRIBE')
      expect(subscribe).toBeDefined()
      expect((JSON.parse(subscribe!) as { payload: unknown }).payload).toEqual({ cursor: 'cursor-0', limit: 1 })
      expect(socket.readyState).not.toBe(3)
    })

    it('falls back a second sync request without wedging or tearing down the lane', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, WITHOUT_SYNC_ITEMS)

      await harness.runtime.handle({
        type: 'EXECUTE',
        clientRequestId: 'client-2',
        body: body('second'),
        sessionScope: SESSION_A,
      })
      await flush()
      await flush()

      const fallbacks = harness.messages.filter(
        (message) => message.type === 'HTTP_FALLBACK' && message.reason === 'operation-unavailable',
      )
      expect(fallbacks).toHaveLength(2)
      expect(fallbacks.map((message) => (message as { clientRequestId: string }).clientRequestId)).toEqual([
        'client-1',
        'client-2',
      ])
      expect(socket.sent.some((entry) => JSON.parse(entry).type === 'COMMAND')).toBe(false)
      expect(socket.readyState).not.toBe(3)
    })

    it('still refuses an unrecognised operation when SYNC_ITEMS is absent too', async () => {
      // The allow-list must stay genuinely closed. Removing the SYNC_ITEMS
      // requirement must not become general permissiveness, and this proves the
      // rejection independently of SYNC_ITEMS being present to carry it.
      const harness = setup()
      await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['FILES_V2'])

      expect(harness.messages).toContainEqual(expect.objectContaining({ type: 'HTTP_FALLBACK', reason: 'auth-failed' }))
      expect(harness.messages.some((message) => message.type === 'NEGOTIATED')).toBe(false)
    })

    it('falls back on an empty operation list rather than negotiating a useless socket', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, [])

      expect(harness.messages).toContainEqual(expect.objectContaining({ type: 'NEGOTIATED', operations: [] }))
      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'HTTP_FALLBACK', reason: 'operation-unavailable' }),
      )
      expect(socket.sent.some((entry) => JSON.parse(entry).type === 'COMMAND')).toBe(false)
    })
  })

  describe('FILES_V1 downloads', () => {
    const openDownload = async (harness: ReturnType<typeof setup>, declaredSize = 10) =>
      harness.runtime.handle({
        type: 'OPEN_FILE_DOWNLOAD',
        clientRequestId: 'file-download-1',
        sessionScope: SESSION_A,
        request: {
          resource: { ownershipType: 'user', remoteIdentifier: REMOTE_IDENTIFIER, fileUuid: FILE_UUID },
          declaredSize,
          initialCreditBytes: 512 * 1024,
          deadlineMs: 30_000,
        },
      })

    const sentFrames = (socket: FakeSocket) =>
      socket.sent.map((entry) => JSON.parse(entry) as { type: string; requestId: string; commandId: string })

    const acceptDownload = (socket: FakeSocket, declaredSize = 10) => {
      const open = sentFrames(socket).find((frame) => frame.type === 'FILES_DOWNLOAD_OPEN')!
      socket.receive(
        serverFrame('FILES_ACCEPTED', open.commandId, {
          mode: 'download',
          transferId: 'transfer-1',
          generation: 1,
          resumeId: 'resume-1',
          declaredSize,
          nextIndex: 0,
          nextOffset: 0,
          maxChunkBytes: 256 * 1024,
        }),
      )
      return open
    }

    it('never touches the socket when the gateway does not advertise the lane', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS'])
      const framesBefore = socket.sent.length

      await openDownload(harness)

      expect(harness.messages).toContainEqual({
        type: 'FILE_DOWNLOAD_ERROR',
        clientRequestId: 'file-download-1',
        code: 'OPERATION_UNAVAILABLE',
        retryable: true,
        // Nothing was sent, so the caller may use HTTP with no risk of a replay.
        safeToFallback: true,
      })
      expect(socket.sent).toHaveLength(framesBefore)
      expect(sentFrames(socket).some((frame) => frame.type.startsWith('FILES_'))).toBe(false)
    })

    it('reports the lane as unavailable when there is no socket at all, without requesting a ticket', async () => {
      const harness = setup()

      await openDownload(harness)

      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'FILE_DOWNLOAD_ERROR', code: 'OPERATION_UNAVAILABLE', safeToFallback: true }),
      )
      // No bootstrap: a deployment without the lane pays nothing for its existence.
      expect(harness.messages.some((message) => message.type === 'NEED_TICKET')).toBe(false)
      expect(harness.sockets).toHaveLength(0)
    })

    it('carries remoteIdentifier verbatim and streams a transfer to completion', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])

      await openDownload(harness)

      const open = JSON.parse(
        socket.sent.find((entry) => JSON.parse(entry).type === 'FILES_DOWNLOAD_OPEN') as string,
      ) as { requestId: string; commandId: string; payload: Record<string, unknown> }
      expect(open.payload).toEqual({
        resource: { ownershipType: 'user', remoteIdentifier: REMOTE_IDENTIFIER, fileUuid: FILE_UUID },
        offset: 0,
        initialCreditBytes: 512 * 1024,
        deadlineMs: 30_000,
      })
      expect((open.payload.resource as { remoteIdentifier: string }).remoteIdentifier).toBe(REMOTE_IDENTIFIER)

      acceptDownload(socket)
      await flush()
      expect(harness.messages).toContainEqual({
        type: 'FILE_DOWNLOAD_ACCEPTED',
        clientRequestId: 'file-download-1',
        declaredSize: 10,
      })

      socket.receiveBinary(
        downloadChunkFrame({
          requestId: open.requestId,
          transferId: 'transfer-1',
          generation: 1,
          index: 0,
          offset: 0,
          declaredSize: 10,
          bytes: Uint8Array.from([1, 2, 3, 4, 5, 6]),
        }),
      )
      await flush()
      socket.receiveBinary(
        downloadChunkFrame({
          requestId: open.requestId,
          transferId: 'transfer-1',
          generation: 1,
          index: 1,
          offset: 6,
          declaredSize: 10,
          bytes: Uint8Array.from([7, 8, 9, 10]),
        }),
      )
      await flush()

      const chunks = harness.messages.filter((message) => message.type === 'FILE_DOWNLOAD_CHUNK') as Extract<
        SyncWorkerToMainMessage,
        { type: 'FILE_DOWNLOAD_CHUNK' }
      >[]
      expect(chunks.map((chunk) => [...chunk.bytes])).toEqual([
        [1, 2, 3, 4, 5, 6],
        [7, 8, 9, 10],
      ])

      socket.receive(
        serverFrame('FILES_COMPLETE', open.commandId, {
          mode: 'download',
          transferId: 'transfer-1',
          generation: 1,
          sha256: STUB_DIGEST_HEX,
          rangeStart: 0,
          declaredSize: 10,
        }),
      )
      await flush()
      expect(harness.messages).toContainEqual({
        type: 'FILE_DOWNLOAD_COMPLETE',
        clientRequestId: 'file-download-1',
        sha256: STUB_DIGEST_HEX,
        declaredSize: 10,
      })
    })

    it('forwards a shared-vault reference whole instead of rebuilding it as personal', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])

      await harness.runtime.handle({
        type: 'OPEN_FILE_DOWNLOAD',
        clientRequestId: 'file-download-1',
        sessionScope: SESSION_A,
        request: {
          resource: {
            ownershipType: 'shared-vault',
            remoteIdentifier: REMOTE_IDENTIFIER,
            fileUuid: FILE_UUID,
            sharedVaultUuid: '22222222-2222-4222-8222-222222222222',
            sharedVaultOwnerUuid: '33333333-3333-4333-8333-333333333333',
          },
          declaredSize: 10,
          initialCreditBytes: 512 * 1024,
          deadlineMs: 30_000,
        },
      })

      const open = JSON.parse(
        socket.sent.find((entry) => JSON.parse(entry).type === 'FILES_DOWNLOAD_OPEN') as string,
      ) as { payload: Record<string, unknown> }
      expect(open.payload.resource).toEqual({
        ownershipType: 'shared-vault',
        remoteIdentifier: REMOTE_IDENTIFIER,
        fileUuid: FILE_UUID,
        sharedVaultUuid: '22222222-2222-4222-8222-222222222222',
        sharedVaultOwnerUuid: '33333333-3333-4333-8333-333333333333',
      })
    })

    it('refuses a shared-vault reference that is missing its vault fields', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
      const framesBefore = socket.sent.length

      await harness.runtime.handle({
        type: 'OPEN_FILE_DOWNLOAD',
        clientRequestId: 'file-download-1',
        sessionScope: SESSION_A,
        request: {
          // Structurally invalid: the gateway would refuse it, and sending it
          // would burn a sequence number to learn what is checkable here.
          resource: { ownershipType: 'shared-vault', remoteIdentifier: REMOTE_IDENTIFIER, fileUuid: FILE_UUID },
          declaredSize: 10,
          initialCreditBytes: 512 * 1024,
          deadlineMs: 30_000,
        } as never,
      })

      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'FILE_DOWNLOAD_ERROR', code: 'INVALID_REQUEST', safeToFallback: true }),
      )
      expect(socket.sent).toHaveLength(framesBefore)
    })

    describe('uploads', () => {
      const uploadRequest = (overrides: Record<string, unknown> = {}) => ({
        resource: { ownershipType: 'user' as const, remoteIdentifier: REMOTE_IDENTIFIER, fileUuid: FILE_UUID },
        decryptedSize: 8,
        declaredSize: 10,
        mimeType: 'application/octet-stream',
        deadlineMs: 30_000,
        ...overrides,
      })

      const openUpload = async (harness: ReturnType<typeof setup>, overrides: Record<string, unknown> = {}) =>
        harness.runtime.handle({
          type: 'OPEN_FILE_UPLOAD',
          clientRequestId: 'file-upload-1',
          sessionScope: SESSION_A,
          request: uploadRequest(overrides) as never,
        })

      const acceptUpload = (socket: FakeSocket) => {
        const open = socket.sent
          .map((entry) => JSON.parse(entry) as { type: string; requestId: string; commandId: string })
          .find((frame) => frame.type === 'FILES_UPLOAD_OPEN')!
        socket.receive(
          serverFrame('FILES_ACCEPTED', open.commandId, {
            mode: 'upload',
            transferId: 'transfer-1',
            generation: 1,
            resumeId: 'resume-1',
            nextIndex: 0,
            nextOffset: 0,
            declaredSize: 10,
            maxChunkBytes: 256 * 1024,
          }),
        )
        return open
      }

      it('never touches the socket when the gateway does not advertise the lane', async () => {
        const harness = setup()
        const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS'])
        const framesBefore = socket.sent.length

        await openUpload(harness)

        expect(harness.messages).toContainEqual({
          type: 'FILE_UPLOAD_ERROR',
          clientRequestId: 'file-upload-1',
          code: 'OPERATION_UNAVAILABLE',
          retryable: true,
          safeToFallback: true,
        })
        expect(socket.sent).toHaveLength(framesBefore)
        expect(socket.sentBinary).toHaveLength(0)
      })

      it('reports the lane unavailable with no socket at all, without requesting a ticket', async () => {
        const harness = setup()

        await openUpload(harness)

        expect(harness.messages).toContainEqual(
          expect.objectContaining({ type: 'FILE_UPLOAD_ERROR', code: 'OPERATION_UNAVAILABLE', safeToFallback: true }),
        )
        expect(harness.messages.some((message) => message.type === 'NEED_TICKET')).toBe(false)
        expect(harness.sockets).toHaveLength(0)
      })

      it('carries remoteIdentifier verbatim and moves a chunk as a binary frame', async () => {
        const harness = setup()
        const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
        await openUpload(harness)

        const open = JSON.parse(
          socket.sent.find((entry) => JSON.parse(entry).type === 'FILES_UPLOAD_OPEN') as string,
        ) as { requestId: string; payload: Record<string, unknown> }
        expect(open.payload.resource).toEqual({
          ownershipType: 'user',
          remoteIdentifier: REMOTE_IDENTIFIER,
          fileUuid: FILE_UUID,
        })

        acceptUpload(socket)
        await flush()
        expect(harness.messages).toContainEqual(
          expect.objectContaining({ type: 'FILE_UPLOAD_ACCEPTED', transferId: 'transfer-1', generation: 1 }),
        )

        await harness.runtime.handle({
          type: 'SEND_FILE_CHUNK',
          clientRequestId: 'file-upload-1',
          index: 0,
          offset: 0,
          bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        })
        await flush()

        expect(socket.sentBinary).toHaveLength(1)
        // Decoding with this client's own decoder proves the frame is well formed
        // against the same rules the gateway applies.
        const decoded = decodeFileBinaryFrame(socket.sentBinary[0])
        expect(decoded.header).toMatchObject({
          kind: 'UPLOAD_CHUNK',
          requestId: open.requestId,
          transferId: 'transfer-1',
          generation: 1,
          index: 0,
          offset: 0,
          declaredSize: 10,
          byteLength: 10,
          final: true,
        })
        expect([...decoded.bytes]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      })

      it('forwards a shared-vault upload reference whole rather than rebuilding it', async () => {
        const harness = setup()
        const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])

        await openUpload(harness, {
          resource: {
            ownershipType: 'shared-vault',
            remoteIdentifier: REMOTE_IDENTIFIER,
            fileUuid: FILE_UUID,
            sharedVaultUuid: '22222222-2222-4222-8222-222222222222',
            sharedVaultOwnerUuid: '33333333-3333-4333-8333-333333333333',
          },
        })

        const open = JSON.parse(
          socket.sent.find((entry) => JSON.parse(entry).type === 'FILES_UPLOAD_OPEN') as string,
        ) as { payload: Record<string, unknown> }
        expect(open.payload.resource).toEqual({
          ownershipType: 'shared-vault',
          remoteIdentifier: REMOTE_IDENTIFIER,
          fileUuid: FILE_UUID,
          sharedVaultUuid: '22222222-2222-4222-8222-222222222222',
          sharedVaultOwnerUuid: '33333333-3333-4333-8333-333333333333',
        })
      })

      it('relays a chunk acknowledgement addressed by transferId rather than the open commandId', async () => {
        const harness = setup()
        const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
        await openUpload(harness)
        const open = acceptUpload(socket)
        await flush()

        // The gateway sets commandId to the transferId when acknowledging a
        // binary chunk, so routing must match on either.
        socket.receive(
          serverFrame('FILES_CHUNK_ACK', 'transfer-1', {
            transferId: 'transfer-1',
            generation: 1,
            index: 0,
            duplicate: false,
            nextIndex: 1,
            nextOffset: 10,
            resumeId: 'resume-2',
          }),
        )
        await flush()

        expect(open.commandId).not.toBe('transfer-1')
        expect(harness.messages).toContainEqual({
          type: 'FILE_UPLOAD_CHUNK_ACK',
          clientRequestId: 'file-upload-1',
          transferId: 'transfer-1',
          generation: 1,
          index: 0,
          duplicate: false,
          nextIndex: 1,
          nextOffset: 10,
          resumeId: 'resume-2',
        })
      })

      it('treats everything after a FINISH attempt as unsafe to replay', async () => {
        const harness = setup()
        const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
        await openUpload(harness)
        acceptUpload(socket)
        await flush()

        await harness.runtime.handle({
          type: 'FINISH_FILE_UPLOAD',
          clientRequestId: 'file-upload-1',
          transferId: 'transfer-1',
          generation: 1,
          declaredSize: 10,
          sha256: 'ab'.repeat(32),
        })
        socket.close(1006)
        await flush()

        expect(harness.messages).toContainEqual({
          type: 'FILE_UPLOAD_ERROR',
          clientRequestId: 'file-upload-1',
          code: 'SOCKET_CLOSED',
          retryable: true,
          safeToFallback: false,
        })
      })

      it('is safe to replay when the socket dies before FINISH', async () => {
        const harness = setup()
        const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
        await openUpload(harness)
        acceptUpload(socket)
        await flush()
        socket.close(1006)
        await flush()

        expect(harness.messages).toContainEqual(
          expect.objectContaining({ type: 'FILE_UPLOAD_ERROR', code: 'SOCKET_CLOSED', safeToFallback: true }),
        )
      })

      it('refuses to emit a chunk the gateway would reject rather than spending a round trip', async () => {
        const harness = setup()
        const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
        await openUpload(harness)
        acceptUpload(socket)
        await flush()

        // Offset beyond the declared size can never be a valid frame.
        await harness.runtime.handle({
          type: 'SEND_FILE_CHUNK',
          clientRequestId: 'file-upload-1',
          index: 0,
          offset: 9,
          bytes: Uint8Array.from([1, 2, 3, 4]),
        })
        await flush()

        expect(socket.sentBinary).toHaveLength(0)
        expect(harness.messages).toContainEqual(
          expect.objectContaining({ type: 'FILE_UPLOAD_ERROR', code: 'FILE_FRAME_MALFORMED' }),
        )
      })

      it('completes when the gateway confirms the upload', async () => {
        const harness = setup()
        const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
        await openUpload(harness)
        const open = acceptUpload(socket)
        await flush()

        socket.receive(
          serverFrame('FILES_COMPLETE', open.commandId, {
            mode: 'upload',
            transferId: 'transfer-1',
            generation: 1,
            sha256: 'ab'.repeat(32),
          }),
        )
        await flush()

        expect(harness.messages).toContainEqual({
          type: 'FILE_UPLOAD_COMPLETE',
          clientRequestId: 'file-upload-1',
          sha256: 'ab'.repeat(32),
        })
      })
    })

    it('returns consumed credit only when the main thread asks for it', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
      await openDownload(harness)
      acceptDownload(socket)
      await flush()

      expect(sentFrames(socket).some((frame) => frame.type === 'FILES_CREDIT')).toBe(false)

      await harness.runtime.handle({
        type: 'FILE_DOWNLOAD_CREDIT',
        clientRequestId: 'file-download-1',
        creditBytes: 6,
      })
      const credit = JSON.parse(
        socket.sent.find((entry) => JSON.parse(entry).type === 'FILES_CREDIT') as string,
      ) as { payload: Record<string, unknown> }
      expect(credit.payload).toEqual({ transferId: 'transfer-1', generation: 1, creditBytes: 6 })
    })

    it('rejects a chunk whose payload does not match its declared digest', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
      await openDownload(harness)
      const open = acceptDownload(socket)
      await flush()

      socket.receiveBinary(
        downloadChunkFrame({
          requestId: open.requestId,
          transferId: 'transfer-1',
          generation: 1,
          index: 0,
          offset: 0,
          declaredSize: 10,
          bytes: Uint8Array.from([1, 2, 3, 4, 5, 6]),
          sha256: 'cd'.repeat(32),
        }),
      )
      await flush()

      expect(harness.messages.some((message) => message.type === 'FILE_DOWNLOAD_CHUNK')).toBe(false)
      expect(harness.messages).toContainEqual({
        type: 'FILE_DOWNLOAD_ERROR',
        clientRequestId: 'file-download-1',
        code: 'FILE_INTEGRITY_MISMATCH',
        retryable: false,
        safeToFallback: true,
      })
    })

    it('refuses an accepted size that disagrees with the client’s authenticated metadata', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
      await openDownload(harness, 10)

      acceptDownload(socket, 11)
      await flush()

      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'FILE_DOWNLOAD_ERROR', code: 'FILE_INVALID_STATE' }),
      )
    })

    it('drops a chunk that arrives out of order rather than applying it', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
      await openDownload(harness)
      const open = acceptDownload(socket)
      await flush()

      socket.receiveBinary(
        downloadChunkFrame({
          requestId: open.requestId,
          transferId: 'transfer-1',
          generation: 1,
          index: 1,
          offset: 6,
          declaredSize: 10,
          bytes: Uint8Array.from([7, 8, 9, 10]),
        }),
      )
      await flush()

      expect(harness.messages.some((message) => message.type === 'FILE_DOWNLOAD_CHUNK')).toBe(false)
      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'FILE_DOWNLOAD_ERROR', code: 'FILE_CHUNK_OUT_OF_ORDER' }),
      )
    })

    it('marks a mid-transfer socket loss as unsafe to replay once a chunk has crossed', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
      await openDownload(harness)
      const open = acceptDownload(socket)
      await flush()

      socket.receiveBinary(
        downloadChunkFrame({
          requestId: open.requestId,
          transferId: 'transfer-1',
          generation: 1,
          index: 0,
          offset: 0,
          declaredSize: 10,
          bytes: Uint8Array.from([1, 2, 3, 4, 5, 6]),
        }),
      )
      await flush()
      socket.close(1006)
      await flush()

      expect(harness.messages).toContainEqual({
        type: 'FILE_DOWNLOAD_ERROR',
        clientRequestId: 'file-download-1',
        code: 'SOCKET_CLOSED',
        retryable: true,
        safeToFallback: false,
      })
    })

    it('reports a completion that arrives before every declared byte as truncated', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
      await openDownload(harness)
      const open = acceptDownload(socket)
      await flush()

      socket.receive(
        serverFrame('FILES_COMPLETE', open.commandId, {
          mode: 'download',
          transferId: 'transfer-1',
          generation: 1,
          sha256: STUB_DIGEST_HEX,
          rangeStart: 0,
          declaredSize: 10,
        }),
      )
      await flush()

      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'FILE_DOWNLOAD_ERROR', code: 'FILE_TRUNCATED', safeToFallback: true }),
      )
      expect(harness.messages.some((message) => message.type === 'FILE_DOWNLOAD_COMPLETE')).toBe(false)
    })

    it('cancels an open transfer on the socket before terminating it locally', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
      await openDownload(harness)
      acceptDownload(socket)
      await flush()

      await harness.runtime.handle({ type: 'CANCEL_FILE_DOWNLOAD', clientRequestId: 'file-download-1' })

      const cancel = JSON.parse(
        socket.sent.find((entry) => JSON.parse(entry).type === 'FILES_CANCEL') as string,
      ) as { payload: Record<string, unknown> }
      expect(cancel.payload).toEqual({ transferId: 'transfer-1', generation: 1 })
      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'FILE_DOWNLOAD_ERROR', code: 'CANCELLED' }),
      )
    })

    it('ignores a binary frame that belongs to no active transfer without harming the socket', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
      await openDownload(harness)
      acceptDownload(socket)
      await flush()

      socket.receiveBinary(
        downloadChunkFrame({
          requestId: 'someone-elses-request',
          transferId: 'transfer-9',
          generation: 1,
          index: 0,
          offset: 0,
          declaredSize: 10,
          bytes: Uint8Array.from([1, 2, 3, 4, 5, 6]),
        }),
      )
      socket.receiveBinary(Uint8Array.from([0, 1, 2, 3]))
      await flush()

      expect(harness.messages.some((message) => message.type === 'FILE_DOWNLOAD_CHUNK')).toBe(false)
      expect(harness.messages.some((message) => message.type === 'FILE_DOWNLOAD_ERROR')).toBe(false)
      expect(socket.readyState).toBe(1)
    })
  })

  it('multiplexes credit-controlled RPC and never auto-replays after request bytes are sent', async () => {
    const harness = setup()
    const request = {
      method: 'GET' as const,
      path: '/v1/workflows/status',
      headers: { accept: 'application/json' },
      deadlineMs: 30_000,
      initialCreditBytes: 8,
      stream: true,
    }
    await harness.runtime.handle({
      type: 'OPEN_RPC',
      clientRequestId: 'rpc-client',
      sessionScope: SESSION_A,
      request,
    })
    expect(harness.messages.at(-1)).toEqual({ type: 'NEED_TICKET', clientRequestId: 'rpc-client', reconnect: false })
    await harness.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'rpc-client',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 't'.repeat(40),
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    const socket = harness.sockets[0]
    socket.open()
    const auth = JSON.parse(socket.sent[0]) as { commandId: string }
    socket.receive(
      serverFrame('AUTHENTICATED', auth.commandId, {
        capability: 'ws-sync',
        protocolVersion: 1,
        operations: ['SYNC_ITEMS', 'API_RPC'],
        nextClientSequence: 1,
      }),
    )
    await flush()
    const rpc = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'RPC_REQUEST') as string) as {
      requestId: string
      commandId: string
      payload: Record<string, unknown>
    }
    expect(rpc.payload).toMatchObject(request)

    socket.receive(serverFrame('RPC_ACCEPTED', rpc.commandId, { accepted: true }))
    socket.receive(
      serverFrame('RPC_RESPONSE', rpc.commandId, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        stream: true,
      }),
    )
    socket.receive(
      serverFrame('RPC_CHUNK', rpc.commandId, {
        index: 0,
        bytes: Buffer.from('12345678').toString('base64'),
        byteLength: 8,
      }),
    )
    await harness.runtime.handle({ type: 'RPC_CREDIT', clientRequestId: 'rpc-client', creditBytes: 8 })
    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toContain('RPC_CREDIT')
    socket.close(1006)
    await flush()

    expect(harness.messages).toContainEqual({ type: 'RPC_ACCEPTED', clientRequestId: 'rpc-client' })
    expect(harness.messages).toContainEqual(
      expect.objectContaining({
        type: 'RPC_ERROR',
        clientRequestId: 'rpc-client',
        code: 'SOCKET_CLOSED',
        safeToFallback: false,
      }),
    )
    jest.advanceTimersByTime(10_000)
    expect(harness.sockets).toHaveLength(1)
  })

  it('keeps the normalized body and stable operation identity while reconciling an accepted reconnect', async () => {
    const requestBody = {
      api: '20240226',
      items: [
        {
          uuid: 'note-1',
          content: 'ciphertext',
          content_type: 'Note',
          deleted: false,
          created_at: new Date('2026-08-18T12:34:56.789Z'),
          updated_at_timestamp: 1_787_056_496_789,
          auth_hash: undefined,
        },
      ],
      sync_token: 'token',
      cursor_token: undefined,
      limit: 150,
      shared_vault_uuids: ['vault-1'],
    } as unknown as AccountSyncTransportRequest
    const expectedWireBody = {
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
    } as unknown as AccountSyncTransportRequest
    const expectedDigest = 'ad38335b0a6e0a2ca113211f95ae13922faad67d066ba7b3ede390125f470f61'
    const digestBytes = Uint8Array.from(expectedDigest.match(/.{2}/g) as string[], (byte) => Number.parseInt(byte, 16))
    const harness = setup(new FakeOutbox(), {
      digest: jest.fn().mockResolvedValue(digestBytes.buffer),
    } as unknown as SubtleCrypto)
    const operationId = '11111111-1111-4111-8111-111111111141'
    const firstSocket = await authorize(harness, requestBody, 't'.repeat(40), SESSION_A, undefined, {
      operationId,
      operationIndex: 0,
    })
    const commandBytes = firstSocket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string
    const command = JSON.parse(commandBytes) as {
      commandId: string
      digest: string
      sequence: number
      payload: { command: string; body: AccountSyncTransportRequest }
    }
    expect(command.payload).toEqual({ command: 'SYNC_ITEMS', body: expectedWireBody })
    expect(command.digest).toBe(expectedDigest)
    firstSocket.receive(serverFrame('ACCEPTED', command.commandId, { status: 'ACCEPTED' }, command.digest))
    firstSocket.close(1006)
    jest.runOnlyPendingTimers()
    await flush()

    expect(harness.messages).toContainEqual({ type: 'NEED_TICKET', clientRequestId: 'client-1', reconnect: true })
    await harness.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'client-1',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 'r'.repeat(40),
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    const secondSocket = harness.sockets[1]
    secondSocket.open()
    const auth = JSON.parse(secondSocket.sent[0]) as { commandId: string }
    secondSocket.receive(
      serverFrame('AUTHENTICATED', auth.commandId, {
        capability: 'ws-sync',
        protocolVersion: 1,
        operations: ['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION'],
        nextClientSequence: 2,
      }),
    )
    await flush()
    const status = JSON.parse(secondSocket.sent.find((entry) => JSON.parse(entry).type === 'STATUS') as string)
    expect(status).toEqual(expect.objectContaining({ commandId: command.commandId, digest: command.digest }))

    secondSocket.receive(serverFrame('STATUS', command.commandId, { status: 'ACCEPTED' }, command.digest))
    await flush()
    await harness.runtime.handle({
      type: 'TICKET_UNAVAILABLE',
      clientRequestId: 'client-1',
      reason: 'capability-unavailable',
    })
    expectDispatchedRecoveryWithoutHttpFallback(harness, 'client-1', command.commandId, operationId)
  })

  it('applies persisted A through RECOVER before allowing fresh B to be sent', async () => {
    const shared = new FakeOutbox()
    const first = setup(shared)
    const firstSocket = await authorize(first)
    const persistedCommand = JSON.parse(
      firstSocket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string,
    ) as { commandId: string; digest: string }
    await first.runtime.handle({ type: 'SHUTDOWN' })

    const second = setup(shared)
    await second.runtime.handle({ type: 'RECOVER', clientRequestId: 'recover-a', sessionScope: SESSION_A })
    expect(second.messages).toContainEqual(
      expect.objectContaining({
        type: 'COMMAND_PERSISTED',
        clientRequestId: 'recover-a',
        body: body(),
      }),
    )
    await second.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'recover-a',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 'n'.repeat(40),
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    const secondSocket = second.sockets[0]
    secondSocket.open()
    const auth = JSON.parse(secondSocket.sent[0]) as { commandId: string }
    secondSocket.receive(
      serverFrame('AUTHENTICATED', auth.commandId, {
        capability: 'ws-sync',
        protocolVersion: 1,
        operations: ['SYNC_ITEMS', 'AUTHORIZE_COLLABORATION'],
        nextClientSequence: 2,
      }),
    )
    await flush()
    const sentTypes = secondSocket.sent.map((entry) => JSON.parse(entry).type)
    expect(sentTypes).toEqual(['AUTH', 'STATUS'])
    secondSocket.receive(
      serverFrame(
        'STATUS',
        persistedCommand.commandId,
        { status: 'COMMITTED', result: { sync_token: 'recovered-token' } },
        persistedCommand.digest,
      ),
    )
    await flush()
    expect(second.messages).toContainEqual(
      expect.objectContaining({ type: 'RESULT', commandId: persistedCommand.commandId }),
    )

    await second.runtime.handle({
      type: 'CHECKPOINT_DURABLE',
      requestId: 'checkpoint-a',
      sessionScope: SESSION_A,
      commandId: persistedCommand.commandId,
    })
    await second.runtime.handle({
      type: 'EXECUTE',
      clientRequestId: 'execute-b',
      sessionScope: SESSION_A,
      body: body('new'),
    })
    await flush()
    const commandFrames = secondSocket.sent
      .map((entry) => JSON.parse(entry) as { type: string; payload?: { body?: AccountSyncTransportRequest } })
      .filter((frame) => frame.type === 'COMMAND')
    expect(commandFrames).toHaveLength(1)
    expect(commandFrames[0].payload?.body).toEqual(body('new'))
  })

  it('recovers command identity before capability fallback so reload cannot replay id-less HTTP', async () => {
    const shared = new FakeOutbox()
    const first = setup(shared)
    const operationId = '11111111-1111-4111-8111-111111111151'
    const firstSocket = await authorize(first, body(), 't'.repeat(40), SESSION_A, undefined, {
      operationId,
      operationIndex: 0,
    })
    const persistedCommand = JSON.parse(
      firstSocket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string,
    ) as { commandId: string; digest: string; sequence: number }
    await first.runtime.handle({ type: 'SHUTDOWN' })

    const recovered = setup(shared)
    await recovered.runtime.handle({
      type: 'RECOVER',
      clientRequestId: 'client-1',
      sessionScope: SESSION_A,
    })
    expect(recovered.sockets).toHaveLength(0)
    expect(recovered.messages).toContainEqual({
      type: 'COMMAND_PERSISTED',
      clientRequestId: 'client-1',
      body: body(),
      command: {
        id: persistedCommand.commandId,
        digest: persistedCommand.digest,
        sequence: persistedCommand.sequence,
        operationId,
      },
    })

    await recovered.runtime.handle({
      type: 'TICKET_UNAVAILABLE',
      clientRequestId: 'client-1',
      reason: 'capability-unavailable',
    })
    expectDispatchedRecoveryWithoutHttpFallback(recovered, 'client-1', persistedCommand.commandId, operationId)
  })

  it('isolates recovery by authenticated session scope and ignores legacy unscoped records', async () => {
    const shared = new FakeOutbox()
    const first = setup(shared)
    await authorize(first)
    await first.runtime.handle({ type: 'SHUTDOWN' })

    const otherAccount = setup(shared)
    await otherAccount.runtime.handle({ type: 'RECOVER', clientRequestId: 'recover-b', sessionScope: SESSION_B })
    expect(otherAccount.messages).toContainEqual({ type: 'RECOVERY_EMPTY', clientRequestId: 'recover-b' })
    expect(otherAccount.messages).not.toContainEqual(expect.objectContaining({ type: 'COMMAND_PERSISTED' }))

    shared.records.set('legacy-command', {
      commandId: 'legacy-command',
      digest: 'c'.repeat(64),
      sequence: 1,
      bytes: '{}',
      createdAt: 1,
    } as unknown as SyncOutboxRecord)
    const legacyProbe = setup(shared)
    await legacyProbe.runtime.handle({ type: 'RECOVER', clientRequestId: 'legacy-probe', sessionScope: SESSION_B })
    expect(legacyProbe.messages).toContainEqual({ type: 'RECOVERY_EMPTY', clientRequestId: 'legacy-probe' })
  })

  it('requires durable recovery for a committed result that is too large for WS', async () => {
    const harness = setup()
    const operationId = '11111111-1111-4111-8111-111111111161'
    const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, undefined, {
      operationId,
      operationIndex: 0,
    })
    const command = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
      commandId: string
      digest: string
      sequence: number
    }

    socket.receive(
      serverFrame('ERROR', command.commandId, { code: 'RESULT_TOO_LARGE', retryable: true }, command.digest),
    )
    await flush()

    expectDispatchedRecoveryWithoutHttpFallback(harness, 'client-1', command.commandId, operationId)
  })

  it('rejects an oversized inbound result without delivering it and preserves replay identity', async () => {
    const harness = setup()
    const operationId = '11111111-1111-4111-8111-111111111171'
    const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, undefined, {
      operationId,
      operationIndex: 0,
    })
    const command = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
      commandId: string
      digest: string
      sequence: number
    }
    const oversizedFrame = {
      ...serverFrame(
        'COMMITTED',
        command.commandId,
        { status: 'COMMITTED', result: { ciphertext: 'x'.repeat(600_000) } },
        command.digest,
      ),
    }

    socket.receive(JSON.stringify(oversizedFrame))
    await flush()

    expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'RESULT' }))
    expectDispatchedRecoveryWithoutHttpFallback(harness, 'client-1', command.commandId, operationId)
  })

  it('falls back exactly once when a ticket expires before any command bytes can be sent', async () => {
    const harness = setup()
    await harness.runtime.handle({
      type: 'EXECUTE',
      clientRequestId: 'pre-send-client',
      body: body('pre-send'),
      sessionScope: SESSION_A,
      context: { operationId: '11111111-1111-4111-8111-111111111181', operationIndex: 0 },
    })
    await harness.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'pre-send-client',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 'e'.repeat(40),
        expiresAt: Date.now(),
        deviceId: 'device-1',
      },
    })

    expect(harness.messages.filter((message) => message.type === 'HTTP_FALLBACK')).toEqual([
      expect.objectContaining({
        type: 'HTTP_FALLBACK',
        clientRequestId: 'pre-send-client',
        reason: 'ticket-expired',
      }),
    ])
    expect(harness.outbox.records.size).toBe(0)
    expect(harness.sockets).toHaveLength(0)
  })

  it('falls back for an expired ticket, oversized frame, unavailable outbox, and non-owner tab', async () => {
    const expired = setup()
    await expired.runtime.handle({
      type: 'EXECUTE',
      clientRequestId: 'client-1',
      body: body(),
      sessionScope: SESSION_A,
    })
    await expired.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'client-1',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 'e'.repeat(40),
        expiresAt: Date.now(),
        deviceId: 'device-1',
      },
    })
    expect(expired.messages).toContainEqual(
      expect.objectContaining({ type: 'HTTP_FALLBACK', reason: 'ticket-expired' }),
    )

    const oversized = setup()
    await authorize(oversized, { api: '20240226', items: [{ content: 'x'.repeat(600_000) }], limit: 150 })
    expect(oversized.messages).toContainEqual(
      expect.objectContaining({ type: 'HTTP_FALLBACK', reason: 'frame-too-large' }),
    )

    const unavailable = setup()
    unavailable.outbox.failWrites = true
    await authorize(unavailable)
    expect(unavailable.messages).toContainEqual(
      expect.objectContaining({ type: 'HTTP_FALLBACK', reason: 'outbox-unavailable' }),
    )

    const shared = new FakeOutbox()
    const owner = setup(shared)
    await owner.runtime.handle({
      type: 'EXECUTE',
      clientRequestId: 'client-1',
      body: body(),
      sessionScope: SESSION_A,
    })
    await owner.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'client-1',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 'o'.repeat(40),
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    const peer = setup(shared)
    await peer.runtime.handle({
      type: 'EXECUTE',
      clientRequestId: 'client-1',
      body: body('peer'),
      sessionScope: SESSION_A,
    })
    await peer.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'client-1',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 'p'.repeat(40),
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    expect(peer.messages).toContainEqual(
      expect.objectContaining({ type: 'HTTP_FALLBACK', reason: 'multi-tab-not-owner' }),
    )

    const otherSessionPeer = setup(shared)
    await otherSessionPeer.runtime.handle({
      type: 'EXECUTE',
      clientRequestId: 'client-1',
      body: body('other-session-peer'),
      sessionScope: SESSION_B,
    })
    await otherSessionPeer.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'client-1',
      sessionScope: SESSION_B,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 'q'.repeat(40),
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    expect(otherSessionPeer.sockets).toHaveLength(1)
    expect(otherSessionPeer.messages).not.toContainEqual(
      expect.objectContaining({ type: 'HTTP_FALLBACK', reason: 'multi-tab-not-owner' }),
    )
  })

  it('fails closed on malformed frames and never logs ticket or encrypted body data', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation()
    const consoleLog = jest.spyOn(console, 'log').mockImplementation()
    const harness = setup()
    const operationId = '11111111-1111-4111-8111-111111111191'
    const socket = await authorize(harness, body('secret'), 'super-secret-ticket'.repeat(3), SESSION_A, undefined, {
      operationId,
      operationIndex: 0,
    })
    socket.receive('{malformed')
    await flush()

    const command = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
      commandId: string
    }
    expectDispatchedRecoveryWithoutHttpFallback(harness, 'client-1', command.commandId, operationId)
    expect(consoleError).not.toHaveBeenCalled()
    expect(consoleLog).not.toHaveBeenCalled()
    consoleError.mockRestore()
    consoleLog.mockRestore()
  })

  it('closes on session revocation and retains but quarantines an uncheckpointed command', async () => {
    const harness = setup()
    const socket = await authorize(harness)
    const command = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
      commandId: string
    }

    await harness.runtime.handle({ type: 'SESSION_REVOKED', requestId: 'revoke-1', sessionScope: SESSION_A })

    expect(socket.readyState).toBe(3)
    expect(harness.outbox.records.has(command.commandId)).toBe(true)
    expect(harness.outbox.records.get(command.commandId)?.revoked).toBe(true)
    expect(harness.messages).toContainEqual({
      type: 'SESSION_REVOKED_ACK',
      requestId: 'revoke-1',
      sessionScope: SESSION_A,
    })

    const nextSession = setup(harness.outbox)
    const nextSocket = await authorize(nextSession, body('next-session'), 'n'.repeat(40), SESSION_B)
    expect(nextSocket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['AUTH', 'COMMAND'])
  })

  it('holds durable invite delivery across reconnect until the main thread acknowledges the applied cursor', async () => {
    const harness = setup()
    await harness.runtime.handle({
      type: 'SUBSCRIBE_INVITE_EVENTS',
      clientRequestId: 'invite-client',
      sessionScope: SESSION_A,
      cursor: 'cursor-0',
      limit: 1,
    })
    expect(harness.messages).toContainEqual({
      type: 'NEED_TICKET',
      clientRequestId: 'invite-client',
      reconnect: false,
    })
    await harness.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'invite-client',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 'i'.repeat(40),
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    const socket = harness.sockets[0]
    socket.open()
    const auth = JSON.parse(socket.sent[0]) as { commandId: string }
    socket.receive(
      serverFrame('AUTHENTICATED', auth.commandId, {
        capability: 'ws-sync',
        protocolVersion: 1,
        operations: ['SYNC_ITEMS', 'INVITE_EVENTS'],
        nextClientSequence: 1,
      }),
    )
    await flush()
    const subscription = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'INVITE_SUBSCRIBE')!) as {
      commandId: string
      payload: { cursor: string; limit: number }
    }
    expect(subscription.payload).toEqual({ cursor: 'cursor-0', limit: 1 })
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
    socket.receive(serverFrame('INVITE_BATCH', subscription.commandId, batch))
    await flush()
    expect(harness.messages).toContainEqual({ type: 'INVITE_BATCH', clientRequestId: 'invite-client', batch })
    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['AUTH', 'INVITE_SUBSCRIBE'])

    socket.close(1006)
    await flush()
    await harness.runtime.handle({
      type: 'ACK_INVITE_EVENTS',
      clientRequestId: 'invite-client',
      cursor: 'cursor-1',
    })
    expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['AUTH', 'INVITE_SUBSCRIBE'])

    jest.advanceTimersByTime(1)
    await flush()
    expect(harness.messages).toContainEqual({
      type: 'NEED_TICKET',
      clientRequestId: 'invite-client',
      reconnect: true,
    })
    await harness.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'invite-client',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 'r'.repeat(40),
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    const reconnectSocket = harness.sockets[1]
    reconnectSocket.open()
    const reconnectAuth = JSON.parse(reconnectSocket.sent[0]) as { commandId: string }
    reconnectSocket.receive(
      serverFrame('AUTHENTICATED', reconnectAuth.commandId, {
        capability: 'ws-sync',
        protocolVersion: 1,
        operations: ['SYNC_ITEMS', 'INVITE_EVENTS'],
        nextClientSequence: 1,
      }),
    )
    await flush()
    const replaySubscription = JSON.parse(
      reconnectSocket.sent.find((entry) => JSON.parse(entry).type === 'INVITE_SUBSCRIBE')!,
    ) as { commandId: string; payload: { cursor: string } }
    expect(replaySubscription.payload.cursor).toBe('cursor-0')
    reconnectSocket.receive(serverFrame('INVITE_BATCH', replaySubscription.commandId, batch))
    await flush()

    expect(harness.messages.filter((message) => message.type === 'INVITE_BATCH')).toHaveLength(1)
    expect(reconnectSocket.sent.map((entry) => JSON.parse(entry).type)).toEqual([
      'AUTH',
      'INVITE_SUBSCRIBE',
      'INVITE_ACK',
    ])
    expect(JSON.parse(reconnectSocket.sent.at(-1)!).payload).toEqual({ cursor: 'cursor-1' })
  })
})
