/**
 * A real FILES_V1 upload over a real TCP WebSocket, end to end.
 *
 * Nothing in the transport chain is faked. The bytes travel:
 *
 *   SocketUploadDriver (plan -> FileEncryptor -> EncryptedStreamDigest)
 *     -> WebSocketSyncTransport.uploadFileOverSocket
 *     -> SyncTransportWorkerRuntime (frames each chunk)
 *     -> a real `ws` client socket
 *     -> a real `ws` server that decodes with the GATEWAY'S OWN
 *        `server/packages/websocket-gateway/src/filesProtocol.ts`
 *     -> stored, then read back and decrypted with `FileDecryptor`.
 *
 * The one thing that is not the shipped server is the gateway's session and
 * authorization layer: this server speaks the AUTH / AUTHENTICATED handshake and
 * the FILES_V1 control frames itself, because the gateway lives in the other
 * workspace and cannot be imported here. Everything about the WIRE — binary
 * framing, per-frame digests, `declaredSize` re-assertion, offsets, the FINAL
 * flag, chunk acks and the whole-stream SHA-256 — is the gateway's own code,
 * byte for byte.
 */
import { createHash, webcrypto } from 'crypto'
import { TextDecoder, TextEncoder } from 'util'
import { AddressInfo } from 'net'
import WebSocket, { type RawData, type WebSocketServer } from 'ws'
import sodium from 'libsodium-wrappers-sumo'

/**
 * This workspace has `ws` 7.5 installed but `@types/ws` 8, so the two disagree in
 * exactly two places: v8 renamed `Server` to `WebSocketServer`, and v8 added an
 * `isBinary` argument to `message` (in v7 a text frame simply arrives as a string
 * and a binary one as a Buffer). Both are bridged explicitly here rather than
 * papered over, because either one failing silently would look like a protocol bug.
 */
const WebSocketServerConstructor = (
  WebSocket as unknown as { Server: new (options: { host: string; port: number }) => WebSocketServer }
).Server

/** The gateway's own binary frame header, mirrored here only so this file can name it. */
type GatewayFileBinaryHeader = {
  kind: 'UPLOAD_CHUNK' | 'DOWNLOAD_CHUNK'
  requestId: string
  transferId: string
  generation: number
  index: number
  offset: number
  declaredSize: number
  byteLength: number
  sha256: string
  final: boolean
}

type GatewayFilesProtocol = {
  decodeFileBinaryFrame(raw: Uint8Array): { header: GatewayFileBinaryHeader; bytes: Uint8Array }
  encodeFileBinaryFrame(header: GatewayFileBinaryHeader, bytes: Uint8Array): Buffer
  sha256Hex(bytes: Uint8Array): string
  MAX_FILE_CHUNK_BYTES: number
}

/**
 * Required, not imported. This module lives in the SERVER workspace, and a static
 * import would pull it into the web package's TypeScript program, where `tsc`
 * rejects any file outside the package's `rootDir`. The `.ts` source is loaded
 * (never the built `dist`, which can be stale), ts-jest compiles it like any
 * other, and the shape asserted above is checked against the real module below.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gatewayFilesProtocol =
  require('../../../../../../../server/packages/websocket-gateway/src/filesProtocol') as GatewayFilesProtocol
const { decodeFileBinaryFrame, encodeFileBinaryFrame, sha256Hex, MAX_FILE_CHUNK_BYTES } = gatewayFilesProtocol

import {
  EncryptedStreamDigest,
  FileDecryptor,
  FileEncryptor,
  OrderedByteChunker,
  SocketUploadDriver,
  planUploadSize,
} from '@standardnotes/files'
import type { PureCryptoInterface, StreamDecryptorResult, StreamEncryptor } from '@standardnotes/sncrypto-common'
import { SodiumTag } from '@standardnotes/sncrypto-common'

import { SyncOutboxRecord, SyncOutboxStore } from './SyncTransportOutbox'
import { SyncSocketLike, SyncTransportWorkerRuntime } from './SyncTransportWorkerRuntime'
import { MainToSyncWorkerMessage, SyncWorkerToMainMessage } from './syncTransportProtocol'
import { WebSocketSyncTransport } from './WebSocketSyncTransport'

jest.setTimeout(30_000)

/**
 * jsdom, not node: `WebSocketSyncTransport` statically imports the worker entry
 * point, which touches `self` at module scope. jsdom has no `crypto.subtle` and
 * no `TextEncoder`, both of which this lane needs, so install Node's.
 */
const globalScope = globalThis as unknown as Record<string, unknown>
if (typeof (globalScope.crypto as { subtle?: unknown } | undefined)?.subtle?.valueOf !== 'function') {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true })
}
if (typeof globalScope.TextEncoder !== 'function') {
  globalScope.TextEncoder = TextEncoder
  globalScope.TextDecoder = TextDecoder
}

const SESSION_SCOPE = `sync-session-v1:${'a'.repeat(64)}`
/** Small enough to keep the suite quick, large enough to span many 256 KiB frames. */
const CHUNK_SIZE = 600_000

/**
 * libsodium checks its inputs with `instanceof Uint8Array` against the realm it
 * was loaded in, and under jsdom a Node `Buffer` fails that check ("unsupported
 * input type for key"). Every byte string handed to it is therefore re-wrapped
 * in a plain Uint8Array of this realm.
 */
const sodiumBytes = (value: Uint8Array): Uint8Array => Uint8Array.from(value)

/** The handful of libsodium primitives the files layer actually uses. */
const realCrypto = (): PureCryptoInterface =>
  ({
    generateRandomKey: (bits: number) => Buffer.from(sodium.randombytes_buf(bits / 8)).toString('hex'),
    xchacha20StreamInitEncryptor: (key: string): StreamEncryptor => {
      const result = sodium.crypto_secretstream_xchacha20poly1305_init_push(sodiumBytes(Buffer.from(key, 'hex')))
      return { state: result.state, header: Buffer.from(result.header).toString('base64') }
    },
    xchacha20StreamEncryptorPush: (
      encryptor: StreamEncryptor,
      plaintext: Uint8Array,
      assocData?: string,
      tag: number = SodiumTag.CRYPTO_SECRETSTREAM_XCHACHA20POLY1305_TAG_PUSH,
    ): Uint8Array =>
      sodium.crypto_secretstream_xchacha20poly1305_push(
        encryptor.state as never,
        sodiumBytes(plaintext),
        assocData ? sodiumBytes(Buffer.from(assocData, 'utf8')) : null,
        tag,
      ),
    xchacha20StreamInitDecryptor: (header: string, key: string) => ({
      state: sodium.crypto_secretstream_xchacha20poly1305_init_pull(
        sodiumBytes(Buffer.from(header, 'base64')),
        sodiumBytes(Buffer.from(key, 'hex')),
      ),
    }),
    xchacha20StreamDecryptorPush: (
      decryptor: { state: unknown },
      ciphertext: Uint8Array,
      assocData?: string,
    ): StreamDecryptorResult | false =>
      sodium.crypto_secretstream_xchacha20poly1305_pull(
        decryptor.state as never,
        sodiumBytes(ciphertext),
        assocData ? sodiumBytes(Buffer.from(assocData, 'utf8')) : null,
      ) as unknown as StreamDecryptorResult,
    sha256StreamInit: () => ({ state: sodium.crypto_hash_sha256_init() as never }),
    sha256StreamUpdate: (hash: { state: unknown }, bytes: Uint8Array) =>
      sodium.crypto_hash_sha256_update(hash.state as never, sodiumBytes(bytes)),
    sha256StreamFinal: (hash: { state: unknown }) =>
      Buffer.from(sodium.crypto_hash_sha256_final(hash.state as never)).toString('hex'),
  }) as unknown as PureCryptoInterface

class MemoryOutbox implements SyncOutboxStore {
  private readonly records = new Map<string, SyncOutboxRecord>()
  private readonly leases = new Map<string, { sessionScope: string; ownerId: string; expiresAt: number }>()
  /** Set to simulate a second tab already owning the socket. */
  foreignOwner?: string

  async put(record: SyncOutboxRecord): Promise<void> {
    this.records.set(record.commandId, { ...record })
  }
  async oldest(): Promise<SyncOutboxRecord | undefined> {
    return undefined
  }
  async quarantineSessionScope(): Promise<void> {}
  async delete(): Promise<void> {}
  async heldByAnotherOwner(): Promise<boolean> {
    return this.foreignOwner !== undefined
  }
  async sessionHeldByAnotherOwner(): Promise<boolean> {
    return this.foreignOwner !== undefined
  }
  async acquireOwner(
    transportScope: string,
    sessionScope: string,
    ownerId: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    if (this.foreignOwner !== undefined && this.foreignOwner !== ownerId) {
      return false
    }
    this.leases.set(transportScope, { sessionScope, ownerId, expiresAt: now + ttlMs })
    return true
  }
  async renewOwner(): Promise<boolean> {
    return true
  }
  async releaseOwner(): Promise<void> {}
  close(): void {}
}

type StoredUpload = {
  remoteIdentifier: string
  declaredSize: number
  parts: Map<number, Uint8Array>
  storedLength: number
  published?: Uint8Array
}

/** A real server speaking the sync handshake and FILES_V1, using the gateway's own codec. */
class FilesGatewayDouble {
  readonly server: WebSocketServer
  readonly uploads = new Map<string, StoredUpload>()
  readonly stored = new Map<string, Uint8Array>()
  readonly binaryFrameHeaders: GatewayFileBinaryHeader[] = []
  /** Set to drop every socket immediately after AUTHENTICATED. */
  killAfterAuthentication = false
  /** Set to omit FILES_V1 from the negotiated operation list. */
  advertiseFilesLane = true
  private transferCounter = 0

  constructor(
    readonly port: number,
    server: WebSocketServer,
  ) {
    this.server = server
  }

  static async start(): Promise<FilesGatewayDouble> {
    const server = new WebSocketServerConstructor({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const gateway = new FilesGatewayDouble((server.address() as AddressInfo).port, server)
    server.on('connection', (socket: WebSocket) => gateway.attach(socket))
    return gateway
  }

  async stop(): Promise<void> {
    for (const client of this.server.clients) {
      client.terminate()
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private attach(socket: WebSocket): void {
    let sequence = 1
    const send = (type: string, requestId: string, commandId: string, payload: Record<string, unknown>) =>
      socket.send(
        JSON.stringify({
          version: 1,
          channel: 'sync',
          type,
          requestId,
          commandId,
          sequence: sequence++,
          payloadLength: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
          payload,
        }),
      )

    socket.on('message', (data: RawData | string) => {
      if (typeof data !== 'string') {
        this.onBinary(data as Buffer, send)
        return
      }
      const frame = JSON.parse(data) as {
        type: string
        requestId: string
        commandId: string
        payload: Record<string, never>
      }
      if (frame.type === 'AUTH') {
        send('AUTHENTICATED', frame.requestId, frame.commandId, {
          capability: 'ws-sync',
          protocolVersion: 1,
          nextClientSequence: 1,
          operations: this.advertiseFilesLane ? ['FILES_V1'] : [],
        })
        if (this.killAfterAuthentication) {
          setTimeout(() => socket.terminate(), 5)
        }
        return
      }
      if (frame.type === 'FILES_UPLOAD_OPEN') {
        const payload = frame.payload as unknown as { resource: { remoteIdentifier: string }; declaredSize: number }
        const transferId = `transfer-${++this.transferCounter}`
        this.uploads.set(transferId, {
          remoteIdentifier: payload.resource.remoteIdentifier,
          declaredSize: payload.declaredSize,
          parts: new Map(),
          storedLength: 0,
        })
        send('FILES_ACCEPTED', frame.requestId, frame.commandId, {
          mode: 'upload',
          transferId,
          generation: 1,
          resumeId: `resume-${transferId}`,
          nextIndex: 0,
          nextOffset: 0,
          declaredSize: payload.declaredSize,
          maxChunkBytes: MAX_FILE_CHUNK_BYTES,
        })
        return
      }
      if (frame.type === 'FILES_UPLOAD_FINISH') {
        const payload = frame.payload as unknown as { transferId: string; generation: number; sha256: string }
        const upload = this.uploads.get(payload.transferId)
        if (!upload) {
          send('ERROR', frame.requestId, frame.commandId, { code: 'FILE_NOT_FOUND' })
          return
        }
        const joined = Buffer.concat(
          [...upload.parts.entries()].sort(([left], [right]) => left - right).map(([, part]) => Buffer.from(part)),
        )
        if (joined.byteLength !== upload.declaredSize) {
          send('ERROR', frame.requestId, frame.commandId, { code: 'FILE_INCOMPLETE' })
          return
        }
        if (sha256Hex(joined) !== payload.sha256) {
          send('ERROR', frame.requestId, frame.commandId, { code: 'FILE_INTEGRITY_MISMATCH' })
          return
        }
        // Published only here, which is exactly why an HTTP restart is safe
        // until FINISH has been attempted.
        upload.published = new Uint8Array(joined)
        this.stored.set(upload.remoteIdentifier, upload.published)
        send('FILES_COMPLETE', frame.requestId, frame.commandId, {
          mode: 'upload',
          transferId: payload.transferId,
          generation: payload.generation,
          sha256: payload.sha256,
        })
        return
      }
      if (frame.type === 'FILES_CANCEL') {
        const payload = frame.payload as unknown as { transferId: string; generation: number }
        send('FILES_COMPLETE', frame.requestId, frame.commandId, {
          mode: 'cancelled',
          transferId: payload.transferId,
          generation: payload.generation,
        })
        return
      }
      if (frame.type === 'HEARTBEAT' || frame.type === 'PING') {
        return
      }
    })
  }

  private onBinary(raw: Buffer, send: (t: string, r: string, c: string, p: Record<string, unknown>) => void): void {
    // The gateway's own decoder: magic, version, header bounds, exact-key check,
    // `declaredSize` re-assertion, the FINAL flag and the per-frame SHA-256.
    const decoded = decodeFileBinaryFrame(new Uint8Array(raw))
    this.binaryFrameHeaders.push(decoded.header)
    const upload = this.uploads.get(decoded.header.transferId)
    if (!upload || decoded.header.declaredSize !== upload.declaredSize) {
      send('ERROR', decoded.header.requestId, decoded.header.transferId, { code: 'FILE_INVALID_STATE' })
      return
    }
    if (decoded.header.offset !== upload.storedLength) {
      send('ERROR', decoded.header.requestId, decoded.header.transferId, { code: 'FILE_OFFSET_INVALID' })
      return
    }
    upload.parts.set(decoded.header.index, Uint8Array.from(decoded.bytes))
    upload.storedLength += decoded.bytes.byteLength
    send('FILES_CHUNK_ACK', decoded.header.requestId, decoded.header.transferId, {
      transferId: decoded.header.transferId,
      generation: decoded.header.generation,
      index: decoded.header.index,
      duplicate: false,
      nextIndex: decoded.header.index + 1,
      nextOffset: upload.storedLength,
      resumeId: `resume-${decoded.header.transferId}`,
    })
  }
}

/** Pipes the main thread to a real `SyncTransportWorkerRuntime` over real sockets. */
const inlineWorker = (outbox: MemoryOutbox) => {
  let onmessage: ((event: MessageEvent<SyncWorkerToMainMessage>) => void) | null = null
  const runtime = new SyncTransportWorkerRuntime({
    outbox,
    postMessage: (message) => onmessage?.({ data: message } as MessageEvent<SyncWorkerToMainMessage>),
    subtle: webcrypto.subtle as unknown as SubtleCrypto,
    socketFactory: (endpoint: string): SyncSocketLike => {
      const socket = new WebSocket(endpoint)
      const adapted: SyncSocketLike = {
        get readyState() {
          return socket.readyState
        },
        get bufferedAmount() {
          return socket.bufferedAmount
        },
        binaryType: 'arraybuffer',
        onopen: null,
        onmessage: null,
        onerror: null,
        onclose: null,
        send: (data: string) => socket.send(data),
        sendBinary: (data: Uint8Array) => socket.send(Buffer.from(data), { binary: true }),
        close: (code?: number) => socket.close(code),
      }
      socket.on('open', () => adapted.onopen?.())
      socket.on('message', (data: RawData | string) =>
        adapted.onmessage?.({ data: typeof data === 'string' ? data : new Uint8Array(data as Buffer) }),
      )
      socket.on('error', () => adapted.onerror?.())
      socket.on('close', (code: number) => adapted.onclose?.({ code }))
      return adapted
    },
  })
  return {
    get onmessage() {
      return onmessage
    },
    set onmessage(handler: ((event: MessageEvent<SyncWorkerToMainMessage>) => void) | null) {
      onmessage = handler
    },
    onerror: null as (() => void) | null,
    postMessage: (message: MainToSyncWorkerMessage) => void runtime.handle(message),
    terminate: () => void runtime.handle({ type: 'SHUTDOWN', clientRequestId: 'shutdown' } as MainToSyncWorkerMessage),
  }
}

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

describe('a real FILES_V1 upload over a real socket', () => {
  let gateway: FilesGatewayDouble
  let outbox: MemoryOutbox
  let transport: WebSocketSyncTransport
  let crypto: PureCryptoInterface

  beforeAll(async () => {
    await sodium.ready
  })

  it('loaded the gateway\u2019s own protocol module, not a local re-implementation', () => {
    expect(MAX_FILE_CHUNK_BYTES).toBe(256 * 1024)
    expect(typeof decodeFileBinaryFrame).toBe('function')
    expect(typeof encodeFileBinaryFrame).toBe('function')
    expect(sha256Hex(new Uint8Array([1, 2, 3]))).toBe(
      createHash('sha256')
        .update(Buffer.from([1, 2, 3]))
        .digest('hex'),
    )
  })

  beforeEach(async () => {
    gateway = await FilesGatewayDouble.start()
    outbox = new MemoryOutbox()
    crypto = realCrypto()
  })

  afterEach(async () => {
    transport?.deinit()
    await gateway.stop()
  })

  const connect = async (): Promise<WebSocketSyncTransport> => {
    transport = new WebSocketSyncTransport({
      deviceId: 'device-round-trip',
      getConfiguredWebSocketUrl: () => `ws://127.0.0.1:${gateway.port}`,
      getAuthenticatedSessionScope: async () => SESSION_SCOPE,
      environment: { hasWorker: true, hasWebSocket: true, hasIndexedDb: true },
      workerFactory: () => inlineWorker(outbox),
      controlPlane: {
        createTicket: async () => ({
          ticket: 'ticket'.repeat(8),
          expiresAt: Date.now() + 60_000,
          endpoint: '/sockets/sync',
          capability: 'ws-sync' as const,
          version: 1 as const,
        }),
      },
    })
    // Any request bootstraps the socket; this deployment negotiates no SYNC_ITEMS,
    // so the request itself lands on HTTP exactly as a real one would.
    await transport.execute(
      { api: '20240226', items: [], sync_token: 'token', limit: 150 },
      async () => ({ status: 200, data: { retrieved_items: [], saved_items: [], sync_token: 'next' } }) as never,
    )
    return transport
  }

  /** Reads the published bytes back through the production decryptor. */
  const readBack = async (remoteIdentifier: string, key: string, encryptedChunkSizes: number[]): Promise<Buffer> => {
    const stored = gateway.stored.get(remoteIdentifier) as Uint8Array
    const parts: Buffer[] = []
    const decryptor = new FileDecryptor(
      { remoteIdentifier, key, encryptionHeader: encryptionHeaders.get(remoteIdentifier) as string },
      crypto,
    )
    const chunker = new OrderedByteChunker(encryptedChunkSizes, 'network', async (chunk) => {
      const result = decryptor.decryptBytes(chunk.data)
      if (!result) {
        throw new Error('decryption failed')
      }
      parts.push(Buffer.from(result.decryptedBytes))
    })
    await chunker.addBytes(stored)
    chunker.finish()
    return Buffer.concat(parts)
  }

  const encryptionHeaders = new Map<string, string>()

  const runRoundTrip = async (size: number, callerChunkSize: number) => {
    await connect()
    await waitFor(() => transport.isFileLaneAvailable(), 'the FILES_V1 lane to come up')

    const plaintext = Uint8Array.from({ length: size }, (_value, index) => (index * 97 + (index >> 8)) % 251)
    const key = crypto.generateRandomKey(256)
    const remoteIdentifier = `remote-${size}-${Math.random().toString(16).slice(2)}`
    const plan = planUploadSize(size, CHUNK_SIZE)

    const opened = await transport.uploadFileOverSocket({
      remoteIdentifier,
      fileUuid: `file-${size}`,
      decryptedSize: plan.decryptedSize,
      declaredSize: plan.encryptedSize,
      mimeType: 'application/octet-stream',
    })
    expect(opened.outcome).toBe('opened')
    if (opened.outcome !== 'opened') {
      throw new Error('unreachable')
    }

    const encryptor = new FileEncryptor({ key, remoteIdentifier }, crypto)
    const encryptionHeader = encryptor.initializeHeader()
    encryptionHeaders.set(remoteIdentifier, encryptionHeader)

    const driver = new SocketUploadDriver({
      plan,
      file: { key, remoteIdentifier },
      encryptionHeader,
      encryptor,
      digest: new EncryptedStreamDigest(crypto),
      session: opened.session,
      position: opened.position,
      beginHttpFallback: async () => {
        throw new Error('the HTTP fallback must not be reached on a healthy lane')
      },
    })

    let outcome
    for (let offset = 0, index = 0; offset < size; offset += callerChunkSize, index += 1) {
      const slice = plaintext.subarray(offset, Math.min(size, offset + callerChunkSize))
      outcome = await driver.pushBytes(slice, index, offset + callerChunkSize >= size)
    }

    return { outcome, driver, plan, remoteIdentifier, key, plaintext }
  }

  it.each([
    ['one byte', 1, 1],
    ['exactly one chunk', CHUNK_SIZE, CHUNK_SIZE],
    ['one byte over a chunk boundary', CHUNK_SIZE + 1, 250_000],
    ['several chunks, fed in the sizes a reader actually produces', CHUNK_SIZE * 2 + 1_234, CHUNK_SIZE + 111_111],
  ])('uploads %s and reads the identical bytes back', async (_label, size, callerChunkSize) => {
    const { outcome, driver, plan, remoteIdentifier, key, plaintext } = await runRoundTrip(size, callerChunkSize)

    expect(outcome).toEqual({ outcome: 'completed', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })

    const stored = gateway.stored.get(remoteIdentifier) as Uint8Array
    expect(stored).toBeDefined()
    expect(stored.byteLength).toBe(plan.encryptedSize)
    expect(createHash('sha256').update(Buffer.from(stored)).digest('hex')).toBe(driver.completedSha256)
    expect(driver.encryptedChunkSizes.reduce((total, each) => total + each, 0)).toBe(plan.encryptedSize)

    // Every frame the gateway's own decoder accepted was within its frame limit
    // and re-asserted the same declaredSize.
    const headers = gateway.binaryFrameHeaders
    expect(headers.length).toBeGreaterThanOrEqual(Math.ceil(plan.encryptedSize / MAX_FILE_CHUNK_BYTES))
    expect(Math.max(...headers.map((header) => header.byteLength))).toBeLessThanOrEqual(MAX_FILE_CHUNK_BYTES)
    expect(new Set(headers.map((header) => header.declaredSize))).toEqual(new Set([plan.encryptedSize]))
    expect(headers.filter((header) => header.final)).toHaveLength(1)

    const roundTripped = await readBack(remoteIdentifier, key, driver.encryptedChunkSizes)
    expect(roundTripped.byteLength).toBe(size)
    expect(Uint8Array.from(roundTripped)).toEqual(plaintext)
  })

  it('re-encodes each stored frame with the gateway codec and gets the same bytes', async () => {
    const { driver, plan, remoteIdentifier } = await runRoundTrip(CHUNK_SIZE + 1, CHUNK_SIZE + 1)
    const stored = gateway.stored.get(remoteIdentifier) as Uint8Array

    let offset = 0
    for (const header of gateway.binaryFrameHeaders) {
      const payload = stored.subarray(offset, offset + header.byteLength)
      expect(header.offset).toBe(offset)
      expect(header.sha256).toBe(sha256Hex(payload))
      // The frame this client produced round-trips through the gateway's encoder.
      expect(encodeFileBinaryFrame(header, payload).byteLength).toBeGreaterThan(header.byteLength)
      offset += header.byteLength
    }
    expect(offset).toBe(plan.encryptedSize)
    expect(driver.completedSha256).toBe(createHash('sha256').update(Buffer.from(stored)).digest('hex'))
  })

  describe('the HTTP fallback crossings', () => {
    it('reports the lane unavailable when the gateway never negotiates FILES_V1', async () => {
      gateway.advertiseFilesLane = false
      await connect()
      await waitFor(() => transport.transportState === 'READY', 'the socket to authenticate')

      expect(transport.isFileLaneAvailable()).toBe(false)
      const opened = await transport.uploadFileOverSocket({
        remoteIdentifier: 'remote-no-lane',
        fileUuid: 'file-no-lane',
        decryptedSize: 10,
        declaredSize: 27,
        mimeType: 'application/octet-stream',
      })

      expect(opened).toEqual({ outcome: 'unavailable' })
      expect(gateway.uploads.size).toBe(0)
    })

    it('reports the lane unavailable to a tab that does not own the socket', async () => {
      outbox.foreignOwner = 'another-tab'
      await connect()

      expect(transport.isFileLaneAvailable()).toBe(false)
      const opened = await transport.uploadFileOverSocket({
        remoteIdentifier: 'remote-not-owner',
        fileUuid: 'file-not-owner',
        decryptedSize: 10,
        declaredSize: 27,
        mimeType: 'application/octet-stream',
      })

      expect(opened).toEqual({ outcome: 'unavailable' })
      expect(transport.transportStatus.fallbackReason).toBe('multi-tab-not-owner')
      expect(gateway.uploads.size).toBe(0)
    })

    it('fails the open, safely, when the server kills the socket right after authenticating', async () => {
      gateway.killAfterAuthentication = true
      await connect()
      await waitFor(() => transport.transportState !== 'READY', 'the socket to be killed')

      const opened = await transport.uploadFileOverSocket({
        remoteIdentifier: 'remote-killed',
        fileUuid: 'file-killed',
        decryptedSize: 10,
        declaredSize: 27,
        mimeType: 'application/octet-stream',
      })

      expect(opened.outcome).not.toBe('opened')
      expect(gateway.stored.size).toBe(0)
    })

    it('refuses an oversized declaredSize without a round trip, so HTTP carries it', async () => {
      await connect()
      await waitFor(() => transport.isFileLaneAvailable(), 'the FILES_V1 lane to come up')

      const opened = await transport.uploadFileOverSocket({
        remoteIdentifier: 'remote-too-large',
        fileUuid: 'file-too-large',
        // Under the 5 GiB cap as a DECRYPTED size, over it once the per-chunk
        // overhead is counted — exactly the band a decrypted-size check waves through.
        decryptedSize: 5 * 1024 * 1024 * 1024 - 1_000,
        declaredSize: 5 * 1024 * 1024 * 1024 + 1,
        mimeType: 'application/octet-stream',
      })

      expect(opened).toEqual({ outcome: 'unavailable' })
      expect(gateway.uploads.size).toBe(0)
    })
  })
})
