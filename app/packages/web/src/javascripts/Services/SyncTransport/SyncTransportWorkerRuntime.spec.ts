import type { AccountSyncTransportRequest } from '@standardnotes/services'
import { LaneDegradationLedger } from './LaneDegradationLedger'
import { SyncOutboxRecord, SyncOutboxStore, SyncOutboxUnavailableError } from './SyncTransportOutbox'
import { SyncSocketCloseEvent, SyncSocketLike, SyncTransportWorkerRuntime } from './SyncTransportWorkerRuntime'
import {
  CollaborationAuthorizationTransportRequest,
  MainToSyncWorkerMessage,
  MAX_SYNC_BUFFERED_BYTES,
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
  /** Reads throw like a store whose `open()` never resolved (R21). */
  unopenable = false
  /** Reads throw with an ordinary error: a single failed operation, not a dead store. */
  failReads = false

  async put(record: SyncOutboxRecord): Promise<void> {
    if (this.failWrites) {
      throw new Error('idb unavailable')
    }
    this.records.set(record.commandId, { ...record })
  }

  async oldest(sessionScope: string): Promise<SyncOutboxRecord | undefined> {
    if (this.unopenable) {
      throw new SyncOutboxUnavailableError('Sync outbox upgrade was blocked')
    }
    if (this.failReads) {
      throw new Error('idb read failed')
    }
    return [...this.records.values()]
      .filter((record) => record.sessionScope === sessionScope && record.revoked !== true)
      .sort((left, right) => left.createdAt - right.createdAt)[0]
  }

  async heldByAnotherOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
  ): Promise<boolean> {
    if (this.unopenable) {
      throw new SyncOutboxUnavailableError('Sync outbox upgrade was blocked')
    }
    const current = this.owners.get(transportScope)
    return (
      current !== undefined &&
      current.sessionScope === sessionScope &&
      current.ownerId !== ownerId &&
      current.expiresAt > now
    )
  }

  async sessionHeldByAnotherOwner(sessionScope: string, ownerId: string, now: number): Promise<boolean> {
    if (this.unopenable) {
      throw new SyncOutboxUnavailableError('Sync outbox upgrade was blocked')
    }
    return [...this.owners.values()].some(
      (lease) => lease.sessionScope === sessionScope && lease.ownerId !== ownerId && lease.expiresAt > now,
    )
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
  onclose: ((event: SyncSocketCloseEvent) => void) | null = null
  sent: string[] = []
  /** What `close()` was asked for locally, so a test can assert the client's own close. */
  closes: { code?: number; reason?: string }[] = []

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

  /**
   * A LOCAL close, which is the only thing `SyncSocketLike` exposes. Echoed back
   * through `onclose` with the code AND reason it was asked for, like a browser.
   */
  close(code = 1000, reason = ''): void {
    this.closes.push({ code, reason })
    this.finishClose(code, reason, true)
  }

  /**
   * The gateway closing with a stated cause — a close frame arrived, so the close
   * is clean and its reason is the server's own word.
   *
   * *** THIS DOUBLE USED TO BE PART OF THE BUG. *** It mirrored a narrow
   * `{ code?: number }` close type, so no test in this file could express
   * `{ code: 1008, reason: 'sync rate limit exceeded' }` — which is exactly what
   * `gateway.attach.test.ts` asserts the gateway sends. A test that cannot see a
   * close reason proves nothing about attribution.
   */
  serverClose(code: number, reason = ''): void {
    this.finishClose(code, reason, true)
  }

  /** The connection died with no close frame: what a browser reports as 1006. */
  abort(): void {
    this.finishClose(1006, '', false)
  }

  private finishClose(code: number, reason: string, wasClean: boolean): void {
    if (this.readyState === 3) {
      return
    }
    this.readyState = 3
    this.onclose?.({ code, reason, wasClean })
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
      const credit = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'FILES_CREDIT') as string) as {
        payload: Record<string, unknown>
      }
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

      const cancel = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'FILES_CANCEL') as string) as {
        payload: Record<string, unknown>
      }
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

    // A permanent reason can never be resolved by STATUS (no socket will ever
    // exist for it), so the record is replayed over HTTP WITH its identity —
    // never id-less, and never left as RECOVERY_REQUIRED on every sync.
    await recovered.runtime.handle({
      type: 'TICKET_UNAVAILABLE',
      clientRequestId: 'client-1',
      reason: 'capability-unavailable',
    })
    expect(recovered.messages).not.toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'client-1' })
    expect(recovered.messages.filter((message) => message.type === 'HTTP_FALLBACK')).toEqual([
      {
        type: 'HTTP_FALLBACK',
        clientRequestId: 'client-1',
        reason: 'capability-unavailable',
        body: body(),
        command: {
          id: persistedCommand.commandId,
          digest: persistedCommand.digest,
          sequence: persistedCommand.sequence,
          operationId,
        },
      },
    ])
  })

  it('retains a dispatched record for STATUS when a transient ticket failure interrupts recovery', async () => {
    const shared = new FakeOutbox()
    const first = setup(shared)
    const firstSocket = await authorize(first)
    const persistedCommand = JSON.parse(
      firstSocket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string,
    ) as { commandId: string }
    await first.runtime.handle({ type: 'SHUTDOWN' })

    const recovered = setup(shared)
    await recovered.runtime.handle({ type: 'RECOVER', clientRequestId: 'client-1', sessionScope: SESSION_A })
    await recovered.runtime.handle({
      type: 'TICKET_UNAVAILABLE',
      clientRequestId: 'client-1',
      reason: 'ticket-unavailable',
    })

    expect(recovered.messages).toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'client-1' })
    expect(recovered.messages.filter((message) => message.type === 'HTTP_FALLBACK')).toHaveLength(0)
    expect(recovered.outbox.records.get(persistedCommand.commandId)).toEqual(
      expect.objectContaining({ dispatchedAt: expect.any(Number) }),
    )
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

  it('requires durable recovery for an ingress-rejected command and closes the socket it would otherwise orphan', async () => {
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
    // Nothing reuses a DEGRADED socket and the next recovery dials a new one, so a
    // preserved socket was an authenticated orphan holding a per-user slot.
    expect(socket.readyState).toBe(3)
    expect(harness.messages.at(-1)).toEqual({ type: 'STATE', state: 'DEGRADED', reason: 'result-too-large' })
  })

  describe('a committed result the socket cannot carry', () => {
    const oversizedVerdict = (frameType: 'STATUS' | 'COMMITTED', commandId: string, digest: string): SyncServerFrame =>
      serverFrame(
        frameType,
        commandId,
        frameType === 'STATUS' ? { status: 'COMMITTED', code: 'RESULT_TOO_LARGE' } : { code: 'RESULT_TOO_LARGE' },
        digest,
      )

    it.each(['STATUS', 'COMMITTED'] as const)(
      'replays a %s verdict over HTTP with the command identity and keeps the socket READY',
      async (frameType) => {
        const harness = setup()
        const operationId = '11111111-1111-4111-8111-111111111162'
        const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, undefined, {
          operationId,
          operationIndex: 0,
        })
        const command = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
          commandId: string
          digest: string
          sequence: number
        }

        socket.receive(oversizedVerdict(frameType, command.commandId, command.digest))
        await flush()

        expect(harness.messages).not.toContainEqual(expect.objectContaining({ type: 'RESULT' }))
        expect(harness.messages).not.toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'client-1' })
        expect(harness.messages.filter((message) => message.type === 'HTTP_FALLBACK')).toEqual([
          {
            type: 'HTTP_FALLBACK',
            clientRequestId: 'client-1',
            reason: 'result-too-large',
            body: body(),
            command: { id: command.commandId, digest: command.digest, sequence: command.sequence, operationId },
          },
        ])
        expect(harness.messages.at(-1)).toEqual({ type: 'STATE', state: 'READY' })
        expect(socket.readyState).toBe(1)
        // The record survives until the HTTP result is checkpointed.
        expect(harness.outbox.records.get(command.commandId)).toEqual(
          expect.objectContaining({ dispatchedAt: expect.any(Number) }),
        )
      },
    )

    it('escapes the recovery loop: STATUS on a new socket gets the same verdict and replays over HTTP', async () => {
      const shared = new FakeOutbox()
      const first = setup(shared)
      const firstSocket = await authorize(first)
      const command = JSON.parse(firstSocket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
        commandId: string
        digest: string
        sequence: number
      }
      // The tab dies before the main thread could replay the first verdict.
      firstSocket.receive(oversizedVerdict('STATUS', command.commandId, command.digest))
      await flush()
      await first.runtime.handle({ type: 'SHUTDOWN' })

      const recovered = setup(shared)
      await recovered.runtime.handle({ type: 'RECOVER', clientRequestId: 'recover-1', sessionScope: SESSION_A })
      await recovered.runtime.handle({
        type: 'CONNECT',
        clientRequestId: 'recover-1',
        sessionScope: SESSION_A,
        authorization: {
          endpoint: 'wss://sync.example.test/sockets/sync',
          ticket: 'r'.repeat(40),
          expiresAt: Date.now() + 30_000,
          deviceId: 'device-1',
        },
      })
      const socket = recovered.sockets.at(-1) as FakeSocket
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
      await flush()
      await flush()
      const status = JSON.parse(socket.sent[1]) as { type: string; commandId: string }
      expect(status).toEqual(expect.objectContaining({ type: 'STATUS', commandId: command.commandId }))

      socket.receive(oversizedVerdict('STATUS', command.commandId, command.digest))
      await flush()

      expect(recovered.messages).not.toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'recover-1' })
      expect(recovered.messages.filter((message) => message.type === 'HTTP_FALLBACK')).toEqual([
        expect.objectContaining({
          clientRequestId: 'recover-1',
          reason: 'result-too-large',
          command: expect.objectContaining({ id: command.commandId, digest: command.digest }),
        }),
      ])
      expect(socket.readyState).toBe(1)
      expect(recovered.sockets).toHaveLength(1)
    })
  })

  it('replays the persisted record over HTTP with its identity when recovery is told the lane is ruled out', async () => {
    const shared = new FakeOutbox()
    const first = setup(shared)
    const firstSocket = await authorize(first)
    const command = JSON.parse(firstSocket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
      commandId: string
      digest: string
      sequence: number
    }
    await first.runtime.handle({ type: 'SHUTDOWN' })

    const recovered = setup(shared)
    await recovered.runtime.handle({
      type: 'RECOVER',
      clientRequestId: 'recover-1',
      sessionScope: SESSION_A,
      replayOverHttp: 'http-only',
    })

    expect(recovered.messages.map((message) => message.type)).toEqual(['COMMAND_PERSISTED', 'STATE', 'HTTP_FALLBACK'])
    expect(recovered.messages).toContainEqual({
      type: 'HTTP_FALLBACK',
      clientRequestId: 'recover-1',
      reason: 'http-only',
      body: body(),
      command: { id: command.commandId, digest: command.digest, sequence: command.sequence },
    })
    expect(recovered.messages).not.toContainEqual(expect.objectContaining({ type: 'NEED_TICKET' }))
    expect(recovered.sockets).toHaveLength(0)
  })

  it('re-tickets exactly once for a stale session and settles the command through STATUS on the new socket', async () => {
    const harness = setup()
    const socket = await authorize(harness)
    const command = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
      commandId: string
      digest: string
    }

    socket.receive(serverFrame('ERROR', command.commandId, { code: 'SESSION_STALE', retryable: true }, command.digest))
    await flush()

    // An in-place refresh is tried FIRST and keeps the socket. Only once it is
    // reported unavailable does the pre-existing re-ticket run.
    const refresh = harness.messages.find((message) => message.type === 'NEED_SESSION_REFRESH') as Extract<
      SyncWorkerToMainMessage,
      { type: 'NEED_SESSION_REFRESH' }
    >
    expect(refresh).toEqual({ type: 'NEED_SESSION_REFRESH', refreshId: expect.any(String), sessionScope: SESSION_A })
    expect(socket.readyState).toBe(1)
    await harness.runtime.handle({ type: 'SESSION_REFRESH_UNAVAILABLE', refreshId: refresh.refreshId })
    await flush()

    expect(socket.readyState).toBe(3)
    expect(harness.messages).not.toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'client-1' })
    expect(harness.messages.at(-1)).toEqual({ type: 'NEED_TICKET', clientRequestId: 'client-1', reconnect: true })

    await harness.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'client-1',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 'n'.repeat(40),
        expiresAt: Date.now() + 30_000,
        deviceId: 'device-1',
      },
    })
    const fresh = harness.sockets.at(-1) as FakeSocket
    expect(fresh).not.toBe(socket)
    fresh.open()
    const auth = JSON.parse(fresh.sent[0]) as { commandId: string; payload: { ticket: string } }
    expect(auth.payload.ticket).toBe('n'.repeat(40))
    fresh.receive(
      serverFrame('AUTHENTICATED', auth.commandId, {
        capability: 'ws-sync',
        protocolVersion: 1,
        operations: ['SYNC_ITEMS'],
        nextClientSequence: 1,
      }),
    )
    await flush()
    await flush()
    expect(JSON.parse(fresh.sent[1])).toEqual(expect.objectContaining({ type: 'STATUS', commandId: command.commandId }))

    // A second stale verdict on the same request gets one more in-place attempt —
    // the budget is per socket and this is a new socket — but no second re-ticket:
    // once the refresh is unavailable again the command goes to durable recovery.
    fresh.receive(serverFrame('ERROR', command.commandId, { code: 'SESSION_STALE', retryable: true }, command.digest))
    await flush()
    const secondRefresh = harness.messages.filter((message) => message.type === 'NEED_SESSION_REFRESH') as Extract<
      SyncWorkerToMainMessage,
      { type: 'NEED_SESSION_REFRESH' }
    >[]
    expect(secondRefresh).toHaveLength(2)
    await harness.runtime.handle({ type: 'SESSION_REFRESH_UNAVAILABLE', refreshId: secondRefresh[1].refreshId })
    await flush()
    expect(harness.messages).toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'client-1' })
    expect(harness.messages.filter((message) => message.type === 'NEED_TICKET')).toHaveLength(2)
  })

  describe('in-place session-credential refresh', () => {
    const REFRESH_TICKET = 'r'.repeat(40)

    const GET_RPC = {
      method: 'GET' as const,
      path: '/v1/admin/sync-diagnostics',
      headers: { accept: 'application/json' },
      deadlineMs: 30_000,
      initialCreditBytes: 4_096,
      stream: false,
    }

    const sentFrames = (socket: FakeSocket) =>
      socket.sent.map(
        (entry) =>
          JSON.parse(entry) as {
            type: string
            requestId: string
            commandId: string
            sequence: number
            digest?: string
            payload: Record<string, unknown>
          },
      )

    const framesOfType = (socket: FakeSocket, type: string) => sentFrames(socket).filter((frame) => frame.type === type)

    const refreshRequests = (harness: ReturnType<typeof setup>) =>
      harness.messages.filter((message) => message.type === 'NEED_SESSION_REFRESH') as Extract<
        SyncWorkerToMainMessage,
        { type: 'NEED_SESSION_REFRESH' }
      >[]

    const commandFrame = (socket: FakeSocket) => {
      const frame = framesOfType(socket, 'COMMAND')[0]
      return { commandId: frame.commandId, digest: frame.digest as string }
    }

    /** The gateway's `failAndClose` addresses its final ERROR to `protocol`/`protocol`. */
    const protocolError = (code: string): SyncServerFrame => ({
      ...serverFrame('ERROR', 'protocol', { code, retryable: false }),
      requestId: 'protocol',
    })

    const openRpcSocket = async (harness: ReturnType<typeof setup>, clientRequestId = 'rpc-1') => {
      await harness.runtime.handle({ type: 'OPEN_RPC', clientRequestId, sessionScope: SESSION_A, request: GET_RPC })
      await harness.runtime.handle({
        type: 'CONNECT',
        clientRequestId,
        sessionScope: SESSION_A,
        authorization: {
          endpoint: 'wss://sync.example.test/sockets/sync',
          ticket: 't'.repeat(40),
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
          operations: ['SYNC_ITEMS', 'API_RPC'],
          nextClientSequence: 1,
        }),
      )
      await flush()
      return socket
    }

    const answerRefresh = async (harness: ReturnType<typeof setup>, index: number) => {
      const refresh = refreshRequests(harness)[index]
      expect(refresh).toBeDefined()
      await harness.runtime.handle({
        type: 'SESSION_REFRESH_TICKET',
        refreshId: refresh.refreshId,
        ticket: REFRESH_TICKET,
        deviceId: 'device-1',
      })
      await flush()
      return refresh
    }

    it('repairs the credential on the LIVE socket and settles the refused save through STATUS', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS'])
      const command = commandFrame(socket)

      socket.receive(
        serverFrame('ERROR', command.commandId, { code: 'SESSION_STALE', retryable: true }, command.digest),
      )
      await flush()

      // The socket is kept: no close, no second socket, no reconnect ticket.
      expect(socket.readyState).toBe(1)
      expect(harness.sockets).toHaveLength(1)
      expect(refreshRequests(harness)).toHaveLength(1)
      expect(harness.messages.filter((message) => message.type === 'NEED_TICKET')).toHaveLength(1)

      await answerRefresh(harness, 0)
      const reauth = framesOfType(socket, 'REAUTH')
      expect(reauth).toHaveLength(1)
      expect(reauth[0].payload).toEqual({ ticket: REFRESH_TICKET, deviceId: 'device-1' })
      // The gateway refuses sequence 0 for REAUTH; it is a mid-stream frame.
      expect(reauth[0].sequence).toBeGreaterThanOrEqual(1)
      expect(reauth[0].commandId).not.toBe(command.commandId)

      socket.receive(serverFrame('REAUTHENTICATED', reauth[0].commandId, {}))
      await flush()
      await flush()

      // Resumed by asking STATUS for the SAME durable identity. Exactly one COMMAND
      // frame ever crossed this socket, so nothing can have been applied twice.
      expect(framesOfType(socket, 'COMMAND')).toHaveLength(1)
      const status = framesOfType(socket, 'STATUS')
      expect(status).toHaveLength(1)
      expect(status[0].commandId).toBe(command.commandId)
      expect(status[0].digest).toBe(command.digest)
      expect(harness.sockets).toHaveLength(1)
      expect(socket.readyState).toBe(1)

      socket.receive(
        serverFrame(
          'STATUS',
          command.commandId,
          { status: 'COMMITTED', result: { status: 200, data: { ok: true } } },
          command.digest,
        ),
      )
      await flush()
      expect(harness.messages).toContainEqual({
        type: 'RESULT',
        clientRequestId: 'client-1',
        commandId: command.commandId,
        result: { status: 200, data: { ok: true } },
      })
      expect(harness.messages.some((message) => message.type === 'RECOVERY_REQUIRED')).toBe(false)
      expect(harness.messages.some((message) => message.type === 'HTTP_FALLBACK')).toBe(false)
    })

    it('refreshes and retries an API_RPC read answered 401, reusing the same request', async () => {
      const harness = setup()
      const socket = await openRpcSocket(harness)
      const first = framesOfType(socket, 'RPC_REQUEST')[0]

      socket.receive(serverFrame('RPC_ACCEPTED', first.commandId, { accepted: true }))
      socket.receive(
        serverFrame('RPC_RESPONSE', first.commandId, {
          status: 401,
          headers: { 'content-type': 'application/json' },
          stream: false,
          body: { error: { tag: 'expired-access-token' } },
        }),
      )
      await flush()

      // The refusal is withheld, not delivered: nothing reached the caller yet.
      expect(harness.messages.some((message) => message.type === 'RPC_RESPONSE')).toBe(false)
      expect(refreshRequests(harness)).toHaveLength(1)

      await answerRefresh(harness, 0)
      const reauth = framesOfType(socket, 'REAUTH')[0]
      socket.receive(serverFrame('REAUTHENTICATED', reauth.commandId, {}))
      await flush()

      const requests = framesOfType(socket, 'RPC_REQUEST')
      expect(requests).toHaveLength(2)
      expect(requests[1].payload).toEqual(requests[0].payload)
      expect(requests[1].commandId).not.toBe(requests[0].commandId)

      // The trailer of the abandoned attempt must neither fail the retry nor kill
      // the socket: it is addressed to a commandId nothing answers to any more.
      socket.receive(serverFrame('RPC_END', first.commandId, { status: 'COMPLETED' }))
      await flush()
      expect(harness.messages.some((message) => message.type === 'RPC_ERROR')).toBe(false)
      expect(socket.readyState).toBe(1)

      socket.receive(serverFrame('RPC_ACCEPTED', requests[1].commandId, { accepted: true }))
      socket.receive(
        serverFrame('RPC_RESPONSE', requests[1].commandId, {
          status: 200,
          headers: {},
          stream: false,
          body: { ok: 1 },
        }),
      )
      socket.receive(serverFrame('RPC_END', requests[1].commandId, { status: 'COMPLETED' }))
      await flush()

      expect(harness.messages.filter((message) => message.type === 'RPC_RESPONSE')).toEqual([
        { type: 'RPC_RESPONSE', clientRequestId: 'rpc-1', status: 200, headers: {}, stream: false, body: { ok: 1 } },
      ])
      expect(harness.messages).toContainEqual({ type: 'RPC_END', clientRequestId: 'rpc-1' })
    })

    it('never retries a mutating API_RPC request, delivers its refusal, and still repairs the socket', async () => {
      const harness = setup()
      await harness.runtime.handle({
        type: 'OPEN_RPC',
        clientRequestId: 'rpc-mutation',
        sessionScope: SESSION_A,
        request: {
          method: 'POST',
          path: '/v1/admin/email-delivery/test',
          headers: { 'content-type': 'application/json' },
          body: { to: 'someone' },
          idempotencyKey: 'assistant-1',
          deadlineMs: 30_000,
          initialCreditBytes: 4_096,
          stream: false,
        },
      })
      await harness.runtime.handle({
        type: 'CONNECT',
        clientRequestId: 'rpc-mutation',
        sessionScope: SESSION_A,
        authorization: {
          endpoint: 'wss://sync.example.test/sockets/sync',
          ticket: 't'.repeat(40),
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
          operations: ['SYNC_ITEMS', 'API_RPC'],
          nextClientSequence: 1,
        }),
      )
      await flush()

      const request = framesOfType(socket, 'RPC_REQUEST')[0]
      expect(request.payload).toEqual(expect.objectContaining({ idempotencyKey: 'assistant-1' }))
      socket.receive(serverFrame('RPC_ACCEPTED', request.commandId, { accepted: true }))
      socket.receive(serverFrame('RPC_RESPONSE', request.commandId, { status: 401, headers: {}, stream: false }))
      await flush()

      // No replay and no second frame: the client cannot establish whether the
      // mutation was applied, so the refusal is the answer it is given.
      expect(framesOfType(socket, 'RPC_REQUEST')).toHaveLength(1)
      expect(harness.messages).toContainEqual({
        type: 'RPC_RESPONSE',
        clientRequestId: 'rpc-mutation',
        status: 401,
        headers: {},
        stream: false,
      })
      /**
       * ...but the CREDENTIAL IS STILL REPAIRED. This used to assert no refresh at
       * all, which conflated two different things: whether THIS request may be
       * replayed, and whether the SOCKET is replaying a credential the server has
       * started refusing. Measured live, the second one left the lane answering 498
       * forever after a `POST /v1/sessions/refresh` while the REAUTH that fixes it
       * takes 21-30 ms — and the four lanes that never see an RPC status were
       * stranded on it with no way to notice.
       *
       * No REAUTH frame yet: the worker asks the main thread for a ticket and this
       * test never answers, so nothing is presented on the socket.
       */
      expect(refreshRequests(harness)).toHaveLength(1)
      expect(framesOfType(socket, 'REAUTH')).toHaveLength(0)
    })

    it('delivers the withheld API_RPC refusal verbatim when the refresh does not succeed', async () => {
      const harness = setup()
      const socket = await openRpcSocket(harness)
      const first = framesOfType(socket, 'RPC_REQUEST')[0]
      socket.receive(serverFrame('RPC_ACCEPTED', first.commandId, { accepted: true }))
      socket.receive(
        serverFrame('RPC_RESPONSE', first.commandId, {
          status: 498,
          headers: { 'content-type': 'application/json' },
          stream: false,
          body: { error: { tag: 'expired-access-token' } },
        }),
      )
      await flush()

      const refresh = refreshRequests(harness)[0]
      await harness.runtime.handle({ type: 'SESSION_REFRESH_UNAVAILABLE', refreshId: refresh.refreshId })
      await flush()

      expect(framesOfType(socket, 'RPC_REQUEST')).toHaveLength(1)
      expect(harness.messages.filter((message) => message.type === 'RPC_RESPONSE')).toEqual([
        {
          type: 'RPC_RESPONSE',
          clientRequestId: 'rpc-1',
          status: 498,
          headers: { 'content-type': 'application/json' },
          stream: false,
          body: { error: { tag: 'expired-access-token' } },
        },
      ])
      expect(harness.messages).toContainEqual({ type: 'RPC_END', clientRequestId: 'rpc-1' })
      expect(socket.readyState).toBe(1)
    })

    it('bounds refreshes per socket and is not replenished by a successful one', async () => {
      const harness = setup()
      const socket = await openRpcSocket(harness, 'rpc-0')

      const refuseAndObserve = async (attempt: number, clientRequestId: string) => {
        const requests = framesOfType(socket, 'RPC_REQUEST')
        const pending = requests.at(-1) as (typeof requests)[number]
        socket.receive(serverFrame('RPC_ACCEPTED', pending.commandId, { accepted: true }))
        socket.receive(serverFrame('RPC_RESPONSE', pending.commandId, { status: 401, headers: {}, stream: false }))
        await flush()
        if (refreshRequests(harness).length === attempt + 1) {
          await answerRefresh(harness, attempt)
          const reauth = framesOfType(socket, 'REAUTH').at(-1) as (typeof requests)[number]
          socket.receive(serverFrame('REAUTHENTICATED', reauth.commandId, {}))
          await flush()
          const retried = framesOfType(socket, 'RPC_REQUEST').at(-1) as (typeof requests)[number]
          socket.receive(serverFrame('RPC_ACCEPTED', retried.commandId, { accepted: true }))
          socket.receive(serverFrame('RPC_RESPONSE', retried.commandId, { status: 200, headers: {}, stream: false }))
          socket.receive(serverFrame('RPC_END', retried.commandId, { status: 'COMPLETED' }))
          await flush()
        }
        void clientRequestId
      }

      await refuseAndObserve(0, 'rpc-0')
      for (let attempt = 1; attempt < 5; attempt++) {
        await harness.runtime.handle({
          type: 'OPEN_RPC',
          clientRequestId: `rpc-${attempt}`,
          sessionScope: SESSION_A,
          request: GET_RPC,
        })
        await flush()
        await refuseAndObserve(attempt, `rpc-${attempt}`)
      }

      // Four refreshes, each of which SUCCEEDED, and then no more: success does not
      // replenish the budget, so a refusal that keeps recurring cannot spin.
      expect(refreshRequests(harness)).toHaveLength(4)
      expect(framesOfType(socket, 'REAUTH')).toHaveLength(4)
      // The fifth refusal is simply delivered.
      expect(harness.messages).toContainEqual({
        type: 'RPC_RESPONSE',
        clientRequestId: 'rpc-4',
        status: 401,
        headers: {},
        stream: false,
      })
    })

    it('coalesces refusals from two lanes into one refresh and resumes both', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'API_RPC'])
      const command = commandFrame(socket)
      await harness.runtime.handle({
        type: 'OPEN_RPC',
        clientRequestId: 'rpc-1',
        sessionScope: SESSION_A,
        request: GET_RPC,
      })
      await flush()
      const rpcRequest = framesOfType(socket, 'RPC_REQUEST')[0]

      socket.receive(
        serverFrame('ERROR', command.commandId, { code: 'SESSION_STALE', retryable: true }, command.digest),
      )
      socket.receive(serverFrame('RPC_ACCEPTED', rpcRequest.commandId, { accepted: true }))
      socket.receive(serverFrame('RPC_RESPONSE', rpcRequest.commandId, { status: 401, headers: {}, stream: false }))
      await flush()

      // One credential, one ticket: the second lane joins the refresh already running.
      expect(refreshRequests(harness)).toHaveLength(1)

      await answerRefresh(harness, 0)
      expect(framesOfType(socket, 'REAUTH')).toHaveLength(1)
      socket.receive(serverFrame('REAUTHENTICATED', framesOfType(socket, 'REAUTH')[0].commandId, {}))
      await flush()
      await flush()

      expect(framesOfType(socket, 'COMMAND')).toHaveLength(1)
      expect(framesOfType(socket, 'STATUS')[0].commandId).toBe(command.commandId)
      expect(framesOfType(socket, 'RPC_REQUEST')).toHaveLength(2)
      expect(socket.readyState).toBe(1)
    })

    it('stops asking once the gateway answers that it cannot refresh this credential', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS'])
      const command = commandFrame(socket)

      socket.receive(
        serverFrame('ERROR', command.commandId, { code: 'SESSION_STALE', retryable: true }, command.digest),
      )
      await flush()
      await answerRefresh(harness, 0)
      socket.receive(
        serverFrame('ERROR', framesOfType(socket, 'REAUTH')[0].commandId, {
          code: 'OPERATION_UNAVAILABLE',
          retryable: false,
        }),
      )
      await flush()

      // The pre-existing recovery takes over: one fresh ticket on a fresh socket.
      expect(socket.readyState).toBe(3)
      expect(harness.messages.at(-1)).toEqual({ type: 'NEED_TICKET', clientRequestId: 'client-1', reconnect: true })

      await harness.runtime.handle({
        type: 'CONNECT',
        clientRequestId: 'client-1',
        sessionScope: SESSION_A,
        authorization: {
          endpoint: 'wss://sync.example.test/sockets/sync',
          ticket: 'n'.repeat(40),
          expiresAt: Date.now() + 30_000,
          deviceId: 'device-1',
        },
      })
      const fresh = harness.sockets.at(-1) as FakeSocket
      fresh.open()
      const auth = JSON.parse(fresh.sent[0]) as { commandId: string }
      fresh.receive(
        serverFrame('AUTHENTICATED', auth.commandId, {
          capability: 'ws-sync',
          protocolVersion: 1,
          operations: ['SYNC_ITEMS'],
          nextClientSequence: 1,
        }),
      )
      await flush()
      await flush()
      fresh.receive(serverFrame('ERROR', command.commandId, { code: 'SESSION_STALE', retryable: true }, command.digest))
      await flush()

      // The answer was structural, so it outlives the socket: no second ticket is
      // minted and spent to be told the same thing.
      expect(refreshRequests(harness)).toHaveLength(1)
      expect(framesOfType(fresh, 'REAUTH')).toHaveLength(0)
      expect(harness.messages).toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'client-1' })
    })

    it('terminates without retrying when the gateway reports the session is no longer authorized', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS'])
      const command = commandFrame(socket)

      socket.receive(
        serverFrame('ERROR', command.commandId, { code: 'SESSION_STALE', retryable: true }, command.digest),
      )
      await flush()
      await answerRefresh(harness, 0)
      expect(framesOfType(socket, 'REAUTH')).toHaveLength(1)

      socket.receive(protocolError('NOT_AUTHORIZED'))
      await flush()
      socket.close(1008)
      await flush()

      expect(harness.messages).toContainEqual({ type: 'SESSION_NOT_AUTHORIZED', sessionScope: SESSION_A })
      expect(harness.messages).toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'client-1' })
      // No re-dial and no second refresh: a revoked session is not a retryable one.
      expect(harness.messages.filter((message) => message.type === 'NEED_TICKET')).toHaveLength(1)
      expect(refreshRequests(harness)).toHaveLength(1)
      // The command is retained for reconciliation rather than replayed.
      expect(harness.messages.some((message) => message.type === 'HTTP_FALLBACK')).toBe(false)
      expect(harness.outbox.records.get(command.commandId)).toEqual(
        expect.objectContaining({ commandId: command.commandId, dispatchedAt: expect.any(Number) }),
      )
    })

    it('ignores a refresh ticket that arrives after its socket is gone', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS'])
      const command = commandFrame(socket)

      socket.receive(
        serverFrame('ERROR', command.commandId, { code: 'SESSION_STALE', retryable: true }, command.digest),
      )
      await flush()
      const refresh = refreshRequests(harness)[0]
      socket.close(1006)
      await flush()

      await harness.runtime.handle({
        type: 'SESSION_REFRESH_TICKET',
        refreshId: refresh.refreshId,
        ticket: REFRESH_TICKET,
        deviceId: 'device-1',
      })
      await flush()

      // The refresh belonged to a connection that no longer exists; the close path
      // owns the command, and the one-use ticket is discarded rather than spent.
      expect(framesOfType(socket, 'REAUTH')).toHaveLength(0)
      expect(harness.messages.some((message) => message.type === 'SESSION_NOT_AUTHORIZED')).toBe(false)
      expect(harness.outbox.records.get(command.commandId)).toEqual(
        expect.objectContaining({ commandId: command.commandId, dispatchedAt: expect.any(Number) }),
      )
    })
  })

  it('runs discovery once more on the same socket when the grant reports the challenge expired', async () => {
    const harness = setup()
    const { socket, discovery } = await startCollaborationHandshake(harness)
    const discoveryAnswer = (requestId: string, commandId: string) => ({
      ...serverFrame('COLLABORATION_AUTHORIZED', commandId, {
        epochDiscovery: true,
        room: 'note-1',
        serverUpdatedAtTimestamp: 123,
        collaborationProtocolVersion: 3,
        roomEpoch: ROOM_EPOCH,
        collaborationSecurityEpoch: SECURITY_EPOCH,
        epochDiscoveryChallenge: 'challenge_abcdefghijklmnopqrstuvwxyz0123456789',
        epochDiscoveryRequestId: requestId,
        challengeExpiresAt: Date.now() + 10_000,
      }),
      requestId,
    })
    const authorizationFrames = () =>
      socket.sent
        .map(
          (entry) =>
            JSON.parse(entry) as {
              type: string
              requestId: string
              commandId: string
              payload: Record<string, unknown>
            },
        )
        .filter((frame) => frame.type === 'COLLABORATION_AUTHORIZE')

    socket.receive(discoveryAnswer(discovery.requestId, discovery.commandId))
    await flush()
    const firstGrant = authorizationFrames()[1]
    socket.receive(serverFrame('ERROR', firstGrant.commandId, { code: 'CHALLENGE_EXPIRED', retryable: true }))
    await flush()

    const frames = authorizationFrames()
    expect(frames).toHaveLength(3)
    expect(frames[2].payload).toEqual({ noteUuid: 'note-1', collaborationProtocolVersion: 3, epochDiscovery: true })
    expect(frames[2].commandId).not.toBe(firstGrant.commandId)
    expect(harness.messages.some((message) => message.type === 'COLLABORATION_DENIED')).toBe(false)
    expect(harness.messages.some((message) => message.type === 'COLLABORATION_FALLBACK')).toBe(false)
    expect(socket.readyState).toBe(1)

    // The retry budget is one: a second expiry is reported, not retried forever.
    socket.receive(discoveryAnswer(frames[2].requestId, frames[2].commandId))
    await flush()
    const secondGrant = authorizationFrames()[3]
    socket.receive(serverFrame('ERROR', secondGrant.commandId, { code: 'CHALLENGE_EXPIRED', retryable: true }))
    await flush()
    expect(authorizationFrames()).toHaveLength(4)
    expect(harness.messages).toContainEqual(
      expect.objectContaining({ type: 'COLLABORATION_FALLBACK', clientRequestId: 'collaboration-client-1' }),
    )
  })

  it('keeps item sync on HTTP for the rest of the session once the server answers LIVE_SYNC_DISABLED', async () => {
    const harness = setup()
    const socket = await authorize(harness)
    const command = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
      commandId: string
      digest: string
      sequence: number
    }

    socket.receive(
      serverFrame('ERROR', command.commandId, { code: 'LIVE_SYNC_DISABLED', retryable: false }, command.digest),
    )
    await flush()

    expect(harness.messages).not.toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'client-1' })
    expect(harness.messages.filter((message) => message.type === 'HTTP_FALLBACK')).toEqual([
      {
        type: 'HTTP_FALLBACK',
        clientRequestId: 'client-1',
        reason: 'live-sync-disabled',
        body: body(),
        command: { id: command.commandId, digest: command.digest, sequence: command.sequence },
      },
    ])
    expect(harness.messages.at(-1)).toEqual({ type: 'STATE', state: 'READY' })
    expect(socket.readyState).toBe(1)
    await harness.runtime.handle({
      type: 'CHECKPOINT_DURABLE',
      requestId: 'checkpoint-1',
      sessionScope: SESSION_A,
      commandId: command.commandId,
    })

    const framesBefore = socket.sent.length
    await harness.runtime.handle({
      type: 'EXECUTE',
      clientRequestId: 'client-2',
      body: body('b'),
      sessionScope: SESSION_A,
    })
    await flush()

    expect(socket.sent).toHaveLength(framesBefore)
    expect(harness.messages).toContainEqual({
      type: 'HTTP_FALLBACK',
      clientRequestId: 'client-2',
      reason: 'live-sync-disabled',
      body: body('b'),
    })
    expect(harness.messages).not.toContainEqual(
      expect.objectContaining({ type: 'NEED_TICKET', clientRequestId: 'client-2' }),
    )
  })

  it('dials on a ticket whose server-clock expiry is already behind the local clock when no local expiry is known', async () => {
    const harness = setup()
    await harness.runtime.handle({
      type: 'EXECUTE',
      clientRequestId: 'client-1',
      body: body(),
      sessionScope: SESSION_A,
    })
    await harness.runtime.handle({
      type: 'CONNECT',
      clientRequestId: 'client-1',
      sessionScope: SESSION_A,
      authorization: {
        endpoint: 'wss://sync.example.test/sockets/sync',
        ticket: 's'.repeat(40),
        // A browser clock 60 s ahead of the server sees every fresh ticket like this.
        expiresAt: Date.now() - 60_000,
        deviceId: 'device-1',
      },
    })

    expect(harness.sockets).toHaveLength(1)
    expect(harness.messages).not.toContainEqual(expect.objectContaining({ reason: 'ticket-expired' }))
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
        localExpiresAt: Date.now(),
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
        localExpiresAt: Date.now(),
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

    // The reconnect backoff has a 1 s floor (R24), so nothing is dialled sooner.
    jest.advanceTimersByTime(1_000)
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

  /**
   * Ported from the t90-e6 runtime probes (P1-P5) that observed these paths on a
   * live runtime. Each case asserts the behaviour the fix installs, so reverting
   * the fix fails the case rather than merely changing an internal.
   */
  describe('multi-tab leases, outbox recovery and reconnect budget', () => {
    const ENDPOINT = 'wss://sync.example.test/sockets/sync'
    const TRANSPORT_SCOPE = `${SESSION_A}|wss://sync.example.test/sockets/sync|device-1`

    const dial = async (harness: ReturnType<typeof setup>, clientRequestId: string, sessionScope = SESSION_A) => {
      await harness.runtime.handle({
        type: 'CONNECT',
        clientRequestId,
        sessionScope,
        authorization: {
          endpoint: ENDPOINT,
          ticket: 't'.repeat(40),
          expiresAt: Date.now() + 30_000,
          deviceId: 'device-1',
        },
      })
      return harness.sockets.at(-1) as FakeSocket
    }

    const handshake = (socket: FakeSocket, operations: string[] = ['SYNC_ITEMS']) => {
      const auth = JSON.parse(socket.sent[0]) as { commandId: string }
      socket.receive(
        serverFrame('AUTHENTICATED', auth.commandId, {
          capability: 'ws-sync',
          protocolVersion: 1,
          operations,
          nextClientSequence: 1,
        }),
      )
    }

    const ticketRequests = (harness: ReturnType<typeof setup>, clientRequestId: string) =>
      harness.messages.filter(
        (message): message is Extract<SyncWorkerToMainMessage, { type: 'NEED_TICKET' }> =>
          message.type === 'NEED_TICKET' && message.clientRequestId === clientRequestId,
      )

    const fallbacks = (harness: ReturnType<typeof setup>, clientRequestId: string) =>
      harness.messages.filter(
        (message): message is Extract<SyncWorkerToMainMessage, { type: 'HTTP_FALLBACK' }> =>
          message.type === 'HTTP_FALLBACK' && message.clientRequestId === clientRequestId,
      )

    const settleCommand = async (harness: ReturnType<typeof setup>, socket: FakeSocket) => {
      const command = JSON.parse(socket.sent[1]) as { commandId: string; digest: string }
      socket.receive(serverFrame('COMMITTED', command.commandId, { result: { retrieved_items: [] } }, command.digest))
      await flush()
      await harness.runtime.handle({
        type: 'CHECKPOINT_DURABLE',
        requestId: 'checkpoint-1',
        sessionScope: SESSION_A,
        commandId: command.commandId,
      })
      await flush()
      return command
    }

    it('P1: an outbox that cannot be opened sends the command to HTTP instead of demanding recovery', async () => {
      const harness = setup()
      harness.outbox.unopenable = true

      await harness.runtime.handle({
        type: 'EXECUTE',
        clientRequestId: 'c1',
        body: body(),
        sessionScope: SESSION_A,
      })

      expect(fallbacks(harness, 'c1')).toEqual([
        { type: 'HTTP_FALLBACK', clientRequestId: 'c1', reason: 'outbox-unavailable', body: body() },
      ])
      expect(harness.messages.filter((message) => message.type === 'RECOVERY_REQUIRED')).toHaveLength(0)
    })

    it('P1: an unopenable outbox reports nothing to recover instead of wedging every later sync', async () => {
      const harness = setup()
      harness.outbox.unopenable = true

      await harness.runtime.handle({ type: 'RECOVER', clientRequestId: 'r1', sessionScope: SESSION_A })

      expect(harness.messages).toEqual([{ type: 'RECOVERY_EMPTY', clientRequestId: 'r1' }])
    })

    it('still demands durable recovery when a single outbox read fails on a healthy store', async () => {
      const harness = setup()
      harness.outbox.failReads = true

      await harness.runtime.handle({
        type: 'EXECUTE',
        clientRequestId: 'c1',
        body: body(),
        sessionScope: SESSION_A,
      })
      await harness.runtime.handle({ type: 'RECOVER', clientRequestId: 'r1', sessionScope: SESSION_A })

      expect(harness.messages).toEqual([
        { type: 'RECOVERY_REQUIRED', clientRequestId: 'c1' },
        { type: 'RECOVERY_REQUIRED', clientRequestId: 'r1' },
      ])
    })

    it('P2: a command takes over a bootstrap that exists only to open the socket', async () => {
      const harness = setup()
      await harness.runtime.handle({
        type: 'OPEN_RPC',
        clientRequestId: 'rpc1',
        sessionScope: SESSION_A,
        request: {
          method: 'GET' as const,
          path: '/v1/workflows/status',
          headers: { accept: 'application/json' },
          deadlineMs: 30_000,
          initialCreditBytes: 8,
          stream: false,
        },
      })
      expect(ticketRequests(harness, 'rpc1')).toHaveLength(1)

      await harness.runtime.handle({
        type: 'EXECUTE',
        clientRequestId: 'c1',
        body: body(),
        sessionScope: SESSION_A,
      })

      expect(harness.messages.filter((message) => message.type === 'RECOVERY_REQUIRED')).toHaveLength(0)
      expect(ticketRequests(harness, 'c1')).toHaveLength(1)

      const socket = await dial(harness, 'c1')
      socket.open()
      handshake(socket, ['SYNC_ITEMS', 'API_RPC'])
      await flush()
      await flush()

      expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['AUTH', 'RPC_REQUEST', 'COMMAND'])
    })

    it('leaves a bootstrap running when a recovery finds nothing to take over', async () => {
      const harness = setup()
      await harness.runtime.handle({
        type: 'OPEN_RPC',
        clientRequestId: 'rpc1',
        sessionScope: SESSION_A,
        request: {
          method: 'GET' as const,
          path: '/v1/workflows/status',
          headers: { accept: 'application/json' },
          deadlineMs: 30_000,
          initialCreditBytes: 8,
          stream: false,
        },
      })
      expect(ticketRequests(harness, 'rpc1')).toHaveLength(1)

      await harness.runtime.handle({ type: 'RECOVER', clientRequestId: 'r1', sessionScope: SESSION_A })
      expect(harness.messages).toContainEqual({ type: 'RECOVERY_EMPTY', clientRequestId: 'r1' })

      // The ticket the bootstrap already asked for still arrives to an owner; a
      // recovery that took the bootstrap over and then bailed would drop it, and
      // the RPC would hang to its deadline on a socket nobody dialled.
      const socket = await dial(harness, 'rpc1')
      socket.open()
      handshake(socket, ['SYNC_ITEMS', 'API_RPC'])
      await flush()
      await flush()

      expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['AUTH', 'RPC_REQUEST'])
    })

    it('P3: three reconnects are spent before a command gives up on the socket', async () => {
      const harness = setup()
      await harness.runtime.handle({
        type: 'EXECUTE',
        clientRequestId: 'c1',
        body: body(),
        sessionScope: SESSION_A,
      })

      for (let attempt = 0; attempt < 4; attempt++) {
        const socket = await dial(harness, 'c1')
        socket.open()
        socket.close(1006)
        await flush()
        jest.advanceTimersByTime(1_000)
        await flush()
      }

      expect(ticketRequests(harness, 'c1').filter((message) => message.reconnect === true)).toHaveLength(3)
      expect(fallbacks(harness, 'c1')).toHaveLength(1)
    })

    it('P3: a successful handshake replenishes the reconnect budget for later commands', async () => {
      const harness = setup()
      await harness.runtime.handle({
        type: 'EXECUTE',
        clientRequestId: 'c1',
        body: body(),
        sessionScope: SESSION_A,
      })
      for (let attempt = 0; attempt < 4; attempt++) {
        const socket = await dial(harness, 'c1')
        socket.open()
        socket.close(1006)
        await flush()
        jest.advanceTimersByTime(1_000)
        await flush()
      }
      expect(fallbacks(harness, 'c1')).toHaveLength(1)

      await harness.runtime.handle({
        type: 'EXECUTE',
        clientRequestId: 'c2',
        body: body('b'),
        sessionScope: SESSION_A,
      })
      const socket = await dial(harness, 'c2')
      socket.open()
      handshake(socket)
      await flush()
      await flush()
      socket.close(1006)
      await flush()
      jest.advanceTimersByTime(1_000)
      await flush()

      expect(ticketRequests(harness, 'c2').filter((message) => message.reconnect === true)).toHaveLength(1)
      expect(fallbacks(harness, 'c2')).toHaveLength(0)
    })

    it('P4: a tab that loses the ownership race at the socket does not re-buy the answer', async () => {
      const harness = setup()

      await harness.runtime.handle({
        type: 'EXECUTE',
        clientRequestId: 'c1',
        body: body(),
        sessionScope: SESSION_A,
      })
      // The store was free when this tab looked, so it asked for a ticket.
      expect(ticketRequests(harness, 'c1')).toHaveLength(1)

      // Another tab claims the lease while this one waits for that ticket. The
      // race is settled at `acquireOwner`, and it is the only way a ticket can
      // still be spent on a socket this tab cannot have.
      harness.outbox.owners.set(TRANSPORT_SCOPE, {
        sessionScope: SESSION_A,
        ownerId: 'other-tab',
        expiresAt: Date.now() + 15_000,
      })
      await dial(harness, 'c1')
      expect(harness.sockets).toHaveLength(0)
      expect(fallbacks(harness, 'c1').map((message) => message.reason)).toEqual(['multi-tab-not-owner'])

      await harness.runtime.handle({
        type: 'EXECUTE',
        clientRequestId: 'c2',
        body: body('b'),
        sessionScope: SESSION_A,
      })
      expect(ticketRequests(harness, 'c2')).toHaveLength(0)
      expect(fallbacks(harness, 'c2').map((message) => message.reason)).toEqual(['multi-tab-not-owner'])

      // ... and it takes the socket back as soon as the other tab's lease lapses.
      jest.advanceTimersByTime(16_000)
      await harness.runtime.handle({
        type: 'EXECUTE',
        clientRequestId: 'c3',
        body: body('c'),
        sessionScope: SESSION_A,
      })
      expect(ticketRequests(harness, 'c3')).toHaveLength(1)
    })

    it('P4: a tab that has never dialled reads the lease store rather than buying a ticket to ask', async () => {
      const harness = setup()
      // Keyed under a scope this tab cannot compute: the endpoint arrives with
      // the ticket it is trying not to request.
      harness.outbox.owners.set(TRANSPORT_SCOPE, {
        sessionScope: SESSION_A,
        ownerId: 'other-tab',
        expiresAt: Date.now() + 15_000,
      })

      await harness.runtime.handle({
        type: 'EXECUTE',
        clientRequestId: 'c1',
        body: body(),
        sessionScope: SESSION_A,
      })

      expect(ticketRequests(harness, 'c1')).toHaveLength(0)
      expect(harness.sockets).toHaveLength(0)
      expect(fallbacks(harness, 'c1').map((message) => message.reason)).toEqual(['multi-tab-not-owner'])
    })

    it('P4: spends no further ticket across lease windows while the owner keeps renewing', async () => {
      const harness = setup()
      const renewLease = () =>
        harness.outbox.owners.set(TRANSPORT_SCOPE, {
          sessionScope: SESSION_A,
          ownerId: 'other-tab',
          expiresAt: Date.now() + 15_000,
        })
      renewLease()

      // Four syncs spread over three lease windows, the owner renewing between
      // them exactly as its 5 s interval would.
      for (let sync = 0; sync < 4; sync++) {
        await harness.runtime.handle({
          type: 'EXECUTE',
          clientRequestId: `c${sync}`,
          body: body(String(sync)),
          sessionScope: SESSION_A,
        })
        expect(fallbacks(harness, `c${sync}`).map((message) => message.reason)).toEqual(['multi-tab-not-owner'])
        jest.advanceTimersByTime(16_000)
        renewLease()
      }

      expect(harness.messages.filter((message) => message.type === 'NEED_TICKET')).toHaveLength(0)
      expect(harness.sockets).toHaveLength(0)
    })

    it('P5: losing the owner lease while idle closes the socket instead of waiting for the next command', async () => {
      const harness = setup()
      const socket = await authorize(harness)
      await settleCommand(harness, socket)
      expect(socket.readyState).toBe(1)

      harness.outbox.owners.set(TRANSPORT_SCOPE, {
        sessionScope: SESSION_A,
        ownerId: 'other-tab',
        expiresAt: Date.now() + 15_000,
      })
      const before = harness.messages.length
      jest.advanceTimersByTime(5_100)
      await flush()
      await flush()

      // HTTP_FALLBACK, not DEGRADED: there is no socket and nothing is recovering —
      // another tab owns the lane. DEGRADED here claimed a live socket to the
      // diagnostics pane and made the announced state alternate against the
      // HTTP_FALLBACK the other lanes post for the identical cause (t103).
      expect(harness.messages.slice(before)).toEqual([
        { type: 'STATE', state: 'HTTP_FALLBACK', reason: 'multi-tab-not-owner' },
      ])
      expect(socket.readyState).toBe(3)

      // The renewal interval is gone with the socket: no second verdict arrives.
      const afterClose = harness.messages.length
      jest.advanceTimersByTime(20_000)
      await flush()
      expect(harness.messages).toHaveLength(afterClose)
    })

    it('hands the owner lease back when the page goes away, and keeps it while work is in flight', async () => {
      const harness = setup()
      const socket = await authorize(harness)

      // A command is still in flight: releasing here would strand it.
      await harness.runtime.handle({ type: 'RELEASE_OWNER' })
      expect(socket.readyState).toBe(1)
      expect(harness.outbox.owners.has(TRANSPORT_SCOPE)).toBe(true)

      await settleCommand(harness, socket)
      await harness.runtime.handle({ type: 'RELEASE_OWNER' })

      expect(socket.readyState).toBe(3)
      expect(harness.outbox.owners.has(TRANSPORT_SCOPE)).toBe(false)
    })

    it('reports that shutdown finished so the page need not terminate the worker blind', async () => {
      const harness = setup()
      const socket = await authorize(harness)
      await settleCommand(harness, socket)

      await harness.runtime.handle({ type: 'SHUTDOWN' })

      expect(harness.outbox.owners.has(TRANSPORT_SCOPE)).toBe(false)
      expect(harness.messages.at(-1)).toEqual({ type: 'SHUTDOWN_COMPLETE' })
    })

    it('closes a socket that stops answering PING, and keeps one that answers', async () => {
      const harness = setup()
      const socket = await authorize(harness)
      await settleCommand(harness, socket)

      jest.advanceTimersByTime(30_000)
      await flush()
      expect(JSON.parse(socket.sent.at(-1) as string).type).toBe('PING')

      jest.advanceTimersByTime(60_000)
      await flush()
      expect(socket.readyState).toBe(3)

      const answering = setup()
      const liveSocket = await authorize(answering)
      await settleCommand(answering, liveSocket)
      jest.advanceTimersByTime(30_000)
      await flush()
      const ping = JSON.parse(liveSocket.sent.at(-1) as string) as { commandId: string }
      liveSocket.receive(serverFrame('PONG', ping.commandId, {}))
      await flush()
      jest.advanceTimersByTime(59_000)
      await flush()
      expect(liveSocket.readyState).toBe(1)
    })

    it('gives the backend its full deadline before calling a command unanswered', async () => {
      const harness = setup()
      const socket = await authorize(harness)

      jest.advanceTimersByTime(15_000)
      await flush()
      expect(socket.readyState).toBe(1)

      jest.advanceTimersByTime(5_000)
      await flush()
      expect(socket.readyState).toBe(3)
    })

    it('treats a missing invite lane on a READY socket as settled for the session', async () => {
      const harness = setup()
      await harness.runtime.handle({
        type: 'SUBSCRIBE_INVITE_EVENTS',
        clientRequestId: 'invite-1',
        sessionScope: SESSION_A,
        limit: 50,
      })
      const socket = await dial(harness, 'invite-1')
      socket.open()
      handshake(socket, ['SYNC_ITEMS'])
      await flush()

      expect(harness.messages).toContainEqual({
        type: 'INVITE_ERROR',
        clientRequestId: 'invite-1',
        code: 'OPERATION_UNAVAILABLE',
        retryable: false,
      })

      socket.close(1006)
      await flush()
      await harness.runtime.handle({
        type: 'SUBSCRIBE_INVITE_EVENTS',
        clientRequestId: 'invite-2',
        sessionScope: SESSION_A,
        limit: 50,
      })

      expect(ticketRequests(harness, 'invite-2')).toHaveLength(0)
      expect(harness.messages.at(-1)).toEqual({
        type: 'INVITE_ERROR',
        clientRequestId: 'invite-2',
        code: 'OPERATION_UNAVAILABLE',
        retryable: false,
      })
    })

    /**
     * Standard Red Notes (t103). A second tab of the same account logged
     * `MULTI_TAB_NOT_OWNER` as a failed, retryable invite subscription — six times in
     * one page session with no user action — and flipped the announced transport state
     * between DEGRADED (invite lane) and HTTP_FALLBACK (sync/collaboration lanes) for
     * that one unchanged cause. Neither is a fault: the condition is correct, stable,
     * and clears when the owning tab closes.
     */
    describe('an invite subscription behind another tab is deferred, not failed', () => {
      const holdLease = (harness: ReturnType<typeof setup>) =>
        harness.outbox.owners.set(TRANSPORT_SCOPE, {
          sessionScope: SESSION_A,
          ownerId: 'other-tab',
          expiresAt: Date.now() + 15_000,
        })

      const subscribe = (harness: ReturnType<typeof setup>, clientRequestId: string) =>
        harness.runtime.handle({
          type: 'SUBSCRIBE_INVITE_EVENTS',
          clientRequestId,
          sessionScope: SESSION_A,
          cursor: 'cursor-0',
          limit: 50,
        })

      const inviteMessages = (harness: ReturnType<typeof setup>, type: 'INVITE_ERROR' | 'INVITE_DEFERRED') =>
        harness.messages.filter((message) => message.type === type)

      const states = (harness: ReturnType<typeof setup>) =>
        harness.messages.filter(
          (message): message is Extract<SyncWorkerToMainMessage, { type: 'STATE' }> => message.type === 'STATE',
        )

      it('reports INVITE_DEFERRED, keeps the subscription, and never calls it an error', async () => {
        const harness = setup()
        holdLease(harness)

        await subscribe(harness, 'invite-1')

        // Precondition: the lease really refused this attempt, locally, without
        // buying a ticket to be told so.
        expect(ticketRequests(harness, 'invite-1')).toHaveLength(0)
        expect(harness.sockets).toHaveLength(0)

        expect(inviteMessages(harness, 'INVITE_DEFERRED')).toEqual([
          {
            type: 'INVITE_DEFERRED',
            clientRequestId: 'invite-1',
            reason: 'multi-tab-not-owner',
            resumeAfterMilliseconds: 15_000,
          },
        ])
        // The defect: this condition used to arrive as a retryable failure, which is
        // the instruction the durable coordinator loops on.
        expect(inviteMessages(harness, 'INVITE_ERROR')).toEqual([])
      })

      /**
       * Measured, because the live capture showed five `POST /v1/collaboration/authorize`
       * alongside the loop and the two looked related. `NEED_TICKET` is the worker's
       * ONLY network-touching output, so zero of it across a loop's worth of attempts
       * is proof the invite retries cost no request. What does send an authorization to
       * HTTP is `COLLABORATION_FALLBACK`, from the collaboration lane, per authorize —
       * a different lane with a different trigger.
       */
      it('costs no request however many times the loop re-opened it, and does not drive authorize', async () => {
        const harness = setup()
        holdLease(harness)

        for (let attempt = 0; attempt < 6; attempt += 1) {
          await subscribe(harness, `invite-${attempt}`)
        }

        // Precondition: all six attempts really reached the worker and were answered.
        expect(inviteMessages(harness, 'INVITE_DEFERRED')).toHaveLength(6)
        expect(harness.messages.filter((message) => message.type === 'NEED_TICKET')).toHaveLength(0)
        expect(harness.sockets).toHaveLength(0)
        expect(harness.messages.filter((message) => message.type === 'COLLABORATION_FALLBACK')).toHaveLength(0)

        // One collaboration authorization, refused by the same lease, is what hands an
        // authorize to HTTP — one fallback per attempt, from this lane alone.
        await harness.runtime.handle({
          type: 'AUTHORIZE_COLLABORATION',
          clientRequestId: 'collab-1',
          sessionScope: SESSION_A,
          request: {
            noteUuid: 'note-1',
            collaborationProtocolVersion: 3,
            expectedRoomEpoch: ROOM_EPOCH,
            leaseRequestId: 'lease-1',
            bootstrapChallenge: 'bootstrap-challenge-1',
          },
        })

        expect(harness.messages.filter((message) => message.type === 'COLLABORATION_FALLBACK')).toEqual([
          { type: 'COLLABORATION_FALLBACK', clientRequestId: 'collab-1', reason: 'multi-tab-not-owner' },
        ])
      })

      it('settles on one announced state for the cause instead of alternating with the other lanes', async () => {
        const harness = setup()
        holdLease(harness)

        // The invite lane and an ordinary sync, interleaved exactly as the live log
        // showed them, on one unchanged cause.
        await subscribe(harness, 'invite-1')
        await harness.runtime.handle({
          type: 'EXECUTE',
          clientRequestId: 'sync-1',
          body: body('one'),
          sessionScope: SESSION_A,
        })
        await harness.runtime.handle({
          type: 'AUTHORIZE_COLLABORATION',
          clientRequestId: 'collab-1',
          sessionScope: SESSION_A,
          request: {
            noteUuid: 'note-1',
            collaborationProtocolVersion: 3,
            expectedRoomEpoch: ROOM_EPOCH,
            leaseRequestId: 'lease-1',
            bootstrapChallenge: 'bootstrap-challenge-1',
          },
        })

        const reported = states(harness).filter((message) => message.reason === 'multi-tab-not-owner')
        // Precondition: more than one lane really reported, so a single value below
        // is a settled state and not an empty log.
        expect(reported.length).toBeGreaterThan(2)
        expect([...new Set(reported.map((message) => message.state))]).toEqual(['HTTP_FALLBACK'])
      })

      it('takes the lane when ownership transfers, from the lease watch alone', async () => {
        const harness = setup()
        holdLease(harness)
        await subscribe(harness, 'invite-1')
        expect(inviteMessages(harness, 'INVITE_DEFERRED')).toHaveLength(1)

        // Still held — the owner renewing on its own 5 s interval. The watch looks
        // across the whole lease window and dials nothing.
        for (let tick = 0; tick < 3; tick += 1) {
          holdLease(harness)
          jest.advanceTimersByTime(5_000)
          await flush()
          await flush()
        }
        expect(ticketRequests(harness, 'invite-1')).toHaveLength(0)
        expect(harness.sockets).toHaveLength(0)

        // The owning tab closes and hands the lease back.
        harness.outbox.owners.delete(TRANSPORT_SCOPE)
        jest.advanceTimersByTime(15_100)
        await flush()
        await flush()

        expect(ticketRequests(harness, 'invite-1')).toHaveLength(1)
        const socket = await dial(harness, 'invite-1')
        socket.open()
        handshake(socket, ['SYNC_ITEMS', 'INVITE_EVENTS'])
        await flush()

        const subscribeFrames = socket.sent
          .map((entry) => JSON.parse(entry) as { type: string; payload?: { cursor?: string; limit?: number } })
          .filter((frame) => frame.type === 'INVITE_SUBSCRIBE')
        expect(subscribeFrames).toHaveLength(1)
        expect(subscribeFrames[0].payload).toEqual({ cursor: 'cursor-0', limit: 50 })

        // The watch is done: nothing keeps looking once the lane is live.
        const settled = harness.messages.length
        jest.advanceTimersByTime(60_000)
        await flush()
        expect(ticketRequests(harness, 'invite-1')).toHaveLength(1)
        expect(harness.messages.length).toBeGreaterThanOrEqual(settled)
      })

      it('resumes the parked subscription when another lane wins the socket back', async () => {
        const harness = setup()
        holdLease(harness)
        await subscribe(harness, 'invite-1')
        expect(inviteMessages(harness, 'INVITE_DEFERRED')).toHaveLength(1)

        // An ordinary sync takes the socket after the lease frees — the invite lane
        // asked for nothing and is carried along, because the worker kept it.
        harness.outbox.owners.delete(TRANSPORT_SCOPE)
        await harness.runtime.handle({
          type: 'EXECUTE',
          clientRequestId: 'sync-1',
          body: body('one'),
          sessionScope: SESSION_A,
        })
        expect(ticketRequests(harness, 'sync-1')).toHaveLength(1)
        const socket = await dial(harness, 'sync-1')
        socket.open()
        handshake(socket, ['SYNC_ITEMS', 'INVITE_EVENTS'])
        await flush()
        await flush()

        expect(socket.sent.filter((entry) => JSON.parse(entry).type === 'INVITE_SUBSCRIBE')).toHaveLength(1)
      })

      it('still fails the subscription non-retryably for a structurally absent capability', async () => {
        const harness = setup()
        await subscribe(harness, 'invite-1')
        expect(ticketRequests(harness, 'invite-1')).toHaveLength(1)

        await harness.runtime.handle({
          type: 'TICKET_UNAVAILABLE',
          clientRequestId: 'invite-1',
          reason: 'capability-unavailable',
        })
        await flush()

        expect(inviteMessages(harness, 'INVITE_DEFERRED')).toEqual([])
        expect(inviteMessages(harness, 'INVITE_ERROR')).toEqual([
          {
            type: 'INVITE_ERROR',
            clientRequestId: 'invite-1',
            code: 'CAPABILITY_UNAVAILABLE',
            retryable: false,
          },
        ])
        // A permanent reason keeps DEGRADED: the deferred classification must not
        // leak into the other two.
        expect(states(harness).filter((message) => message.reason === 'capability-unavailable')).toEqual([
          { type: 'STATE', state: 'DEGRADED', reason: 'capability-unavailable' },
        ])
      })

      it('stops watching the lease once the subscription is cancelled', async () => {
        const harness = setup()
        holdLease(harness)
        await subscribe(harness, 'invite-1')
        expect(inviteMessages(harness, 'INVITE_DEFERRED')).toHaveLength(1)

        await harness.runtime.handle({ type: 'UNSUBSCRIBE_INVITE_EVENTS', clientRequestId: 'invite-1' })
        harness.outbox.owners.delete(TRANSPORT_SCOPE)
        jest.advanceTimersByTime(60_000)
        await flush()
        await flush()

        expect(ticketRequests(harness, 'invite-1')).toHaveLength(0)
        expect(harness.sockets).toHaveLength(0)
      })
    })

    it('refuses a discovery challenge the gateway would reject when it is echoed back', async () => {
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
          // base64url leads with `-` or `_` 2/64 of the time; the gateway's own
          // envelope rule refuses that, and it closes the socket over it.
          epochDiscoveryChallenge: '_hallenge_abcdefghijklmnopqrstuvwxyz0123456789',
          epochDiscoveryRequestId: discovery.requestId,
          challengeExpiresAt: Date.now() + 10_000,
        }),
        requestId: discovery.requestId,
      })
      await flush()

      expect(harness.messages).toContainEqual({
        type: 'COLLABORATION_FALLBACK',
        clientRequestId: 'collaboration-client-1',
        reason: 'proxy-failed',
      })
      expect(socket.sent.filter((entry) => JSON.parse(entry).type === 'COLLABORATION_AUTHORIZE')).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // *** WHAT THE SERVER SAID, AND WHETHER ANYONE HEARD IT. ***
  //
  // Three independent layers each discarded the gateway's stated cause, which is
  // why a `1008 'sync rate limit exceeded'` reached the user as a bare
  // `SOCKET_CLOSED` — and that was the GENERIC behaviour for about a dozen
  // distinct server causes, not one bug:
  //
  //   1. the close type declared `{ code?: number }`, so `reason` and `wasClean`
  //      could not be read at all — and this file's own socket double mirrored it,
  //      so no test here could even express a server that states its cause;
  //   2. the only code the close site tested for was `>= 4000`, which NO server
  //      close in the repo uses — so `server-kill` was reported exactly when the
  //      client timed itself out, and every real server close reported nothing;
  //   3. the gateway's protocol-addressed ERROR frame — its last word, carrying
  //      the specific code — was dropped by the frame router.
  //
  // Every test below drives a close the gateway actually performs and asserts the
  // REASON that comes out, not that a handler ran.
  // ---------------------------------------------------------------------------
  describe('close attribution', () => {
    const protocolError = (code: string): SyncServerFrame => ({
      version: 1,
      channel: 'sync',
      type: 'ERROR',
      requestId: 'protocol',
      commandId: 'protocol',
      sequence: 2,
      payloadLength: payloadByteLength({ code, retryable: true }),
      payload: { code, retryable: true },
    })

    const degradations = (harness: ReturnType<typeof setup>) =>
      harness.messages.filter(
        (message): message is Extract<SyncWorkerToMainMessage, { type: 'STATE' }> =>
          message.type === 'STATE' && message.state === 'DEGRADED',
      )

    it('names the rate limit the gateway stated instead of reporting no cause at all', async () => {
      const harness = setup()
      const socket = await authorize(harness)

      socket.serverClose(1008, 'sync rate limit exceeded')
      await flush()

      // BEFORE: `[{ state: 'DEGRADED' }]` — no reason, for the one close the
      // operator opened the diagnostics pane to understand.
      expect(degradations(harness)).toEqual([{ type: 'STATE', state: 'DEGRADED', reason: 'rate-limited' }])
    })

    it('separates a per-user socket limit from a rate limit, though both close 1008', async () => {
      const harness = setup()
      const socket = await authorize(harness)

      socket.serverClose(1008, 'per-user connection limit exceeded')
      await flush()

      expect(degradations(harness)).toEqual([{ type: 'STATE', state: 'DEGRADED', reason: 'socket-limit' }])
    })

    it('reports a draining or restarting gateway as unavailable rather than as a kill', async () => {
      const harness = setup()
      const socket = await authorize(harness)

      socket.serverClose(1013, 'draining')
      await flush()

      expect(degradations(harness)).toEqual([{ type: 'STATE', state: 'DEGRADED', reason: 'server-unavailable' }])
    })

    it('reports a connection that died with no close frame as a reconnect gap', async () => {
      const harness = setup()
      const socket = await authorize(harness)

      socket.abort()
      await flush()

      expect(degradations(harness)).toEqual([{ type: 'STATE', state: 'DEGRADED', reason: 'reconnect-gap' }])
    })

    /**
     * *** THE INVERSION, DRIVEN END TO END. *** `code >= 4000 ? 'server-kill'` is
     * reachable only from this client's own `socket.close(4000, 'ack-timeout')`, so
     * the ONE close that used to report "the gateway closed the socket deliberately"
     * is the one the gateway had nothing to do with.
     */
    it("reports the client's own ack timeout as its own, never as a server kill", async () => {
      const harness = setup()
      const socket = await authorize(harness)

      jest.advanceTimersByTime(20_000)
      await flush()
      await flush()

      expect(socket.closes).toContainEqual({ code: 4000, reason: 'ack-timeout' })
      expect(degradations(harness).map((message) => message.reason)).toEqual(['ack-timeout'])
      expect(degradations(harness).map((message) => message.reason)).not.toContain('server-kill')
    })

    /**
     * The gateway's `failAndClose` sends ONE ERROR addressed `requestId = commandId
     * = 'protocol'` and then closes. The frame router matched it against no lane,
     * fell through to the outbox-commandId guard and returned — so it was consumed
     * only while AUTHENTICATING or during a credential refresh, and at every other
     * moment the specific code vanished.
     */
    it('consumes the gateway protocol ERROR frame and attributes the close it precedes', async () => {
      const harness = setup()
      const socket = await authorize(harness)

      socket.receive(protocolError('BACKPRESSURE'))
      await flush()
      socket.serverClose(1013, 'Sync command queue is full.')
      await flush()

      // `'backpressure'` reaching the ledger at all is new: it was a declared
      // reason with a pane counter and no code path able to emit it.
      expect(degradations(harness)).toEqual([{ type: 'STATE', state: 'DEGRADED', reason: 'backpressure' }])
    })

    it.each([
      ['SOCKET_LIMIT', 'socket-limit'],
      ['SOCKET_BUDGET_LOST', 'socket-limit'],
      ['OUT_OF_ORDER', 'server-policy'],
      ['SEQUENCE_EXHAUSTED', 'server-policy'],
      ['INVITE_ACK_INVALID', 'server-policy'],
      ['INVALID_ENVELOPE', 'server-policy'],
      ['SYNC_DISABLED', 'server-unavailable'],
      ['AUTH_TIMEOUT', 'auth-failed'],
    ])('carries the gateway %s through to the fallback reason %s', async (code, reason) => {
      const harness = setup()
      const socket = await authorize(harness)

      socket.receive(protocolError(code))
      await flush()
      socket.serverClose(1008, 'policy')
      await flush()

      expect(degradations(harness)).toEqual([{ type: 'STATE', state: 'DEGRADED', reason }])
    })

    it('does not carry one connection cause onto the next, even on an unattributable close', async () => {
      const harness = setup()
      const first = await authorize(harness)

      first.receive(protocolError('SOCKET_LIMIT'))
      await flush()
      first.abort()
      await flush()
      // The reconnect dials a fresh socket; the previous gateway's verdict must not
      // follow it, or one bad connection would mis-attribute the rest of the tab.
      jest.advanceTimersByTime(5_000)
      await flush()
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
      const second = harness.sockets.at(-1) as FakeSocket
      expect(second).not.toBe(first)
      second.open()
      second.abort()
      await flush()

      expect(degradations(harness).map((message) => message.reason)).toEqual(['socket-limit', 'reconnect-gap'])
    })

    /**
     * The collaboration lane reported `reconnect-gap` for EVERY close, including the
     * ones the gateway named. `reconnect-gap` is the honest floor for a connection
     * that simply went away; it is a lie for a rate limit, and it is the only thing
     * the caller of `AUTHORIZE_COLLABORATION` is handed.
     */
    it('tells a collaboration caller which close ended its grant', async () => {
      const harness = setup()
      const { socket } = await startCollaborationHandshake(harness)

      socket.serverClose(1008, 'sync rate limit exceeded')
      await flush()

      expect(harness.messages).toContainEqual({
        type: 'COLLABORATION_FALLBACK',
        clientRequestId: 'collaboration-client-1',
        reason: 'rate-limited',
      })
    })

    it('still reports a bare connection loss to a collaboration caller as a gap', async () => {
      const harness = setup()
      const { socket } = await startCollaborationHandshake(harness)

      socket.abort()
      await flush()

      expect(harness.messages).toContainEqual({
        type: 'COLLABORATION_FALLBACK',
        clientRequestId: 'collaboration-client-1',
        reason: 'reconnect-gap',
      })
    })

    /**
     * *** THE LEDGER COULD NOT COUNT A SINGLE SERVER-INITIATED CLOSE. ***
     *
     * `recordTransition` increments `fallbackCounts` only when the reason is
     * defined, and every raw close arrived `undefined` — so the admin pane's
     * "degradations with cause X" sat at zero through every flap. This drives the
     * real worker and feeds its real posted transitions into the real ledger, which
     * is the seam the two audits found disagreeing.
     */
    it('moves the ledger counter the admin pane reads, for a close the gateway caused', async () => {
      const harness = setup()
      const ledger = new LaneDegradationLedger({ now: () => 0, baselineState: 'HTTP_ONLY' })
      const socket = await authorize(harness)

      socket.serverClose(1008, 'sync rate limit exceeded')
      await flush()

      for (const message of harness.messages) {
        if (message.type === 'STATE') {
          ledger.recordTransition(message.state, message.reason, message.socketPreserved === true)
        }
      }

      expect(ledger.view().fallbackCounts).toEqual({ 'rate-limited': 1 })
      expect(ledger.view().transitions.map((entry) => [entry.state, entry.reason])).toContainEqual([
        'DEGRADED',
        'rate-limited',
      ])
    })

    it('reports the client outrunning its socket as backpressure, not as a broken database', async () => {
      // `'backpressure'` had an explanation sentence, a pane counter and NO emitter:
      // every throw out of `sendWithBackpressure` was a plain `Error`, and the
      // command path's catch collapsed all of them onto `'outbox-unavailable'` — a
      // reason about IndexedDB.
      const messages: SyncWorkerToMainMessage[] = []
      const sockets: FakeSocket[] = []
      let uuid = 0
      let clock = 1_700_000_000_000
      const runtime = new SyncTransportWorkerRuntime({
        outbox: new FakeOutbox(),
        postMessage: (message) => messages.push(message),
        socketFactory: () => {
          const socket = new FakeSocket()
          sockets.push(socket)
          return socket
        },
        uuid: () => `backpressure-id-${++uuid}`,
        random: () => 0,
        // Each read advances an hour, so the drain deadline is already behind us the
        // first time the loop looks and no timer has to be pumped to reach it.
        now: () => (clock += 3_600_000),
        subtle: {
          digest: jest.fn().mockResolvedValue(Uint8Array.from({ length: 32 }, () => 0xab).buffer),
        } as unknown as SubtleCrypto,
      })

      await runtime.handle({ type: 'EXECUTE', clientRequestId: 'client-1', body: body(), sessionScope: SESSION_A })
      await runtime.handle({
        type: 'CONNECT',
        clientRequestId: 'client-1',
        sessionScope: SESSION_A,
        authorization: {
          endpoint: 'wss://sync.example.test/sockets/sync',
          ticket: 't'.repeat(40),
          expiresAt: clock + 3_600_000_000,
          deviceId: 'device-1',
        },
      })
      const socket = sockets.at(-1) as FakeSocket
      socket.open()
      // A send buffer the peer is not draining: the condition `'backpressure'` names.
      socket.bufferedAmount = MAX_SYNC_BUFFERED_BYTES + 1
      const auth = JSON.parse(socket.sent[0]) as { commandId: string }
      socket.receive(
        serverFrame('AUTHENTICATED', auth.commandId, {
          capability: 'ws-sync',
          protocolVersion: 1,
          operations: ['SYNC_ITEMS'],
          nextClientSequence: 1,
        }),
      )
      await flush()
      await flush()
      await flush()

      const states = messages.filter(
        (message): message is Extract<SyncWorkerToMainMessage, { type: 'STATE' }> => message.type === 'STATE',
      )
      expect(states.map((message) => message.reason)).toContain('backpressure')
      expect(states.map((message) => message.reason)).not.toContain('outbox-unavailable')
    })
  })

  // ---------------------------------------------------------------------------
  // *** A RETRYABLE REFUSAL MUST NOT COST THE SOCKET. ***
  //
  // Nine gateway refusals — BUSY, LEASE_LOST, BACKEND_TIMEOUT, BACKEND_ERROR,
  // COMMAND_ID_CONFLICT, READ_ONLY, CONTENT_LIMIT, SHARED_VAULT_FORBIDDEN and
  // NOT_AUTHORIZED — all fell through one ERROR default to `fallback('server-kill')`,
  // which means durable recovery, a closed socket, and all six lanes lost. Two of
  // them describe a connection the gateway itself expects the client to keep using.
  // ---------------------------------------------------------------------------
  describe('a refusal on a healthy socket', () => {
    const frames = (socket: FakeSocket) =>
      socket.sent.map(
        (entry) =>
          JSON.parse(entry) as {
            type: string
            requestId: string
            commandId: string
            sequence: number
            digest?: string
            payload: Record<string, unknown>
          },
      )
    const framesOf = (socket: FakeSocket, type: string) => frames(socket).filter((frame) => frame.type === type)
    const refuse = (socket: FakeSocket, code: string) => {
      const command = framesOf(socket, 'COMMAND')[0]
      socket.receive(serverFrame('ERROR', command.commandId, { code, retryable: true }, command.digest))
    }

    it('retries a BUSY command on the same socket instead of tearing six lanes down', async () => {
      const harness = setup()
      const socket = await authorize(harness)
      const first = framesOf(socket, 'COMMAND')[0]

      refuse(socket, 'BUSY')
      await flush()

      // BEFORE: RECOVERY_REQUIRED, a 1000 close, and the collaboration rooms,
      // invite subscription, socket budget and file transfers riding this socket
      // gone — over a lease another command of this device was holding for a moment.
      expect(harness.messages.some((message) => message.type === 'RECOVERY_REQUIRED')).toBe(false)
      expect(socket.readyState).toBe(1)
      expect(socket.closes).toEqual([])

      jest.advanceTimersByTime(1_000)
      await flush()
      await flush()

      const commands = framesOf(socket, 'COMMAND')
      expect(commands).toHaveLength(2)
      // The journal's idempotency identity is reused verbatim, which is the whole
      // reason a resend cannot apply anything twice.
      expect(commands[1].commandId).toBe(first.commandId)
      expect(commands[1].digest).toBe(first.digest)
      expect(commands[1].payload).toEqual(first.payload)
      // ...and the SEQUENCE must move, or the gateway closes the socket OUT_OF_ORDER
      // and the retry destroys exactly what it was written to keep.
      expect(commands[1].sequence).toBeGreaterThan(first.sequence)
      expect(socket.readyState).toBe(1)
    })

    it('spends a bounded budget and then falls back exactly as it did before', async () => {
      const harness = setup()
      const socket = await authorize(harness)

      refuse(socket, 'BUSY')
      await flush()
      jest.advanceTimersByTime(1_000)
      await flush()
      await flush()
      refuse(socket, 'BUSY')
      await flush()
      jest.advanceTimersByTime(2_000)
      await flush()
      await flush()
      expect(framesOf(socket, 'COMMAND')).toHaveLength(3)
      expect(harness.messages.some((message) => message.type === 'RECOVERY_REQUIRED')).toBe(false)

      // Third refusal: the budget is spent, so the pre-existing path runs.
      refuse(socket, 'BUSY')
      await flush()
      await flush()

      expect(harness.messages).toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'client-1' })
      expect(socket.readyState).toBe(3)
      expect(framesOf(socket, 'COMMAND')).toHaveLength(3)
    })

    /**
     * `BACKEND_TIMEOUT` is sent from the `catch` around `backend.execute`, so the
     * durable write MAY have landed. It keeps the socket like BUSY does, and unlike
     * BUSY it may only ASK — never re-send the COMMAND, which is the one move that
     * could apply a mutation twice.
     */
    it('re-asks STATUS for an ambiguous BACKEND_TIMEOUT and never re-sends the command', async () => {
      const harness = setup()
      const socket = await authorize(harness)
      const command = framesOf(socket, 'COMMAND')[0]

      refuse(socket, 'BACKEND_TIMEOUT')
      await flush()
      jest.advanceTimersByTime(1_000)
      await flush()
      await flush()

      expect(framesOf(socket, 'COMMAND')).toHaveLength(1)
      const statuses = framesOf(socket, 'STATUS')
      expect(statuses).toHaveLength(1)
      expect(statuses[0].commandId).toBe(command.commandId)
      expect(statuses[0].digest).toBe(command.digest)
      expect(socket.readyState).toBe(1)
      expect(harness.messages.some((message) => message.type === 'RECOVERY_REQUIRED')).toBe(false)
    })

    /**
     * A command in DURABLE RECOVERY only ever put a STATUS on the wire, so a resend
     * would introduce a COMMAND frame for an operation whose effect is already
     * unknown — the one move in this file that could apply a mutation twice.
     */
    it('never re-sends a COMMAND for a recovered command, whatever the refusal', async () => {
      const shared = new FakeOutbox()
      const first = setup(shared)
      const firstSocket = await authorize(first)
      const persisted = JSON.parse(
        firstSocket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string,
      ) as { commandId: string; digest: string }
      await first.runtime.handle({ type: 'SHUTDOWN' })

      const second = setup(shared)
      await second.runtime.handle({ type: 'RECOVER', clientRequestId: 'recover-a', sessionScope: SESSION_A })
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
      const socket = second.sockets[0]
      socket.open()
      const auth = JSON.parse(socket.sent[0]) as { commandId: string }
      socket.receive(
        serverFrame('AUTHENTICATED', auth.commandId, {
          capability: 'ws-sync',
          protocolVersion: 1,
          operations: ['SYNC_ITEMS'],
          nextClientSequence: 2,
        }),
      )
      await flush()
      expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['AUTH', 'STATUS'])

      socket.receive(serverFrame('ERROR', persisted.commandId, { code: 'BUSY', retryable: true }, persisted.digest))
      await flush()
      jest.advanceTimersByTime(1_000)
      await flush()
      await flush()

      expect(socket.sent.map((entry) => JSON.parse(entry).type)).toEqual(['AUTH', 'STATUS', 'STATUS'])
      expect(socket.readyState).toBe(1)
    })

    it('still tears the socket down for a stable policy refusal, which a retry cannot change', async () => {
      // Not a blanket "never close": READ_ONLY, CONTENT_LIMIT,
      // SHARED_VAULT_FORBIDDEN, NOT_AUTHORIZED, LEASE_LOST, BACKEND_ERROR and
      // COMMAND_ID_CONFLICT all describe a condition a retry would only reproduce.
      for (const code of ['READ_ONLY', 'NOT_AUTHORIZED', 'CONTENT_LIMIT', 'LEASE_LOST', 'COMMAND_ID_CONFLICT']) {
        const harness = setup()
        const socket = await authorize(harness)

        refuse(socket, code)
        await flush()
        await flush()

        expect(harness.messages).toContainEqual({ type: 'RECOVERY_REQUIRED', clientRequestId: 'client-1' })
        expect(socket.readyState).toBe(3)
        expect(framesOf(socket, 'COMMAND')).toHaveLength(1)
      }
    })

    it('abandons a scheduled retry when the socket dies before the backoff elapses', async () => {
      const harness = setup()
      const socket = await authorize(harness)

      refuse(socket, 'BUSY')
      await flush()
      socket.abort()
      await flush()
      jest.advanceTimersByTime(1_000)
      await flush()

      // The close path owns the command from here; a retry writing to a dead socket
      // would be a second owner for one operation.
      expect(framesOf(socket, 'COMMAND')).toHaveLength(1)
    })
  })

  // ---------------------------------------------------------------------------
  // *** `safeToFallback: false` FOR EVERY SERVER RPC ERROR. ***
  //
  // `WebApplication.controlPlaneRpc` swallows an `AuthenticatedRpcError` and retries
  // over HTTP only when `safeToFallback` proves no request bytes took effect. Every
  // server ERROR frame reported `false`, so `BUSY` — the gateway refusing the ninth
  // concurrent RPC at an admission check, before any dispatch — threw at the caller
  // where HTTP would have answered, and so did `RESULT_TOO_LARGE`, whose cause is the
  // one limit HTTP does not have.
  // ---------------------------------------------------------------------------
  describe('an API_RPC refusal HTTP could answer', () => {
    const rpcRequest = (method: 'GET' | 'POST') => ({
      method,
      path: '/v1/admin/sync-diagnostics',
      headers: { accept: 'application/json' },
      deadlineMs: 30_000,
      initialCreditBytes: 4_096,
      stream: false,
      ...(method === 'GET' ? {} : { body: { a: 1 }, idempotencyKey: 'key-1' }),
    })

    const openRpc = async (harness: ReturnType<typeof setup>, method: 'GET' | 'POST' = 'GET') => {
      await harness.runtime.handle({
        type: 'OPEN_RPC',
        clientRequestId: 'rpc-1',
        sessionScope: SESSION_A,
        request: rpcRequest(method),
      })
      await harness.runtime.handle({
        type: 'CONNECT',
        clientRequestId: 'rpc-1',
        sessionScope: SESSION_A,
        authorization: {
          endpoint: 'wss://sync.example.test/sockets/sync',
          ticket: 't'.repeat(40),
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
          operations: ['SYNC_ITEMS', 'API_RPC'],
          nextClientSequence: 1,
        }),
      )
      await flush()
      const request = socket.sent
        .map((entry) => JSON.parse(entry) as { type: string; commandId: string })
        .find((frame) => frame.type === 'RPC_REQUEST') as { commandId: string }
      return { socket, commandId: request.commandId }
    }

    const errorFor = (harness: ReturnType<typeof setup>) =>
      harness.messages.find((message) => message.type === 'RPC_ERROR') as Extract<
        SyncWorkerToMainMessage,
        { type: 'RPC_ERROR' }
      >

    it.each(['BUSY', 'OPERATION_UNAVAILABLE', 'IDEMPOTENCY_KEY_REQUIRED', 'SOCKET_LIMIT', 'SYNC_DISABLED'])(
      'lets HTTP answer a pre-dispatch %s, which provably ran no handler',
      async (code) => {
        const harness = setup()
        const { socket, commandId } = await openRpc(harness)

        socket.receive(serverFrame('ERROR', commandId, { code, retryable: true }))
        await flush()

        expect(errorFor(harness)).toEqual({
          type: 'RPC_ERROR',
          clientRequestId: 'rpc-1',
          code,
          retryable: true,
          safeToFallback: true,
        })
      },
    )

    it('lets HTTP answer a read the socket frame cap refused', async () => {
      const harness = setup()
      const { socket, commandId } = await openRpc(harness, 'GET')

      socket.receive(serverFrame('ERROR', commandId, { code: 'RESULT_TOO_LARGE', retryable: true }))
      await flush()

      expect(errorFor(harness)?.safeToFallback).toBe(true)
    })

    it('refuses to re-ask a MUTATION whose effect the client cannot establish', async () => {
      const harness = setup()
      const { socket, commandId } = await openRpc(harness, 'POST')

      socket.receive(serverFrame('ERROR', commandId, { code: 'RESULT_TOO_LARGE', retryable: true }))
      await flush()

      expect(errorFor(harness)?.safeToFallback).toBe(false)
    })

    it.each(['RPC_PATH_FORBIDDEN', 'DUPLICATE_REQUEST', 'NOT_AUTHORIZED', 'CANCELLED'])(
      'leaves %s surfaced to its caller, exactly as before',
      async (code) => {
        const harness = setup()
        const { socket, commandId } = await openRpc(harness)

        socket.receive(serverFrame('ERROR', commandId, { code, retryable: false }))
        await flush()

        expect(errorFor(harness)?.safeToFallback).toBe(false)
      },
    )

    it('never calls a refusal safe once the answer has started crossing to the caller', async () => {
      const harness = setup()
      const { socket, commandId } = await openRpc(harness)

      socket.receive(serverFrame('RPC_ACCEPTED', commandId, { accepted: true }))
      socket.receive(
        serverFrame('RPC_RESPONSE', commandId, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          stream: true,
        }),
      )
      await flush()
      socket.receive(serverFrame('ERROR', commandId, { code: 'BUSY', retryable: true }))
      await flush()

      expect(errorFor(harness)?.safeToFallback).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // *** THE CREDENTIAL BELONGS TO THE SOCKET, NOT TO THE LANE THAT NOTICED. ***
  //
  // The gateway invented `SESSION_STALE` so a client could repair a frozen
  // credential in place, and `requestSessionRefresh` was wired to two of five lanes.
  // Collaboration tore the socket down on exactly that signal; the file lanes did not
  // even list it as retryable; and an RPC refusal that could not be replayed asked
  // for no repair at all, so the four lanes that never see an RPC status stayed
  // stranded on a credential the server had already started refusing.
  // ---------------------------------------------------------------------------
  describe('a stale credential on a live socket', () => {
    const framesSent = (socket: FakeSocket) =>
      socket.sent.map(
        (entry) => JSON.parse(entry) as { type: string; commandId: string; payload: Record<string, unknown> },
      )
    const typed = (socket: FakeSocket, type: string) => framesSent(socket).filter((frame) => frame.type === type)
    const refreshAsks = (harness: ReturnType<typeof setup>) =>
      harness.messages.filter((message) => message.type === 'NEED_SESSION_REFRESH') as Extract<
        SyncWorkerToMainMessage,
        { type: 'NEED_SESSION_REFRESH' }
      >[]

    const answerRefresh = async (harness: ReturnType<typeof setup>, index = 0) => {
      const ask = refreshAsks(harness)[index]
      expect(ask).toBeDefined()
      await harness.runtime.handle({
        type: 'SESSION_REFRESH_TICKET',
        refreshId: ask.refreshId,
        ticket: 'f'.repeat(40),
        deviceId: 'device-1',
      })
      await flush()
    }

    it('refreshes in place for a collaboration SESSION_STALE instead of closing the socket', async () => {
      const harness = setup()
      const { socket, discovery } = await startCollaborationHandshake(harness)

      socket.receive({
        ...serverFrame('ERROR', discovery.commandId, { code: 'SESSION_STALE', retryable: true }),
        requestId: discovery.requestId,
      })
      await flush()

      // BEFORE: `fallbackCollaboration('server-kill', false)` — a closed socket, the
      // owner lease released and the rooms gone, to fix one stale credential field.
      expect(socket.readyState).toBe(1)
      expect(socket.closes).toEqual([])
      expect(harness.messages.some((message) => message.type === 'COLLABORATION_FALLBACK')).toBe(false)
      expect(refreshAsks(harness)).toHaveLength(1)

      await answerRefresh(harness)
      const reauth = typed(socket, 'REAUTH')
      expect(reauth).toHaveLength(1)
      socket.receive(serverFrame('REAUTHENTICATED', reauth[0].commandId, { refreshed: true }))
      await flush()
      await flush()

      // One more authorization on the SAME socket, from the phase the refusal
      // interrupted, with a fresh command id so the frames stay unambiguous.
      const authorizations = typed(socket, 'COLLABORATION_AUTHORIZE')
      expect(authorizations).toHaveLength(2)
      expect(authorizations[1].commandId).not.toBe(discovery.commandId)
      expect(socket.readyState).toBe(1)
    })

    it('falls back for a collaboration SESSION_STALE the refresh could not repair', async () => {
      const harness = setup()
      const { socket, discovery } = await startCollaborationHandshake(harness)

      socket.receive({
        ...serverFrame('ERROR', discovery.commandId, { code: 'SESSION_STALE', retryable: true }),
        requestId: discovery.requestId,
      })
      await flush()
      const ask = refreshAsks(harness)[0]
      await harness.runtime.handle({ type: 'SESSION_REFRESH_UNAVAILABLE', refreshId: ask.refreshId })
      await flush()
      await flush()

      // The behaviour that existed before an in-place refresh was possible.
      expect(harness.messages).toContainEqual({
        type: 'COLLABORATION_FALLBACK',
        clientRequestId: 'collaboration-client-1',
        reason: 'server-kill',
      })
      expect(socket.readyState).toBe(3)
    })

    it('still denies a collaboration request the gateway refused on policy, with no refresh', async () => {
      const harness = setup()
      const { socket, discovery } = await startCollaborationHandshake(harness)

      socket.receive({
        ...serverFrame('ERROR', discovery.commandId, { code: 'NOT_AUTHORIZED', retryable: false }),
        requestId: discovery.requestId,
      })
      await flush()

      expect(harness.messages).toContainEqual({
        type: 'COLLABORATION_DENIED',
        clientRequestId: 'collaboration-client-1',
      })
      expect(refreshAsks(harness)).toHaveLength(0)
    })

    it('reports a file SESSION_STALE as retryable and asks for the repair the gateway offered', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
      await harness.runtime.handle({
        type: 'OPEN_FILE_DOWNLOAD',
        clientRequestId: 'file-1',
        sessionScope: SESSION_A,
        request: {
          resource: { ownershipType: 'user', remoteIdentifier: REMOTE_IDENTIFIER, fileUuid: FILE_UUID },
          declaredSize: 16,
          initialCreditBytes: 512 * 1024,
          deadlineMs: 30_000,
        },
      })
      await flush()
      const open = typed(socket, 'FILES_DOWNLOAD_OPEN')[0]
      expect(open).toBeDefined()

      socket.receive(serverFrame('ERROR', open.commandId, { code: 'SESSION_STALE', retryable: true }))
      await flush()

      // `RETRYABLE_FILE_ERROR_CODES` simply did not list it, so the one refusal the
      // gateway made repairable was reported as a stable condition.
      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: 'FILE_DOWNLOAD_ERROR',
          clientRequestId: 'file-1',
          code: 'SESSION_STALE',
          retryable: true,
        }),
      )
      expect(refreshAsks(harness)).toHaveLength(1)
      expect(socket.readyState).toBe(1)
    })

    it('leaves a stable file refusal non-retryable and asks for nothing', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'FILES_V1'])
      await harness.runtime.handle({
        type: 'OPEN_FILE_DOWNLOAD',
        clientRequestId: 'file-1',
        sessionScope: SESSION_A,
        request: {
          resource: { ownershipType: 'user', remoteIdentifier: REMOTE_IDENTIFIER, fileUuid: FILE_UUID },
          declaredSize: 16,
          initialCreditBytes: 512 * 1024,
          deadlineMs: 30_000,
        },
      })
      await flush()
      const open = typed(socket, 'FILES_DOWNLOAD_OPEN')[0]

      socket.receive(serverFrame('ERROR', open.commandId, { code: 'FILE_NOT_FOUND', retryable: false }))
      await flush()

      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'FILE_DOWNLOAD_ERROR', code: 'FILE_NOT_FOUND', retryable: false }),
      )
      expect(refreshAsks(harness)).toHaveLength(0)
    })

    /**
     * *** A SUCCESS-SHAPED FRAME CARRYING A FAILURE STATUS. ***
     *
     * A 498 arrives inside an ostensibly successful `RPC_RESPONSE`, so no error
     * handling sees it. Where the response can be withheld the lane already refreshed
     * and retried; where it cannot — a stream, a mutation — nothing asked for a
     * repair, and the gateway kept answering 498 for the life of the socket.
     */
    it('repairs the socket for a 498 inside a streaming response it cannot withhold', async () => {
      const harness = setup()
      await harness.runtime.handle({
        type: 'OPEN_RPC',
        clientRequestId: 'rpc-stream',
        sessionScope: SESSION_A,
        request: {
          method: 'GET',
          path: '/v1/assistant/stream',
          headers: { accept: 'text/event-stream' },
          deadlineMs: 30_000,
          initialCreditBytes: 4_096,
          stream: true,
        },
      })
      await harness.runtime.handle({
        type: 'CONNECT',
        clientRequestId: 'rpc-stream',
        sessionScope: SESSION_A,
        authorization: {
          endpoint: 'wss://sync.example.test/sockets/sync',
          ticket: 't'.repeat(40),
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
          operations: ['SYNC_ITEMS', 'API_RPC'],
          nextClientSequence: 1,
        }),
      )
      await flush()
      const request = typed(socket, 'RPC_REQUEST')[0]
      socket.receive(serverFrame('RPC_ACCEPTED', request.commandId, { accepted: true }))
      socket.receive(serverFrame('RPC_RESPONSE', request.commandId, { status: 498, headers: {}, stream: true }))
      await flush()

      // The answer still reaches the caller untouched: `controlPlaneRpc` degrades a
      // 401/498 read to HTTP on purpose and that net must keep working.
      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'RPC_RESPONSE', clientRequestId: 'rpc-stream', status: 498 }),
      )
      // ...and the socket gets repaired, which is what nothing used to do.
      expect(refreshAsks(harness)).toHaveLength(1)
      expect(typed(socket, 'RPC_REQUEST')).toHaveLength(1)
    })

    it('asks for no repair when the response status is not a credential refusal', async () => {
      const harness = setup()
      await harness.runtime.handle({
        type: 'OPEN_RPC',
        clientRequestId: 'rpc-ok',
        sessionScope: SESSION_A,
        request: {
          method: 'GET',
          path: '/v1/admin/sync-diagnostics',
          headers: { accept: 'application/json' },
          deadlineMs: 30_000,
          initialCreditBytes: 4_096,
          stream: false,
        },
      })
      await harness.runtime.handle({
        type: 'CONNECT',
        clientRequestId: 'rpc-ok',
        sessionScope: SESSION_A,
        authorization: {
          endpoint: 'wss://sync.example.test/sockets/sync',
          ticket: 't'.repeat(40),
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
          operations: ['SYNC_ITEMS', 'API_RPC'],
          nextClientSequence: 1,
        }),
      )
      await flush()
      const request = typed(socket, 'RPC_REQUEST')[0]
      socket.receive(serverFrame('RPC_ACCEPTED', request.commandId, { accepted: true }))
      socket.receive(serverFrame('RPC_RESPONSE', request.commandId, { status: 403, headers: {}, stream: false }))
      await flush()

      expect(refreshAsks(harness)).toHaveLength(0)
    })
  })

  // ---------------------------------------------------------------------------
  // *** A SOCKET TEARDOWN ORPHANED THE INVITE SUBSCRIPTION PERMANENTLY. ***
  //
  // `closeSocketAndReleaseOwner` cleared `sent` and posted nothing, so the
  // coordinator's `session.connection` symbol stayed set, `hasLiveSubscription()`
  // answered true forever, and the `online` / `visibilitychange` re-arm in
  // `WebApplication` returned at its first line for the rest of the tab's life. Only
  // an `INVITE_ERROR` reaches `handleTransportError`, which is the one path in the
  // coordinator that disposes the subscription and clears that symbol.
  // ---------------------------------------------------------------------------
  describe('an invite subscription whose socket is torn down', () => {
    const subscribe = async (harness: ReturnType<typeof setup>, socket: FakeSocket) => {
      await harness.runtime.handle({
        type: 'SUBSCRIBE_INVITE_EVENTS',
        clientRequestId: 'invite-1',
        sessionScope: SESSION_A,
        limit: 100,
      })
      await flush()
      expect(socket.sent.some((entry) => JSON.parse(entry).type === 'INVITE_SUBSCRIBE')).toBe(true)
    }

    const inviteMessages = (harness: ReturnType<typeof setup>) =>
      harness.messages.filter((message) => message.type === 'INVITE_ERROR' || message.type === 'INVITE_DEFERRED')

    it('tells the subscription owner the lane is gone when a command tears the socket down', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'INVITE_EVENTS'])
      await subscribe(harness, socket)
      const command = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
        commandId: string
        digest: string
      }

      // A durable-recovery teardown: the socket closes and nothing re-dials it.
      socket.receive(serverFrame('ERROR', command.commandId, { code: 'READ_ONLY', retryable: false }, command.digest))
      await flush()
      await flush()

      expect(socket.readyState).toBe(3)
      expect(harness.messages).toContainEqual({
        type: 'INVITE_ERROR',
        clientRequestId: 'invite-1',
        code: 'SOCKET_CLOSED',
        retryable: true,
      })
    })

    it('says it exactly once, however many teardowns run', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'INVITE_EVENTS'])
      await subscribe(harness, socket)
      const command = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
        commandId: string
        digest: string
      }

      socket.receive(serverFrame('ERROR', command.commandId, { code: 'READ_ONLY', retryable: false }, command.digest))
      await flush()
      await flush()
      await harness.runtime.handle({ type: 'RELEASE_OWNER' })
      await flush()

      expect(inviteMessages(harness)).toHaveLength(1)
    })

    it('stays silent while shutting down, which already answers every lane', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'INVITE_EVENTS'])
      await subscribe(harness, socket)

      await harness.runtime.handle({ type: 'SHUTDOWN' })
      await flush()

      expect(inviteMessages(harness)).toEqual([])
    })

    /**
     * The one teardown that is a REPLACEMENT. `reticket` drops a socket in order to
     * dial another immediately, and its handshake re-sends the subscription — so
     * telling the owner the lane is gone would make it dispose and re-subscribe
     * underneath a worker already doing exactly that.
     */
    it('stays silent for a re-ticket, which re-arms the subscription itself', async () => {
      const harness = setup()
      const socket = await authorize(harness, body(), 't'.repeat(40), SESSION_A, ['SYNC_ITEMS', 'INVITE_EVENTS'])
      await subscribe(harness, socket)
      const command = JSON.parse(socket.sent.find((entry) => JSON.parse(entry).type === 'COMMAND') as string) as {
        commandId: string
        digest: string
      }

      // SESSION_STALE with no refresh available is the re-ticket path.
      socket.receive(
        serverFrame('ERROR', command.commandId, { code: 'SESSION_STALE', retryable: true }, command.digest),
      )
      await flush()
      const refresh = harness.messages.find((message) => message.type === 'NEED_SESSION_REFRESH') as Extract<
        SyncWorkerToMainMessage,
        { type: 'NEED_SESSION_REFRESH' }
      >
      await harness.runtime.handle({ type: 'SESSION_REFRESH_UNAVAILABLE', refreshId: refresh.refreshId })
      await flush()
      await flush()

      expect(harness.messages).toContainEqual(
        expect.objectContaining({ type: 'NEED_TICKET', clientRequestId: 'client-1', reconnect: true }),
      )
      expect(inviteMessages(harness)).toEqual([])
    })

    it('does not speak over a deferral that already parked the subscription', async () => {
      // `multi-tab-not-owner` posts INVITE_DEFERRED and keeps the subscription
      // registered; an INVITE_ERROR after it would un-park the coordinator and drive
      // one dispose, one re-dial and one logged failure per backoff tick, forever.
      const harness = setup()
      harness.outbox.owners.set('other-scope', {
        sessionScope: SESSION_A,
        ownerId: 'another-tab',
        expiresAt: Date.now() + 60_000,
      })
      await harness.runtime.handle({
        type: 'SUBSCRIBE_INVITE_EVENTS',
        clientRequestId: 'invite-1',
        sessionScope: SESSION_A,
        limit: 100,
      })
      await flush()
      await harness.runtime.handle({
        type: 'CONNECT',
        clientRequestId: 'invite-1',
        sessionScope: SESSION_A,
        authorization: {
          endpoint: 'wss://sync.example.test/sockets/sync',
          ticket: 't'.repeat(40),
          expiresAt: Date.now() + 30_000,
          deviceId: 'device-1',
        },
      })
      await flush()

      expect(harness.messages).toContainEqual(
        expect.objectContaining({
          type: 'INVITE_DEFERRED',
          clientRequestId: 'invite-1',
          reason: 'multi-tab-not-owner',
        }),
      )
      expect(inviteMessages(harness)).toHaveLength(1)
    })
  })
})
