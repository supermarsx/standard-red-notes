import { describe, expect, it, vi } from 'vitest'

import { InMemorySyncAuthTicketStore } from '../src/auth.js'
import { InMemorySyncCommandLeaseRegistry, InMemorySyncSocketBudget } from '../src/registry.js'
import {
  SyncCommandHandler,
  type SyncApiRpcAdapter,
  type SyncCommandBackendAdapter,
  type SyncCommandHandlerOptions,
  type SyncInviteEventsAdapter,
  type SyncLiveAuthorizationAdapter,
  type SyncSocket,
} from '../src/syncCommandHandler.js'
import type { SyncFilesAdapter } from '../src/filesSession.js'
import type { FileResourceReference } from '../src/filesProtocol.js'
import { syncPayloadLength, digestSyncCommandBody, type JsonObject } from '../src/syncProtocol.js'

/**
 * Standard Red Notes: the two server-side halves of the websocket audit that
 * live inside `SyncCommandHandler` --
 *
 *   ITEM 4, one serial promise chain. Every frame used to be appended to a
 *   single chain, so a `SYNC_ITEMS` command waiting out its backend timeout
 *   held `PING`, `REAUTH`, `INVITE_ACK`, `RPC_CREDIT` and `FILES_CREDIT`
 *   behind it. The `PING` was the one that bites: the gateway's heartbeat sweep
 *   `terminate()`s a socket that has not answered since the previous sweep and
 *   a terminate sends no close frame, so a slow BACKEND could cause the 1006
 *   disconnect its own client was waiting through -- and the answer died with
 *   the socket.
 *
 *   ITEM 2, a lane with no credential. `INVITE_SUBSCRIBE` never called
 *   `authorize`, and nothing in this package ever revalidated a live socket or
 *   bounded its lifetime, so a signed-out or revoked session kept streaming
 *   invite invalidations and kept one of its user's socket-budget slots.
 *
 * WHY THESE ARE HANDLER-LEVEL AND NOT SOCKET-LEVEL. An in-process socket
 * harness could not be made to hold an ingress queue depth above ONE even with
 * a 250 ms stall injected -- the loopback drains faster than frames can be
 * stacked -- so a socket-driven version of these would assert nothing about
 * concurrency. Every case below drives `enqueue` directly and gates the backend
 * on a promise the test owns, so "did B have to wait for A?" is decided by the
 * code rather than by a timing race.
 *
 * EVERY ORDERING CASE IS POSITIVE. "No error frame arrived" is the shape of
 * predicate that passes over a lane that is simply dead, so each ordering test
 * asserts that the second frame's effect HAPPENS, and happens only after the
 * first frame's effect, rather than that nothing went wrong.
 */

class FakeSocket implements SyncSocket {
  bufferedAmount = 0
  readonly frames: JsonObject[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') {
      this.frames.push(JSON.parse(data) as JsonObject)
    }
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
  }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const FILE_RESOURCE: FileResourceReference = {
  ownershipType: 'shared-vault',
  remoteIdentifier: 'remote-1',
  fileUuid: 'file-1',
  sharedVaultUuid: 'vault-1',
  sharedVaultOwnerUuid: 'owner-1',
}

function frame(type: string, sequence: number, payload: JsonObject, extra: JsonObject = {}): JsonObject {
  return {
    version: 1,
    channel: 'sync',
    type,
    requestId: `${type.toLowerCase()}-${sequence}`,
    commandId: `${type.toLowerCase()}-${sequence}`,
    sequence,
    payloadLength: syncPayloadLength(payload),
    payload,
    ...extra,
  }
}

function commandFrame(commandId: string, sequence: number): JsonObject {
  const body = { api: '20200115', items: [] }
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

function enqueue(handler: SyncCommandHandler, raw: JsonObject): void {
  const text = JSON.stringify(raw)
  handler.enqueue(text, Buffer.byteLength(text))
}

/** A backend whose `execute` blocks until the test releases it, recording its signal. */
function stallingBackend(): {
  backend: SyncCommandBackendAdapter
  release: () => void
  started: () => number
  signals: AbortSignal[]
} {
  const gate = deferred()
  const signals: AbortSignal[] = []
  let starts = 0
  const backend: SyncCommandBackendAdapter = {
    ready: () => true,
    execute: vi.fn<SyncCommandBackendAdapter['execute']>(async (input, signal) => {
      starts += 1
      signals.push(signal)
      await gate.promise
      return { digest: input.digest, payload: { saved: true } }
    }),
    status: vi.fn<SyncCommandBackendAdapter['status']>(async (input) => ({
      status: 'COMMITTED',
      digest: input.digest,
      payload: { saved: true },
    })),
  }
  return { backend, release: gate.resolve, started: () => starts, signals }
}

function allowAuthorization(
  overrides: Partial<SyncLiveAuthorizationAdapter> = {},
): SyncLiveAuthorizationAdapter & { authorize: ReturnType<typeof vi.fn> } {
  return {
    ready: () => true,
    authorize: vi.fn<SyncLiveAuthorizationAdapter['authorize']>(async () => ({ authorized: true })),
    ...overrides,
  } as SyncLiveAuthorizationAdapter & { authorize: ReturnType<typeof vi.fn> }
}

function filesAdapter(overrides: Partial<SyncFilesAdapter> = {}): SyncFilesAdapter {
  return {
    ready: vi.fn(() => true),
    metadata: vi.fn(async () => []),
    openUpload: vi.fn(async () => ({
      transferId: 'upload-1',
      generation: 1,
      resumeId: 'upload-resume-1',
      nextIndex: 0,
      nextOffset: 0,
      declaredSize: 3,
    })),
    uploadChunk: vi.fn(async () => ({ duplicate: false, nextIndex: 1, nextOffset: 3, resumeId: 'upload-resume-1' })),
    finishUpload: vi.fn(async ({ sha256 }) => ({ sha256 })),
    openDownload: vi.fn(async () => ({
      transferId: 'download-1',
      generation: 4,
      resumeId: 'download-resume-1',
      declaredSize: 6,
      nextIndex: 0,
      nextOffset: 0,
    })),
    readDownloadChunk: vi.fn(async () => ({
      index: 0,
      offset: 0,
      declaredSize: 6,
      bytes: new Uint8Array([1, 2, 3]),
      final: true,
    })),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  }
}

function inviteAdapter(overrides: Partial<SyncInviteEventsAdapter> = {}): SyncInviteEventsAdapter {
  return {
    distribution: 'shared',
    ready: () => true,
    tail: vi.fn(async () => 'cursor-0'),
    readAfter: vi.fn(async (_userUuid: string, cursor: string) => ({
      previousCursor: cursor,
      events: [],
      nextCursor: cursor,
      hasMore: false,
    })),
    subscribeAvailability: vi.fn(() => () => undefined),
    ...overrides,
  }
}

async function authenticated(
  options: Omit<Partial<SyncCommandHandlerOptions>, 'tickets' | 'socket'> & {
    tickets?: InMemorySyncAuthTicketStore
    socket?: FakeSocket
  } = {},
): Promise<{
  handler: SyncCommandHandler
  socket: FakeSocket
  tickets: InMemorySyncAuthTicketStore
}> {
  const tickets = options.tickets ?? new InMemorySyncAuthTicketStore()
  const socket = options.socket ?? new FakeSocket()
  const issued = await tickets.issue({
    userUuid: 'user-1',
    sessionUuid: 'session-1',
    deviceId: 'device-1',
    authorization: 'Bearer session-token',
  })
  const handler = new SyncCommandHandler({
    ownerId: `owner-${Math.random()}`,
    leases: new InMemorySyncCommandLeaseRegistry(),
    socketBudget: new InMemorySyncSocketBudget(),
    authorization: allowAuthorization(),
    backend: stallingBackend().backend,
    isEnabled: () => true,
    backendTimeoutMs: 10_000,
    ...options,
    socket,
    tickets,
  })
  const auth = { ticket: issued.ticket, deviceId: 'device-1' }
  enqueue(handler, frame('AUTH', 0, auth))
  await vi.waitFor(() => expect(socket.frames.at(-1)?.type).toBe('AUTHENTICATED'))
  return { handler, socket, tickets }
}

const framesOfType = (socket: FakeSocket, type: string): JsonObject[] =>
  socket.frames.filter((candidate) => candidate.type === type)

const errorCodes = (socket: FakeSocket): unknown[] =>
  framesOfType(socket, 'ERROR').map((candidate) => (candidate.payload as JsonObject).code)

describe('sync frame lanes', () => {
  it('answers a PING while a durable command is still executing', async () => {
    const { backend, release, started } = stallingBackend()
    const { handler, socket } = await authenticated({ backend })

    enqueue(handler, commandFrame('command-1', 1))
    await vi.waitFor(() => expect(started()).toBe(1))
    enqueue(handler, frame('PING', 2, {}))

    // THE proof for item 4. With one serial chain this PONG could not be
    // written until the command below had finished, and the heartbeat sweep
    // terminates a socket that has not answered since the previous sweep.
    await vi.waitFor(() => expect(framesOfType(socket, 'PONG')).toHaveLength(1))
    expect(framesOfType(socket, 'COMMITTED')).toHaveLength(0)
    expect(socket.closes).toHaveLength(0)

    release()
    await vi.waitFor(() => expect(framesOfType(socket, 'COMMITTED')).toHaveLength(1))
  })

  it('serves REAUTH, RPC_CREDIT and FILES_CREDIT while a durable command is still executing', async () => {
    const { backend, release, started } = stallingBackend()
    const tickets = new InMemorySyncAuthTicketStore()
    const refreshSession = vi.fn<NonNullable<SyncLiveAuthorizationAdapter['refreshSession']>>(async () => ({
      refreshed: true,
    }))
    const apiRpc: SyncApiRpcAdapter = {
      idempotencyScope: 'shared-durable',
      ready: () => true,
      operations: () => ['API_RPC'],
      execute: vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array() })),
    }
    const { handler, socket } = await authenticated({
      backend,
      tickets,
      apiRpc,
      files: filesAdapter(),
      authorization: allowAuthorization({ refreshSession }),
    })
    const refresh = await tickets.issue({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      deviceId: 'device-1',
      authorization: 'Bearer rotated-token',
    })

    enqueue(handler, commandFrame('command-1', 1))
    await vi.waitFor(() => expect(started()).toBe(1))

    enqueue(handler, frame('REAUTH', 2, { ticket: refresh.ticket, deviceId: 'device-1' }))
    enqueue(handler, frame('RPC_CREDIT', 3, { targetRequestId: 'nothing-live', creditBytes: 1024 }))
    enqueue(handler, frame('FILES_CREDIT', 4, { transferId: 'download-1', generation: 4, creditBytes: 1024 }))

    // Each of the three lands its own answer with the command still in flight:
    // the credential lane adopts, the rpc lane names an unknown request, and
    // the files lane names a transfer that was never opened.
    await vi.waitFor(() => expect(framesOfType(socket, 'REAUTHENTICATED')).toHaveLength(1))
    await vi.waitFor(() => expect(errorCodes(socket)).toEqual(['UNKNOWN_REQUEST', 'FILE_STALE_GENERATION']))
    expect(framesOfType(socket, 'COMMITTED')).toHaveLength(0)
    expect(refreshSession).toHaveBeenCalledTimes(1)

    release()
    await vi.waitFor(() => expect(framesOfType(socket, 'COMMITTED')).toHaveLength(1))
  })

  it('keeps two durable commands ordered, so the second never finds its own lease held', async () => {
    const gates = [deferred(), deferred()]
    const order: string[] = []
    const backend: SyncCommandBackendAdapter = {
      ready: () => true,
      execute: vi.fn<SyncCommandBackendAdapter['execute']>(async (input) => {
        order.push(input.commandId)
        await gates[order.length - 1]!.promise
        return { digest: input.digest, payload: {} }
      }),
      status: vi.fn<SyncCommandBackendAdapter['status']>(async (input) => ({
        status: 'COMMITTED',
        digest: input.digest,
      })),
    }
    const { handler, socket } = await authenticated({ backend })

    enqueue(handler, commandFrame('command-1', 1))
    enqueue(handler, commandFrame('command-2', 2))
    await vi.waitFor(() => expect(order).toEqual(['command-1']))

    // The second command has NOT entered the backend: the durable lane is one
    // lane precisely because a command holds a fleet-shared lease per
    // (user, device). Were it concurrent it would be refused BUSY here.
    gates[0]!.resolve()
    await vi.waitFor(() => expect(order).toEqual(['command-1', 'command-2']))
    gates[1]!.resolve()
    await vi.waitFor(() => expect(framesOfType(socket, 'COMMITTED')).toHaveLength(2))
    expect(errorCodes(socket)).toEqual([])
  })

  it('keeps a STATUS behind the command it may be asking about', async () => {
    const { backend, release, started } = stallingBackend()
    const { handler } = await authenticated({ backend })
    const digest = digestSyncCommandBody({ api: '20200115', items: [] })

    enqueue(handler, commandFrame('command-1', 1))
    await vi.waitFor(() => expect(started()).toBe(1))
    enqueue(handler, frame('STATUS', 2, {}, { digest }))

    // A STATUS on its own lane would race the command it names and answer
    // ACCEPTED for a write that was about to commit.
    await new Promise((settle) => setTimeout(settle, 20))
    expect(backend.status).not.toHaveBeenCalled()

    release()
    await vi.waitFor(() => expect(backend.status).toHaveBeenCalledTimes(1))
  })

  it('keeps a FILES_CREDIT behind the FILES_DOWNLOAD_OPEN that creates its transfer', async () => {
    const open = deferred<void>()
    const chunks = [
      { index: 0, offset: 0, declaredSize: 6, bytes: new Uint8Array([1, 2, 3]), final: false },
      { index: 1, offset: 3, declaredSize: 6, bytes: new Uint8Array([4, 5, 6]), final: true },
    ]
    const files = filesAdapter({
      openDownload: vi.fn(async () => {
        await open.promise
        return {
          transferId: 'download-1',
          generation: 4,
          resumeId: 'download-resume-1',
          declaredSize: 6,
          nextIndex: 0,
          nextOffset: 0,
        }
      }),
      readDownloadChunk: vi.fn(async () => chunks.shift()!),
    })
    const { handler, socket } = await authenticated({ files })

    enqueue(
      handler,
      frame('FILES_DOWNLOAD_OPEN', 1, {
        resource: FILE_RESOURCE,
        offset: 0,
        initialCreditBytes: 3,
        deadlineMs: 5_000,
      }),
    )
    await vi.waitFor(() => expect(files.openDownload).toHaveBeenCalledTimes(1))
    enqueue(handler, frame('FILES_CREDIT', 2, { transferId: 'download-1', generation: 4, creditBytes: 3 }))

    // The open is still in flight, so no transfer exists for the credit to
    // name: `currentDownload` THROWS FILE_STALE_GENERATION for one that does
    // not, which is exactly why this frame may not jump the queue.
    await new Promise((settle) => setTimeout(settle, 20))
    expect(files.readDownloadChunk).not.toHaveBeenCalled()

    open.resolve()
    // Both chunks are read: the first on the open's own initial credit, the
    // second only because the FILES_CREDIT found its transfer and was applied.
    await vi.waitFor(() => expect(files.readDownloadChunk).toHaveBeenCalledTimes(2))
    expect(errorCodes(socket)).toEqual([])
  })

  it('keeps an INVITE_ACK behind the INVITE_SUBSCRIBE whose batch it acknowledges', async () => {
    const firstRead = deferred<void>()
    const reads: string[] = []
    const event = {
      version: 1,
      eventId: '11111111-1111-4111-8111-111111111111',
      streamPosition: 'cursor-1',
      kind: 'subscription-invite',
      action: 'created',
      inviteUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      occurredAt: 1,
    }
    const inviteEvents = inviteAdapter({
      readAfter: vi.fn(async (_userUuid: string, cursor: string) => {
        reads.push(cursor)
        if (reads.length === 1) {
          await firstRead.promise
          return { previousCursor: cursor, events: [event], nextCursor: 'cursor-1', hasMore: false }
        }
        return { previousCursor: cursor, events: [], nextCursor: cursor, hasMore: false }
      }),
    })
    const { handler, socket } = await authenticated({ inviteEvents, requireSharedState: true })

    enqueue(handler, frame('INVITE_SUBSCRIBE', 1, { cursor: 'cursor-0', limit: 1 }))
    await vi.waitFor(() => expect(reads).toEqual(['cursor-0']))
    enqueue(handler, frame('INVITE_ACK', 2, { cursor: 'cursor-1' }))

    // An immediate INVITE_ACK would find no `awaitingAck` yet and CLOSE the
    // socket with INVITE_ACK_INVALID. Sharing the invite lane means it matches.
    firstRead.resolve()
    await vi.waitFor(() => expect(reads).toEqual(['cursor-0', 'cursor-1']))
    expect(socket.closes).toHaveLength(0)
    expect(errorCodes(socket)).toEqual([])
  })

  it('keeps a binary upload chunk behind the FILES_UPLOAD_OPEN that creates its transfer', async () => {
    const open = deferred<void>()
    const files = filesAdapter({
      openUpload: vi.fn(async () => {
        await open.promise
        return {
          transferId: 'upload-1',
          generation: 1,
          resumeId: 'upload-resume-1',
          nextIndex: 0,
          nextOffset: 0,
          declaredSize: 3,
        }
      }),
    })
    const { handler } = await authenticated({ files })
    const { encodeFileBinaryFrame, sha256Hex } = await import('../src/filesProtocol.js')
    const bytes = new Uint8Array([1, 2, 3])

    enqueue(
      handler,
      frame('FILES_UPLOAD_OPEN', 1, {
        resource: FILE_RESOURCE,
        decryptedSize: 3,
        declaredSize: 3,
        mimeType: 'application/octet-stream',
        deadlineMs: 5_000,
      }),
    )
    await vi.waitFor(() => expect(files.openUpload).toHaveBeenCalledTimes(1))
    const chunk = encodeFileBinaryFrame(
      {
        kind: 'UPLOAD_CHUNK',
        requestId: 'files_upload_open-1',
        transferId: 'upload-1',
        generation: 1,
        index: 0,
        offset: 0,
        declaredSize: 3,
        byteLength: 3,
        sha256: sha256Hex(bytes),
        final: true,
      },
      bytes,
    )
    handler.enqueueBinary(chunk, chunk.byteLength)

    await new Promise((settle) => setTimeout(settle, 20))
    expect(files.uploadChunk).not.toHaveBeenCalled()

    open.resolve()
    await vi.waitFor(() => expect(files.uploadChunk).toHaveBeenCalledTimes(1))
  })

  it('aborts every concurrent backend operation on disconnect, not only the most recent one', async () => {
    const { backend, started, signals } = stallingBackend()
    const tickets = new InMemorySyncAuthTicketStore()
    const refreshSignals: AbortSignal[] = []
    const refreshSession = vi.fn<NonNullable<SyncLiveAuthorizationAdapter['refreshSession']>>(
      async (_input, signal) => {
        refreshSignals.push(signal)
        await new Promise(() => undefined)
        return { refreshed: true }
      },
    )
    const { handler } = await authenticated({
      backend,
      tickets,
      authorization: allowAuthorization({ refreshSession }),
    })
    const refresh = await tickets.issue({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      deviceId: 'device-1',
      authorization: 'Bearer rotated-token',
    })

    enqueue(handler, commandFrame('command-1', 1))
    await vi.waitFor(() => expect(started()).toBe(1))
    enqueue(handler, frame('REAUTH', 2, { ticket: refresh.ticket, deviceId: 'device-1' }))
    await vi.waitFor(() => expect(refreshSignals).toHaveLength(1))

    handler.disconnect()

    // The single `activeAbort` slot this replaced held ONE controller, so the
    // REAUTH overwrote the command's and the command then ran to its own
    // backend timeout on a socket that was already gone.
    expect(signals[0]?.aborted).toBe(true)
    expect(refreshSignals[0]?.aborted).toBe(true)
  })

  it('drains a command that is still running on its lane after the gate has advanced', async () => {
    const { backend, release, started } = stallingBackend()
    const { handler, socket } = await authenticated({ backend })

    enqueue(handler, commandFrame('command-1', 1))
    await vi.waitFor(() => expect(started()).toBe(1))
    enqueue(handler, frame('PING', 2, {}))
    await vi.waitFor(() => expect(framesOfType(socket, 'PONG')).toHaveLength(1))

    let drained = false
    const draining = handler.drain().then(() => {
      drained = true
    })
    await new Promise((settle) => setTimeout(settle, 20))
    // R1: a command already accepted is finished and ANSWERED before its socket
    // closes. The gate advanced two frames ago; only the outstanding-frame set
    // still knows this command exists.
    expect(drained).toBe(false)

    release()
    await draining
    expect(drained).toBe(true)
    expect(framesOfType(socket, 'COMMITTED')).toHaveLength(1)
  })
})

describe('invite subscription credentials', () => {
  it('presents the session credential on INVITE_SUBSCRIBE and refuses a revoked one without closing', async () => {
    const authorization = allowAuthorization({
      authorize: vi.fn<SyncLiveAuthorizationAdapter['authorize']>(async (input) =>
        input.operation === 'INVITE_EVENTS' ? { authorized: false, code: 'SESSION_REVOKED' } : { authorized: true },
      ),
    })
    const inviteEvents = inviteAdapter()
    const { handler, socket } = await authenticated({ inviteEvents, requireSharedState: true, authorization })

    enqueue(handler, frame('INVITE_SUBSCRIBE', 1, { cursor: 'cursor-0', limit: 1 }))
    await vi.waitFor(() => expect(errorCodes(socket)).toEqual(['NOT_AUTHORIZED']))

    expect(authorization.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'INVITE_EVENTS',
        identity: expect.objectContaining({ userUuid: 'user-1' }),
      }),
      expect.any(AbortSignal),
    )
    // No stream was opened, and the socket survives: a re-ticket is the
    // recovery, and closing would delete it.
    expect(inviteEvents.subscribeAvailability).not.toHaveBeenCalled()
    expect(inviteEvents.readAfter).not.toHaveBeenCalled()
    expect(socket.closes).toHaveLength(0)
  })

  it('reports a stale credential as retryable and a failed authorization as stale', async () => {
    let verdict: 'stale' | 'throw' = 'stale'
    const authorization = allowAuthorization({
      authorize: vi.fn<SyncLiveAuthorizationAdapter['authorize']>(async (input) => {
        if (input.operation !== 'INVITE_EVENTS') {
          return { authorized: true }
        }
        if (verdict === 'throw') {
          throw new Error('session plane unreachable')
        }
        return { authorized: false, code: 'SESSION_STALE' }
      }),
    })
    const { handler, socket } = await authenticated({
      inviteEvents: inviteAdapter(),
      requireSharedState: true,
      authorization,
    })

    enqueue(handler, frame('INVITE_SUBSCRIBE', 1, { cursor: 'cursor-0', limit: 1 }))
    await vi.waitFor(() => expect(errorCodes(socket)).toEqual(['SESSION_STALE']))

    verdict = 'throw'
    enqueue(handler, frame('INVITE_SUBSCRIBE', 2, { cursor: 'cursor-0', limit: 1 }))
    await vi.waitFor(() => expect(errorCodes(socket)).toEqual(['SESSION_STALE', 'SESSION_STALE']))
    expect(socket.closes).toHaveLength(0)
  })

  it('does not tear down a live subscription when a later subscribe is refused', async () => {
    let allow = true
    const unsubscribe = vi.fn()
    const inviteEvents = inviteAdapter({ subscribeAvailability: vi.fn(() => unsubscribe) })
    const authorization = allowAuthorization({
      authorize: vi.fn<SyncLiveAuthorizationAdapter['authorize']>(async (input) =>
        input.operation === 'INVITE_EVENTS' && !allow
          ? { authorized: false, code: 'SESSION_REVOKED' }
          : { authorized: true },
      ),
    })
    const { handler, socket } = await authenticated({ inviteEvents, requireSharedState: true, authorization })

    enqueue(handler, frame('INVITE_SUBSCRIBE', 1, { cursor: 'cursor-0', limit: 1 }))
    await vi.waitFor(() => expect(inviteEvents.subscribeAvailability).toHaveBeenCalledTimes(1))

    allow = false
    enqueue(handler, frame('INVITE_SUBSCRIBE', 2, { cursor: 'cursor-0', limit: 1 }))
    await vi.waitFor(() => expect(errorCodes(socket)).toEqual(['NOT_AUTHORIZED']))

    // `stopInviteSubscription` runs only AFTER the credential is accepted, so a
    // refusal cannot cost the client the subscription it already holds.
    expect(unsubscribe).not.toHaveBeenCalled()
  })
})

describe('live socket session revalidation', () => {
  it('ends a socket whose session was revoked and stops its invite stream', async () => {
    let revoked = false
    const unsubscribe = vi.fn()
    const inviteEvents = inviteAdapter({ subscribeAvailability: vi.fn(() => unsubscribe) })
    const refreshSession = vi.fn<NonNullable<SyncLiveAuthorizationAdapter['refreshSession']>>(async () =>
      revoked ? { refreshed: false, code: 'SESSION_REVOKED' } : { refreshed: true },
    )
    const { handler, socket } = await authenticated({
      inviteEvents,
      requireSharedState: true,
      authorization: allowAuthorization({ refreshSession }),
      sessionRevalidationIntervalMs: 5,
    })

    enqueue(handler, frame('INVITE_SUBSCRIBE', 1, { cursor: 'cursor-0', limit: 1 }))
    await vi.waitFor(() => expect(inviteEvents.subscribeAvailability).toHaveBeenCalledTimes(1))

    // The socket survives a healthy revalidation: this gate has to be able to
    // say yes, or "it closed" proves nothing about what it measured.
    await vi.waitFor(() => expect(refreshSession.mock.calls.length).toBeGreaterThanOrEqual(2))
    expect(socket.closes).toHaveLength(0)
    expect(unsubscribe).not.toHaveBeenCalled()

    revoked = true
    await vi.waitFor(() => expect(socket.closes).toHaveLength(1))
    expect(socket.closes[0]).toEqual({ code: 1008, reason: 'Sync session is no longer authorized.' })
    expect(errorCodes(socket)).toContain('NOT_AUTHORIZED')
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('survives a session plane that cannot answer, and revalidates the credential a REAUTH adopted', async () => {
    const presented: Array<string | undefined> = []
    const tickets = new InMemorySyncAuthTicketStore()
    let outcome: 'error' | 'stale' | 'ok' = 'error'
    const refreshSession = vi.fn<NonNullable<SyncLiveAuthorizationAdapter['refreshSession']>>(async (input) => {
      presented.push(input.identity.authorization)
      if (outcome === 'error') {
        throw new Error('auth unreachable')
      }
      if (outcome === 'stale') {
        return { refreshed: false, code: 'SESSION_STALE' }
      }
      return { refreshed: true }
    })
    const { handler, socket } = await authenticated({
      tickets,
      authorization: allowAuthorization({ refreshSession }),
      sessionRevalidationIntervalMs: 5,
    })

    await vi.waitFor(() => expect(presented.length).toBeGreaterThanOrEqual(1))
    outcome = 'stale'
    await vi.waitFor(() => expect(presented.length).toBeGreaterThanOrEqual(2))
    // Neither an unreachable session plane nor a merely stale verdict may close
    // a working socket -- only a definite revocation does.
    expect(socket.closes).toHaveLength(0)

    outcome = 'ok'
    const refresh = await tickets.issue({
      userUuid: 'user-1',
      sessionUuid: 'session-1',
      deviceId: 'device-1',
      authorization: 'Bearer rotated-token',
    })
    enqueue(handler, frame('REAUTH', 1, { ticket: refresh.ticket, deviceId: 'device-1' }))
    await vi.waitFor(() => expect(framesOfType(socket, 'REAUTHENTICATED')).toHaveLength(1))

    // The credential the socket HOLDS, not the one it was admitted with.
    await vi.waitFor(() => expect(presented.at(-1)).toBe('Bearer rotated-token'))
    handler.disconnect()
  })

  it('bounds the lifetime of a socket whose adapter cannot revalidate at all', async () => {
    const { handler, socket } = await authenticated({
      authorization: {
        ready: () => true,
        authorize: vi.fn<SyncLiveAuthorizationAdapter['authorize']>(async () => ({ authorized: true })),
      },
      sessionRevalidationIntervalMs: 20,
      socketMaxLifetimeMs: 200,
    })

    // No `refreshSession`, so the session can never be re-asked. An unbounded
    // socket is then the only alternative, and that is what the audit found.
    await vi.waitFor(() => expect(socket.closes).toHaveLength(1))
    expect(socket.closes[0]).toEqual({ code: 1013, reason: 'Sync socket lifetime elapsed.' })
    expect(errorCodes(socket)).toContain('SESSION_LIFETIME')
    handler.disconnect()
  })

  it('refuses an unusable revalidation interval at construction', () => {
    const base = {
      socket: new FakeSocket(),
      ownerId: 'owner',
      tickets: new InMemorySyncAuthTicketStore(),
      leases: new InMemorySyncCommandLeaseRegistry(),
      socketBudget: new InMemorySyncSocketBudget(),
      authorization: allowAuthorization(),
      backend: stallingBackend().backend,
      isEnabled: () => true,
    }
    expect(() => new SyncCommandHandler({ ...base, sessionRevalidationIntervalMs: 0 })).toThrow(
      /session revalidation interval/i,
    )
    expect(() => new SyncCommandHandler({ ...base, sessionRevalidationIntervalMs: 1.5 })).toThrow(
      /session revalidation interval/i,
    )
    expect(() => new SyncCommandHandler({ ...base, socketMaxLifetimeMs: 0 })).toThrow(/session revalidation interval/i)
  })
})
