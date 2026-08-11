/**
 * @jest-environment node
 */
import { webcrypto } from 'node:crypto'
import * as Y from 'yjs'
import {
  EncryptedYjsProvider,
  MAX_ACTIVE_INBOUND_CRYPTO,
  MAX_INBOUND_CHUNK_DECRYPTS,
  MAX_YJS_TRANSFER_BYTES,
  YJS_CHUNK_PLAINTEXT_BYTES,
  YJS_TRANSFER_TIMEOUT_MS,
} from './EncryptedYjsProvider'
import { createRoomCipher, RoomCipher } from './RoomCrypto'
import type { CollabChannel, CollabFrame } from './CollabChannel'

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
})

/** Fast identity-equivalent transport used only to isolate provider behavior. */
const createTestTransportCipher = (): RoomCipher => ({
  encrypt: async (plaintext) => Buffer.from(plaintext).toString('base64'),
  decrypt: async (payload) => new Uint8Array(Buffer.from(payload, 'base64')),
})

const generateTestRoomKey = (): Promise<CryptoKey> =>
  globalThis.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]) as Promise<CryptoKey>

// In-memory hub that mirrors the gateway's room relay semantics: frames go to
// every OTHER member of the room, and a join prompts existing members to re-sync.
class LoopbackHub {
  private readonly handlers = new Map<symbol, (f: CollabFrame) => void>()
  private readonly rooms = new Map<string, Set<symbol>>()

  channel(): CollabChannel {
    const id = Symbol('chan')
    return {
      isConnected: () => true,
      subscribe: (handler) => {
        this.handlers.set(id, handler)
        return () => this.handlers.delete(id)
      },
      send: (frame) => this.relay(id, frame),
      // The loopback authorizer always grants (membership is out of scope here);
      // the gateway-side capability verification is unit-tested separately.
      authorize: () => Promise.resolve('test-capability'),
    }
  }

  private relay(from: symbol, frame: CollabFrame): void {
    if (frame.t === 'room-join') {
      const set = this.rooms.get(frame.room) ?? new Set<symbol>()
      set.add(from)
      this.rooms.set(frame.room, set)
      this.handlers.get(from)?.({ t: 'room-joined', room: frame.room, requestId: frame.requestId })
      // Ask existing members to re-sync (gateway behaviour).
      for (const member of set) {
        if (member !== from) this.handlers.get(member)?.({ t: 'room-sync', room: frame.room })
      }
      return
    }
    if (frame.t === 'room-leave') {
      this.rooms.get(frame.room)?.delete(from)
      return
    }
    const members = this.rooms.get(frame.room)
    if (!members) return
    for (const member of members) {
      if (member !== from) this.handlers.get(member)?.(frame)
    }
  }
}

class ReconnectableLoopbackHub {
  private readonly handlers = new Map<symbol, (f: CollabFrame) => void>()
  private readonly statusHandlers = new Map<symbol, (connected: boolean) => void>()
  private readonly connected = new Map<symbol, boolean>()
  private readonly rooms = new Map<string, Set<symbol>>()

  channel(): { channel: CollabChannel; setConnected(connected: boolean): void } {
    const id = Symbol('reconnectable-channel')
    this.connected.set(id, true)
    return {
      channel: {
        isConnected: () => this.connected.get(id) === true,
        subscribe: (handler) => {
          this.handlers.set(id, handler)
          return () => this.handlers.delete(id)
        },
        subscribeStatus: (handler) => {
          this.statusHandlers.set(id, handler)
          return () => this.statusHandlers.delete(id)
        },
        send: (frame) => {
          if (this.connected.get(id)) {
            this.relay(id, frame)
          }
        },
        authorize: async () => 'fresh-capability',
      },
      setConnected: (connected) => {
        if (this.connected.get(id) === connected) {
          return
        }
        this.connected.set(id, connected)
        if (!connected) {
          for (const members of this.rooms.values()) {
            members.delete(id)
          }
        }
        this.statusHandlers.get(id)?.(connected)
      },
    }
  }

  private relay(from: symbol, frame: CollabFrame): void {
    if (frame.t === 'room-join') {
      const members = this.rooms.get(frame.room) ?? new Set<symbol>()
      members.add(from)
      this.rooms.set(frame.room, members)
      this.handlers.get(from)?.({ t: 'room-joined', room: frame.room, requestId: frame.requestId })
      for (const member of members) {
        if (member !== from) {
          this.handlers.get(member)?.({ t: 'room-sync', room: frame.room })
        }
      }
      return
    }
    if (frame.t === 'room-leave') {
      this.rooms.get(frame.room)?.delete(from)
      return
    }
    for (const member of this.rooms.get(frame.room) ?? []) {
      if (member !== from && this.connected.get(member)) {
        this.handlers.get(member)?.(frame)
      }
    }
  }
}

async function settle(...providers: EncryptedYjsProvider[]): Promise<void> {
  // Updates may cascade (full-state replies, etc.); flush a few rounds.
  for (let i = 0; i < 6; i++) {
    await Promise.all(providers.map((p) => p.flush()))
  }
}

async function flushMicrotasksUntil(predicate: () => boolean, turns = 40): Promise<void> {
  for (let turn = 0; turn < turns && !predicate(); turn += 1) {
    await Promise.resolve()
  }
}

describe('EncryptedYjsProvider convergence', () => {
  it('attaches to the hook-activated lease and waits for its correlated peer state without replaying room-join', async () => {
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    const remote = new Y.Doc()
    remote.getText('content').insert(0, 'authoritative peer state')
    const remotePayload = Buffer.from(Y.encodeStateAsUpdate(remote)).toString('base64')
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize: jest.fn(),
      subscribe: (handler) => {
        inbound = handler
        return () => {
          inbound = undefined
        }
      },
      send: (frame) => {
        sent.push(frame)
        if (frame.t === 'yjs' && frame.transferId) {
          inbound?.({ t: 'yjs-accepted', room: frame.room, transferId: frame.transferId, protocolVersion: 2 })
        } else if (frame.t === 'yjs-retry') {
          inbound?.({
            t: 'yjs',
            room: frame.room,
            payload: remotePayload,
            stateRequestId: frame.requestId,
          })
        }
      },
    }
    const release = jest.fn()
    const lease = {
      requestId: 'already-active-request',
      shouldBootstrap: false,
      protocolVersion: 2 as const,
      maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      release,
    }
    const doc = new Y.Doc()
    const provider = new EncryptedYjsProvider(
      doc,
      'active-room',
      channel,
      createTestTransportCipher(),
      undefined,
      lease.requestId,
      {
        activeLease: lease,
        shouldBootstrap: false,
        validateAttachment: jest.fn(() => true),
        reactivate: jest.fn(),
        onFatal: jest.fn(),
      },
    )
    const sync = jest.fn()
    provider.on('sync', sync as never)

    provider.connect()
    await settle(provider)

    expect(sent.some((frame) => frame.t === 'room-reserve' || frame.t === 'room-join')).toBe(false)
    const stateRequest = sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'yjs-retry' }> => frame.t === 'yjs-retry',
    )
    expect(stateRequest?.requestId).toEqual(expect.any(String))
    expect(doc.getText('content').toString()).toBe('authoritative peer state')
    expect(sync).toHaveBeenCalledWith(true)
    provider.destroy()
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('keeps a fresh bootstrap editor non-canonical with bounded work until its exact snapshot is accepted', async () => {
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    const provider = new EncryptedYjsProvider(
      new Y.Doc(),
      'deferred-bootstrap-room',
      {
        isConnected: () => true,
        authorize: jest.fn(),
        subscribe: (handler) => {
          inbound = handler
          return jest.fn()
        },
        send: (frame) => sent.push(frame),
      },
      createTestTransportCipher(),
      undefined,
      'deferred-bootstrap-lease',
      {
        activeLease: {
          requestId: 'deferred-bootstrap-lease',
          shouldBootstrap: true,
          protocolVersion: 2,
          maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
          release: jest.fn(),
        },
        shouldBootstrap: true,
        validateAttachment: jest.fn(() => true),
        reactivate: jest.fn(),
        onFatal: jest.fn(),
        onBootstrapRetry: jest.fn(),
      },
    )
    const readiness = jest.fn()
    provider.onCanonicalReadyChange(readiness)

    provider.connect()
    await flushMicrotasksUntil(() => provider.isRoomJoined())
    provider.doc.getText('content').insert(0, 'canonical initial body')
    await flushMicrotasksUntil(() => sent.some((frame) => frame.t === 'yjs' && frame.transferId !== undefined))
    const awaiting = sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'yjs' }> => frame.t === 'yjs' && frame.transferId !== undefined,
    )
    expect(awaiting).toBeDefined()
    expect(provider.isCanonicalReady()).toBe(false)

    let peakPending = provider.getPendingCount()
    for (let index = 0; index < 256; index += 1) {
      provider.doc.getText('content').insert(provider.doc.getText('content').length, 'x')
      peakPending = Math.max(peakPending, provider.getPendingCount())
    }
    expect(peakPending).toBeLessThanOrEqual(2)
    expect(readiness).not.toHaveBeenCalledWith(true)

    inbound?.({
      t: 'yjs-accepted',
      room: 'deferred-bootstrap-room',
      transferId: awaiting!.transferId!,
      protocolVersion: 2,
    })
    await settle(provider)
    expect(provider.isCanonicalReady()).toBe(true)
    expect(readiness).toHaveBeenCalledWith(true)
    provider.destroy()
  })

  it('retries one failed local frame without later tearing down a recovered single-peer editor', async () => {
    jest.useFakeTimers()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    let inbound: ((frame: CollabFrame) => void) | undefined
    let failNextYjs = false
    const sent: CollabFrame[] = []
    const send = jest.fn((frame: CollabFrame) => {
      if (frame.t === 'room-join') {
        sent.push(frame)
        inbound?.({ t: 'room-joined', room: frame.room, requestId: frame.requestId })
        return
      }
      if (frame.t === 'yjs' && failNextYjs) {
        failNextYjs = false
        throw new Error('one transient send failure')
      }
      sent.push(frame)
    })
    const provider = new EncryptedYjsProvider(
      new Y.Doc(),
      'single-peer-retry-room',
      {
        isConnected: () => true,
        authorize: async () => 'capability',
        subscribe: (handler) => {
          inbound = handler
          return jest.fn()
        },
        send,
      },
      createTestTransportCipher(),
    )
    try {
      provider.connect()
      await settle(provider)
      sent.length = 0
      failNextYjs = true
      provider.doc.getText('content').insert(0, 'must survive transient send failure')
      await flushMicrotasksUntil(() => provider.getLastSyncFailure() === 'encrypted-yjs-frame-failed')

      await jest.advanceTimersByTimeAsync(250)
      await settle(provider)
      const delivered = sent.find((frame): frame is Extract<CollabFrame, { t: 'yjs' }> => frame.t === 'yjs')
      expect(delivered).toBeDefined()
      const verifier = new Y.Doc()
      Y.applyUpdate(verifier, new Uint8Array(Buffer.from(delivered!.payload, 'base64')))
      expect(verifier.getText('content').toString()).toBe('must survive transient send failure')

      await jest.advanceTimersByTimeAsync(100_000)
      expect(provider.isRoomJoined()).toBe(true)
      expect(provider.getLastSyncFailure()).toBeUndefined()
    } finally {
      provider.destroy()
      consoleError.mockRestore()
      jest.useRealTimers()
    }
  })

  it('continues canonical state establishment when initial awareness encryption fails', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const sent: CollabFrame[] = []
    const cipher: RoomCipher = {
      encrypt: async (plaintext, additionalData) => {
        if (new TextDecoder().decode(additionalData).includes('awareness')) {
          throw new Error('transient presence failure')
        }
        return Buffer.from(plaintext).toString('base64')
      },
      decrypt: async (payload) => new Uint8Array(Buffer.from(payload, 'base64')),
    }
    const provider = new EncryptedYjsProvider(
      new Y.Doc(),
      'awareness-failure-room',
      {
        isConnected: () => true,
        authorize: jest.fn(),
        subscribe: () => jest.fn(),
        send: (frame) => sent.push(frame),
      },
      cipher,
      undefined,
      'awareness-failure-lease',
      {
        activeLease: {
          requestId: 'awareness-failure-lease',
          shouldBootstrap: false,
          protocolVersion: 2,
          maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
          release: jest.fn(),
        },
        shouldBootstrap: false,
        validateAttachment: jest.fn(() => true),
        reactivate: jest.fn(),
        onFatal: jest.fn(),
        onBootstrapRetry: jest.fn(),
      },
    )
    try {
      provider.connect()
      await flushMicrotasksUntil(() => sent.some((frame) => frame.t === 'yjs-retry'))
      expect(sent.some((frame) => frame.t === 'yjs-retry')).toBe(true)
      expect(provider.isRoomJoined()).toBe(true)
      expect(provider.isCanonicalReady()).toBe(false)
    } finally {
      provider.destroy()
      consoleError.mockRestore()
    }
  })

  it('retries a transient newcomer state-request send instead of remaining read-only forever', async () => {
    jest.useFakeTimers()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    let stateRequestAttempts = 0
    const onBootstrapRetry = jest.fn()
    const provider = new EncryptedYjsProvider(
      new Y.Doc(),
      'transient-state-request-room',
      {
        isConnected: () => true,
        authorize: jest.fn(),
        subscribe: (handler) => {
          inbound = handler
          return jest.fn()
        },
        send: (frame) => {
          if (frame.t === 'yjs-retry') {
            stateRequestAttempts += 1
            if (stateRequestAttempts === 1) {
              throw new Error('one transient control-send failure')
            }
          }
          sent.push(frame)
          if (frame.t === 'yjs' && frame.transferId) {
            inbound?.({ t: 'yjs-accepted', room: frame.room, transferId: frame.transferId, protocolVersion: 2 })
          }
        },
      },
      createTestTransportCipher(),
      undefined,
      'transient-state-request-lease',
      {
        activeLease: {
          requestId: 'transient-state-request-lease',
          shouldBootstrap: false,
          protocolVersion: 2,
          maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
          release: jest.fn(),
        },
        shouldBootstrap: false,
        validateAttachment: jest.fn(() => true),
        reactivate: jest.fn(),
        onFatal: jest.fn(),
        onBootstrapRetry,
      },
    )
    try {
      provider.connect()
      await flushMicrotasksUntil(() => stateRequestAttempts === 1)
      expect(provider.isCanonicalReady()).toBe(false)

      await jest.advanceTimersByTimeAsync(1_000)
      const request = sent.find((frame): frame is Extract<CollabFrame, { t: 'yjs-retry' }> => frame.t === 'yjs-retry')
      expect(stateRequestAttempts).toBe(2)
      expect(request).toBeDefined()

      const canonical = new Y.Doc()
      canonical.getText('content').insert(0, 'canonical after retry')
      inbound?.({
        t: 'yjs',
        room: 'transient-state-request-room',
        payload: Buffer.from(Y.encodeStateAsUpdate(canonical)).toString('base64'),
        stateRequestId: request!.requestId,
      })
      await settle(provider)
      expect(provider.isCanonicalReady()).toBe(true)
      expect(provider.doc.getText('content').toString()).toBe('canonical after retry')
      expect(onBootstrapRetry).not.toHaveBeenCalled()
    } finally {
      provider.destroy()
      consoleError.mockRestore()
      jest.useRealTimers()
    }
  })

  it('releases and remounts after the elected bootstrap peer disappears before sending state', async () => {
    jest.useFakeTimers()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const release = jest.fn()
    const onBootstrapRetry = jest.fn()
    const sent: CollabFrame[] = []
    let provider: EncryptedYjsProvider | undefined
    try {
      provider = new EncryptedYjsProvider(
        new Y.Doc(),
        'missing-bootstrap-peer-room',
        {
          isConnected: () => true,
          authorize: jest.fn(),
          subscribe: () => jest.fn(),
          send: (frame) => sent.push(frame),
        },
        createTestTransportCipher(),
        undefined,
        'missing-bootstrap-peer-lease',
        {
          activeLease: {
            requestId: 'missing-bootstrap-peer-lease',
            shouldBootstrap: false,
            protocolVersion: 2,
            maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
            release,
          },
          shouldBootstrap: false,
          validateAttachment: jest.fn(() => true),
          reactivate: jest.fn(),
          onFatal: jest.fn(),
          onBootstrapRetry,
        },
      )

      provider.connect()
      await flushMicrotasksUntil(() => sent.some((frame) => frame.t === 'yjs-retry'))
      expect(sent.filter((frame) => frame.t === 'yjs-retry')).toHaveLength(1)

      for (let attempt = 0; attempt < 8; attempt += 1) {
        await jest.advanceTimersByTimeAsync(10_000)
      }
      await provider.flush()

      expect(sent.filter((frame) => frame.t === 'yjs-retry')).toHaveLength(8)
      expect(release).toHaveBeenCalledTimes(1)
      expect(onBootstrapRetry).toHaveBeenCalledTimes(1)
      expect(provider.isRoomJoined()).toBe(false)
    } finally {
      provider?.destroy()
      consoleError.mockRestore()
      jest.useRealTimers()
    }
  })

  it('bounds bootstrap snapshot acceptance retries before releasing for a fresh election', async () => {
    jest.useFakeTimers()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const release = jest.fn()
    const onBootstrapRetry = jest.fn()
    const sent: CollabFrame[] = []
    let provider: EncryptedYjsProvider | undefined
    try {
      provider = new EncryptedYjsProvider(
        new Y.Doc(),
        'dropped-bootstrap-ack-room',
        {
          isConnected: () => true,
          authorize: jest.fn(),
          subscribe: () => jest.fn(),
          send: (frame) => sent.push(frame),
        },
        createTestTransportCipher(),
        undefined,
        'dropped-bootstrap-ack-lease',
        {
          activeLease: {
            requestId: 'dropped-bootstrap-ack-lease',
            shouldBootstrap: true,
            protocolVersion: 2,
            maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
            release,
          },
          shouldBootstrap: true,
          validateAttachment: jest.fn(() => true),
          reactivate: jest.fn(),
          onFatal: jest.fn(),
          onBootstrapRetry,
        },
      )

      provider.connect()
      await Promise.resolve()
      await Promise.resolve()
      provider.doc.getText('content').insert(0, 'canonical bootstrap body')
      await Promise.resolve()
      await Promise.resolve()

      for (let attempt = 0; attempt < 3; attempt += 1) {
        await jest.advanceTimersByTimeAsync(10_000)
      }
      await provider.flush()

      expect(sent.filter((frame) => frame.t === 'yjs' && frame.transferId !== undefined)).toHaveLength(3)
      expect(release).toHaveBeenCalledTimes(1)
      expect(onBootstrapRetry).toHaveBeenCalledTimes(1)
      expect(provider.isRoomJoined()).toBe(false)
    } finally {
      provider?.destroy()
      consoleError.mockRestore()
      jest.useRealTimers()
    }
  })

  it('re-proves a seeded bootstrap snapshot after its socket disappears before acknowledgement', async () => {
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    let status: ((connected: boolean) => void) | undefined
    let connected = true
    let acceptSnapshots = false
    const channel: CollabChannel = {
      isConnected: () => connected,
      authorize: jest.fn(),
      subscribe: (handler) => {
        inbound = handler
        return () => {
          inbound = undefined
        }
      },
      subscribeStatus: (handler) => {
        status = handler
        return () => {
          status = undefined
        }
      },
      send: (frame) => {
        sent.push(frame)
        if (acceptSnapshots && frame.t === 'yjs' && frame.transferId) {
          inbound?.({ t: 'yjs-accepted', room: frame.room, transferId: frame.transferId, protocolVersion: 2 })
        }
      },
    }
    const firstRelease = jest.fn()
    const secondRelease = jest.fn()
    const reactivate = jest.fn().mockResolvedValue({
      requestId: 'reconnected-bootstrap-lease',
      shouldBootstrap: true,
      protocolVersion: 2 as const,
      maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      release: secondRelease,
    })
    const doc = new Y.Doc()
    const provider = new EncryptedYjsProvider(
      doc,
      'bootstrap-reconnect-room',
      channel,
      createTestTransportCipher(),
      undefined,
      'initial-bootstrap-lease',
      {
        activeLease: {
          requestId: 'initial-bootstrap-lease',
          shouldBootstrap: true,
          protocolVersion: 2,
          maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
          release: firstRelease,
        },
        shouldBootstrap: true,
        validateAttachment: jest.fn(() => true),
        reactivate,
        onFatal: jest.fn(),
        onBootstrapRetry: jest.fn(),
      },
    )

    provider.connect()
    await Promise.resolve()
    await Promise.resolve()
    doc.getText('content').insert(0, 'seeded immediately before transport loss')
    await flushMicrotasksUntil(() => sent.some((frame) => frame.t === 'yjs' && frame.transferId !== undefined))
    expect(sent.some((frame) => frame.t === 'yjs' && frame.transferId !== undefined)).toBe(true)

    connected = false
    status?.(false)
    expect(firstRelease).toHaveBeenCalledTimes(1)
    acceptSnapshots = true
    connected = true
    status?.(true)
    await settle(provider)

    expect(reactivate).toHaveBeenCalledTimes(1)
    expect(provider.isRoomJoined()).toBe(true)
    expect((provider as unknown as { stateServingReady: boolean }).stateServingReady).toBe(true)
    const acceptedSnapshot = [...sent]
      .reverse()
      .find((frame): frame is Extract<CollabFrame, { t: 'yjs' }> => frame.t === 'yjs' && frame.transferId !== undefined)
    const recovered = new Y.Doc()
    Y.applyUpdate(recovered, new Uint8Array(Buffer.from(acceptedSnapshot!.payload, 'base64')))
    expect(recovered.getText('content').toString()).toBe('seeded immediately before transport loss')

    provider.destroy()
    expect(secondRelease).toHaveBeenCalledTimes(1)
  })

  it('does not establish on an uncorrelated partial and publishes local loading edits after exact correlation', async () => {
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize: jest.fn(),
      subscribe: (handler) => {
        inbound = handler
        return jest.fn()
      },
      send: (frame) => {
        sent.push(frame)
        if (frame.t === 'yjs' && frame.transferId) {
          inbound?.({ t: 'yjs-accepted', room: frame.room, transferId: frame.transferId, protocolVersion: 2 })
        }
      },
    }
    const lease = {
      requestId: 'loading-request',
      shouldBootstrap: false,
      protocolVersion: 2 as const,
      maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      release: jest.fn(),
    }
    const doc = new Y.Doc()
    const provider = new EncryptedYjsProvider(
      doc,
      'loading-room',
      channel,
      createTestTransportCipher(),
      undefined,
      lease.requestId,
      {
        activeLease: lease,
        shouldBootstrap: false,
        validateAttachment: jest.fn(() => true),
        reactivate: jest.fn(),
        onFatal: jest.fn(),
        onBootstrapRetry: jest.fn(),
      },
    )
    const sync = jest.fn()
    provider.on('sync', sync as never)
    provider.connect()
    await flushMicrotasksUntil(() => sent.some((frame) => frame.t === 'yjs-retry'))
    const stateRequest = sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'yjs-retry' }> => frame.t === 'yjs-retry',
    )!

    doc.getText('content').insert(0, 'local-during-load ')
    const partial = new Y.Doc()
    partial.getText('other').insert(0, 'uncorrelated-partial')
    inbound?.({
      t: 'yjs',
      room: 'loading-room',
      payload: Buffer.from(Y.encodeStateAsUpdate(partial)).toString('base64'),
    })
    inbound?.({
      t: 'yjs-retry',
      room: 'loading-room',
      requestId: 'retry-before-ready',
      requesterClientId: 0xffff_ffff,
    })
    await provider.flush()
    expect(sync).not.toHaveBeenCalledWith(true)
    expect(sent.some((frame) => frame.t === 'yjs' && frame.stateRequestId === 'retry-before-ready')).toBe(false)

    const canonical = new Y.Doc()
    canonical.getText('content').insert(0, 'canonical-peer-state')
    inbound?.({
      t: 'yjs',
      room: 'loading-room',
      payload: Buffer.from(Y.encodeStateAsUpdate(canonical)).toString('base64'),
      stateRequestId: stateRequest.requestId,
    })
    await settle(provider)

    expect(sync).toHaveBeenCalledWith(true)
    expect(doc.getText('content').toString()).toContain('local-during-load')
    expect(doc.getText('content').toString()).toContain('canonical-peer-state')
    const claim = sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'yjs-response-claim' }> =>
        frame.t === 'yjs-response-claim' && frame.stateRequestId === 'retry-before-ready',
    )
    expect(claim).toMatchObject({ leaseRequestId: lease.requestId })
    expect(sent.some((frame) => frame.t === 'yjs' && frame.stateRequestId === 'retry-before-ready')).toBe(false)
    inbound?.({
      t: 'yjs-response-granted',
      room: 'loading-room',
      stateRequestId: 'retry-before-ready',
      leaseRequestId: lease.requestId,
      protocolVersion: 2,
    })
    await settle(provider)
    expect(sent.some((frame) => frame.t === 'yjs' && frame.stateRequestId === 'retry-before-ready')).toBe(true)
    const merged = sent.find(
      (frame): frame is Extract<CollabFrame, { t: 'yjs' }> => frame.t === 'yjs' && frame.transferId !== undefined,
    )!
    const verifier = new Y.Doc()
    Y.applyUpdate(verifier, new Uint8Array(Buffer.from(merged.payload, 'base64')))
    expect(verifier.getText('content').toString()).toContain('local-during-load')
    expect(verifier.getText('content').toString()).toContain('canonical-peer-state')
    provider.destroy()
  })

  it('does not subscribe or relay when the final durable attachment guard fails', () => {
    const release = jest.fn()
    const send = jest.fn()
    const subscribe = jest.fn(() => jest.fn())
    const subscribeStatus = jest.fn(() => jest.fn())
    const provider = new EncryptedYjsProvider(
      new Y.Doc(),
      'stale-before-attach-room',
      {
        isConnected: () => true,
        authorize: jest.fn(),
        send,
        subscribe,
        subscribeStatus,
      },
      createTestTransportCipher(),
      undefined,
      'stale-lease',
      {
        activeLease: {
          requestId: 'stale-lease',
          shouldBootstrap: true,
          protocolVersion: 2,
          maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
          release,
        },
        shouldBootstrap: true,
        validateAttachment: jest.fn(() => false),
        reactivate: jest.fn(),
        onFatal: jest.fn(),
      },
    )

    provider.connect()

    expect(release).toHaveBeenCalledTimes(1)
    expect(subscribe).not.toHaveBeenCalled()
    expect(subscribeStatus).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    provider.destroy()
  })

  it('releases immediately and performs no crypto when authorization is lost before React cleanup', async () => {
    let inbound: ((frame: CollabFrame) => void) | undefined
    let authorized = true
    const sent: CollabFrame[] = []
    const release = jest.fn()
    const cipher: RoomCipher = {
      encrypt: jest.fn(async (plaintext) => Buffer.from(plaintext).toString('base64')),
      decrypt: jest.fn(async () => {
        const remote = new Y.Doc()
        remote.getText('content').insert(0, 'must never decrypt')
        return Y.encodeStateAsUpdate(remote)
      }),
    }
    const doc = new Y.Doc()
    const provider = new EncryptedYjsProvider(
      doc,
      'authorization-race-room',
      {
        isConnected: () => true,
        authorize: jest.fn(),
        subscribe: (handler) => {
          inbound = handler
          return jest.fn()
        },
        send: (frame) => sent.push(frame),
      },
      cipher,
      undefined,
      'authorization-race-lease',
      {
        activeLease: {
          requestId: 'authorization-race-lease',
          shouldBootstrap: true,
          protocolVersion: 2,
          maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
          release,
        },
        shouldBootstrap: true,
        validateAttachment: jest.fn(() => authorized),
        reactivate: jest.fn(),
        onFatal: jest.fn(),
        onBootstrapRetry: jest.fn(),
      },
    )
    provider.connect()
    await settle(provider)
    expect(provider.isRoomJoined()).toBe(true)
    expect(release).not.toHaveBeenCalled()
    const encryptionsBeforeLoss = jest.mocked(cipher.encrypt).mock.calls.length

    authorized = false
    inbound?.({ t: 'yjs', room: 'authorization-race-room', payload: 'opaque-ciphertext' })

    expect(release).toHaveBeenCalledTimes(1)
    expect(provider.isRoomJoined()).toBe(false)
    expect(cipher.decrypt).not.toHaveBeenCalled()
    expect(doc.getText('content').toString()).toBe('')
    doc.getText('content').insert(0, 'local after access loss')
    await provider.flush()
    expect(jest.mocked(cipher.encrypt)).toHaveBeenCalledTimes(encryptionsBeforeLoss)
    expect(sent.some((frame) => frame.t === 'yjs' || frame.t === 'yjs-chunk')).toBe(false)
    provider.destroy()
  })

  it('retains the live Y.Doc and obtains one fresh activated lease after transport reconnect', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    let status: ((connected: boolean) => void) | undefined
    let connected = true
    let failNextAcceptedState = false
    const channel: CollabChannel = {
      isConnected: () => connected,
      authorize: jest.fn(),
      subscribe: (handler) => {
        inbound = handler
        return () => {
          inbound = undefined
        }
      },
      subscribeStatus: (handler) => {
        status = handler
        return () => {
          status = undefined
        }
      },
      send: (frame) => {
        if (frame.t === 'yjs' && frame.transferId && failNextAcceptedState) {
          failNextAcceptedState = false
          throw new Error('transient retained-state send failure')
        }
        sent.push(frame)
        if (frame.t === 'yjs' && frame.transferId) {
          inbound?.({ t: 'yjs-accepted', room: frame.room, transferId: frame.transferId, protocolVersion: 2 })
        }
      },
    }
    const firstRelease = jest.fn()
    const secondRelease = jest.fn()
    const firstLease = {
      requestId: 'initial-active-request',
      shouldBootstrap: true,
      protocolVersion: 2 as const,
      maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      release: firstRelease,
    }
    const secondLease = {
      requestId: 'fresh-reconnect-request',
      shouldBootstrap: true,
      protocolVersion: 2 as const,
      maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      release: secondRelease,
    }
    const reactivate = jest.fn().mockResolvedValue(secondLease)
    const setCanonicalOwnership = jest.fn()
    const doc = new Y.Doc()
    doc.getText('content').insert(0, 'before disconnect')
    const provider = new EncryptedYjsProvider(
      doc,
      'reconnect-active-room',
      channel,
      createTestTransportCipher(),
      undefined,
      firstLease.requestId,
      {
        activeLease: firstLease,
        shouldBootstrap: true,
        validateAttachment: jest.fn(() => true),
        reactivate,
        onFatal: jest.fn(),
        setCanonicalOwnership,
      },
    )
    provider.connect()
    await settle(provider)
    sent.length = 0
    setCanonicalOwnership.mockClear()

    connected = false
    status?.(false)
    expect(setCanonicalOwnership).toHaveBeenLastCalledWith(false)
    doc.getText('content').insert(doc.getText('content').length, ' + offline edit')
    await provider.flush()
    expect(sent).toHaveLength(0)

    connected = true
    failNextAcceptedState = true
    status?.(true)
    await settle(provider)

    expect(reactivate).toHaveBeenCalledTimes(1)
    expect(sent.some((frame) => frame.t === 'room-reserve' || frame.t === 'room-join')).toBe(false)
    const fullState = sent.find((frame): frame is Extract<CollabFrame, { t: 'yjs' }> => frame.t === 'yjs')
    const recovered = new Y.Doc()
    Y.applyUpdate(recovered, new Uint8Array(Buffer.from(fullState!.payload, 'base64')))
    expect(recovered.getText('content').toString()).toBe('before disconnect + offline edit')
    expect(provider.doc).toBe(doc)
    expect(setCanonicalOwnership).toHaveBeenLastCalledWith(true)
    expect(firstRelease).toHaveBeenCalledTimes(1)

    provider.destroy()
    expect(secondRelease).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  it('leaves the mounted editor through bootstrap failover after bounded reconnect lease retries', async () => {
    jest.useFakeTimers()
    const random = jest.spyOn(Math, 'random').mockReturnValue(1)
    const release = jest.fn()
    const onBootstrapRetry = jest.fn()
    let status: ((connected: boolean) => void) | undefined
    let connected = true
    const channel: CollabChannel = {
      isConnected: () => connected,
      authorize: jest.fn(),
      subscribe: () => jest.fn(),
      subscribeStatus: (handler) => {
        status = handler
        return () => {
          status = undefined
        }
      },
      send: jest.fn(),
    }
    const reactivate = jest.fn().mockResolvedValue({ reason: 'temporary lease failure' })
    const provider = new EncryptedYjsProvider(
      new Y.Doc(),
      'bounded-reconnect-room',
      channel,
      createTestTransportCipher(),
      undefined,
      'bounded-reconnect-lease',
      {
        activeLease: {
          requestId: 'bounded-reconnect-lease',
          shouldBootstrap: true,
          protocolVersion: 2,
          maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
          release,
        },
        shouldBootstrap: true,
        validateAttachment: jest.fn(() => true),
        reactivate,
        onFatal: jest.fn(),
        onBootstrapRetry,
      },
    )

    try {
      provider.connect()
      await Promise.resolve()
      connected = false
      status?.(false)
      connected = true
      status?.(true)
      await Promise.resolve()

      await jest.advanceTimersByTimeAsync(31_000)
      await provider.flush()

      expect(reactivate).toHaveBeenCalledTimes(6)
      expect(onBootstrapRetry).toHaveBeenCalledTimes(1)
      expect(release).toHaveBeenCalledTimes(1)
      expect(provider.isRoomJoined()).toBe(false)
    } finally {
      provider.destroy()
      random.mockRestore()
      jest.useRealTimers()
    }
  })

  it('survives a StrictMode connect-disconnect-connect replay without destroying awareness or using legacy join', async () => {
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize: jest.fn(),
      subscribe: (handler) => {
        inbound = handler
        return () => {
          inbound = undefined
        }
      },
      send: (frame) => {
        sent.push(frame)
        if (frame.t === 'yjs' && frame.transferId) {
          inbound?.({ t: 'yjs-accepted', room: frame.room, transferId: frame.transferId, protocolVersion: 2 })
        }
      },
    }
    const initialRelease = jest.fn()
    const replayRelease = jest.fn()
    const initialLease = {
      requestId: 'strict-initial-lease',
      shouldBootstrap: true,
      protocolVersion: 2 as const,
      maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      release: initialRelease,
    }
    const replayLease = {
      requestId: 'strict-replayed-lease',
      shouldBootstrap: true,
      protocolVersion: 2 as const,
      maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      release: replayRelease,
    }
    const reactivate = jest.fn().mockResolvedValue(replayLease)
    const provider = new EncryptedYjsProvider(
      new Y.Doc(),
      'strict-replay-room',
      channel,
      createTestTransportCipher(),
      undefined,
      initialLease.requestId,
      {
        activeLease: initialLease,
        shouldBootstrap: true,
        validateAttachment: jest.fn(() => true),
        reactivate,
        onFatal: jest.fn(),
      },
    )
    const awarenessDestroyed = jest.fn()
    const awareness = provider.awareness as unknown as {
      on(type: 'destroy', callback: () => void): void
      setLocalState(state: Record<string, unknown>): void
      getLocalState(): Record<string, unknown> | null
    }
    awareness.on('destroy', awarenessDestroyed)
    awareness.setLocalState({
      name: 'Alice',
      color: '#ff0000',
      awarenessData: { userUuid: 'user-1' },
    })

    provider.connect()
    await settle(provider)

    expect(awareness.getLocalState()).toMatchObject({
      name: 'Alice',
      color: '#ff0000',
      awarenessData: { userUuid: 'user-1' },
    })
    provider.disconnect()
    expect(initialRelease).toHaveBeenCalledTimes(1)
    expect(awarenessDestroyed).not.toHaveBeenCalled()

    sent.length = 0
    provider.connect()
    await settle(provider)

    expect(reactivate).toHaveBeenCalledTimes(1)
    expect(awareness.getLocalState()).toMatchObject({
      name: 'Alice',
      color: '#ff0000',
      awarenessData: { userUuid: 'user-1' },
    })
    expect(provider.isRoomJoined()).toBe(true)
    expect(channel.authorize).not.toHaveBeenCalled()
    expect(sent.some((frame) => frame.t === 'room-reserve' || frame.t === 'room-join')).toBe(false)
    expect(awarenessDestroyed).not.toHaveBeenCalled()

    provider.destroy()
    expect(replayRelease).toHaveBeenCalledTimes(1)
    expect(awarenessDestroyed).toHaveBeenCalledTimes(1)
  })

  it('discards a lease resolved for an obsolete socket generation and attaches the current generation', async () => {
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    let status: ((connected: boolean) => void) | undefined
    let connected = true
    const channel: CollabChannel = {
      isConnected: () => connected,
      authorize: jest.fn(),
      subscribe: (handler) => {
        inbound = handler
        return () => {
          inbound = undefined
        }
      },
      subscribeStatus: (handler) => {
        status = handler
        return () => {
          status = undefined
        }
      },
      send: (frame) => {
        sent.push(frame)
        if (frame.t === 'yjs' && frame.transferId) {
          inbound?.({ t: 'yjs-accepted', room: frame.room, transferId: frame.transferId, protocolVersion: 2 })
        }
      },
    }
    const initialRelease = jest.fn()
    const obsoleteRelease = jest.fn()
    const currentRelease = jest.fn()
    const resolvers: Array<
      (lease: {
        requestId: string
        shouldBootstrap: boolean
        protocolVersion: 2
        maxTransferBytes: number
        release(): void
      }) => void
    > = []
    const reactivate = jest.fn(
      () =>
        new Promise<{
          requestId: string
          shouldBootstrap: boolean
          protocolVersion: 2
          maxTransferBytes: number
          release(): void
        }>((resolve) => resolvers.push(resolve)),
    )
    const provider = new EncryptedYjsProvider(
      new Y.Doc(),
      'generation-room',
      channel,
      createTestTransportCipher(),
      undefined,
      'initial-generation-lease',
      {
        activeLease: {
          requestId: 'initial-generation-lease',
          shouldBootstrap: true,
          protocolVersion: 2,
          maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
          release: initialRelease,
        },
        shouldBootstrap: true,
        validateAttachment: jest.fn(() => true),
        reactivate,
        onFatal: jest.fn(),
      },
    )
    provider.connect()
    await settle(provider)

    connected = false
    status?.(false)
    connected = true
    status?.(true)
    await Promise.resolve()
    expect(reactivate).toHaveBeenCalledTimes(1)

    connected = false
    status?.(false)
    connected = true
    status?.(true)
    await Promise.resolve()
    expect(reactivate).toHaveBeenCalledTimes(2)

    resolvers[0]({
      requestId: 'obsolete-generation-lease',
      shouldBootstrap: true,
      protocolVersion: 2,
      maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      release: obsoleteRelease,
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(obsoleteRelease).toHaveBeenCalledTimes(1)
    expect(provider.isRoomJoined()).toBe(false)

    resolvers[1]({
      requestId: 'current-generation-lease',
      shouldBootstrap: true,
      protocolVersion: 2,
      maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
      release: currentRelease,
    })
    await settle(provider)

    expect(provider.isRoomJoined()).toBe(true)
    expect(sent.some((frame) => frame.t === 'room-reserve' || frame.t === 'room-join')).toBe(false)
    provider.destroy()
    expect(currentRelease).toHaveBeenCalledTimes(1)
  })

  it('waits for its exact accepted join, then resends edits made while authorization was pending', async () => {
    let resolveAuthorization!: (capability: string) => void
    const authorization = new Promise<string>((resolve) => {
      resolveAuthorization = resolve
    })
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize: () => authorization,
      subscribe: (handler) => {
        inbound = handler
        return () => {
          inbound = undefined
        }
      },
      send: (frame) => sent.push(frame),
    }
    const doc = new Y.Doc()
    const provider = new EncryptedYjsProvider(doc, 'delayed-room', channel, createTestTransportCipher())
    const sync = jest.fn()
    provider.on('sync', sync as never)
    provider.connect()

    doc.getText('content').insert(0, 'typed before join')
    await provider.flush()
    expect(sent.filter((frame) => frame.t === 'yjs')).toHaveLength(0)
    expect(sync).not.toHaveBeenCalledWith(true)

    resolveAuthorization('exact-note-capability')
    await Promise.resolve()
    await Promise.resolve()
    const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
    expect(join?.cap).toBe('exact-note-capability')

    inbound?.({ t: 'room-joined', room: 'delayed-room', requestId: 'wrong-request' })
    await provider.flush()
    expect(provider.isRoomJoined()).toBe(false)
    expect(sent.filter((frame) => frame.t === 'yjs')).toHaveLength(0)

    inbound?.({ t: 'room-joined', room: 'delayed-room', requestId: join?.requestId })
    await provider.flush()
    await Promise.resolve()

    expect(provider.isRoomJoined()).toBe(true)
    expect(sync).toHaveBeenCalledWith(true)
    const stateFrame = sent.find((frame): frame is Extract<CollabFrame, { t: 'yjs' }> => frame.t === 'yjs')
    const recovered = new Y.Doc()
    Y.applyUpdate(recovered, new Uint8Array(Buffer.from(stateFrame!.payload, 'base64')))
    expect(recovered.getText('content').toString()).toBe('typed before join')
    provider.destroy()
  })

  it('stays fail-closed when the exact join request is denied', async () => {
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize: async () => 'capability',
      subscribe: (handler) => {
        inbound = handler
        return () => undefined
      },
      send: (frame) => sent.push(frame),
    }
    const doc = new Y.Doc()
    const provider = new EncryptedYjsProvider(doc, 'denied-room', channel, createTestTransportCipher())
    provider.connect()
    await Promise.resolve()
    await Promise.resolve()
    const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')

    inbound?.({ t: 'room-denied', room: 'denied-room', requestId: join?.requestId })
    doc.getText('content').insert(0, 'must remain local')
    await provider.flush()

    expect(provider.isRoomJoined()).toBe(false)
    expect(sent.filter((frame) => frame.t === 'yjs')).toHaveLength(0)
    provider.destroy()
  })

  it('retries a transient capability failure without sending an unauthorized frame', async () => {
    jest.useFakeTimers()
    try {
      const sent: CollabFrame[] = []
      let inbound: ((frame: CollabFrame) => void) | undefined
      const authorize = jest.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('recovered-capability')
      const channel: CollabChannel = {
        isConnected: () => true,
        authorize,
        subscribe: (handler) => {
          inbound = handler
          return () => undefined
        },
        send: (frame) => sent.push(frame),
      }
      const provider = new EncryptedYjsProvider(
        new Y.Doc(),
        'transient-auth-room',
        channel,
        createTestTransportCipher(),
      )
      provider.connect()
      await Promise.resolve()
      await Promise.resolve()
      expect(sent).toHaveLength(0)

      await jest.advanceTimersByTimeAsync(1_000)
      const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
      expect(join).toMatchObject({ cap: 'recovered-capability' })
      expect(authorize).toHaveBeenCalledTimes(2)

      inbound?.({ t: 'room-joined', room: 'transient-auth-room', requestId: join?.requestId })
      await provider.flush()
      expect(provider.isRoomJoined()).toBe(true)
      provider.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('reauthorizes with the same logical lease after an accepted membership expires', async () => {
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    const authorize = jest.fn().mockResolvedValue('renewed-capability')
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize,
      subscribe: (handler) => {
        inbound = handler
        return () => undefined
      },
      send: (frame) => sent.push(frame),
    }
    const doc = new Y.Doc()
    const provider = new EncryptedYjsProvider(
      doc,
      'expiring-room',
      channel,
      createTestTransportCipher(),
      'initial-capability',
    )
    provider.connect()
    const firstJoin = sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    inbound?.({ t: 'room-joined', room: 'expiring-room', requestId: firstJoin.requestId })
    await provider.flush()

    inbound?.({ t: 'room-denied', room: 'expiring-room', requestId: firstJoin.requestId })
    await Promise.resolve()
    await Promise.resolve()
    const joins = sent.filter((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')

    expect(authorize).toHaveBeenCalledWith('expiring-room')
    expect(joins).toHaveLength(2)
    expect(joins[1]).toMatchObject({
      cap: 'renewed-capability',
      requestId: firstJoin.requestId,
    })
    expect(provider.isRoomJoined()).toBe(false)

    doc.getText('content').insert(0, 'edited during renewal')
    await provider.flush()
    expect(sent.filter((frame) => frame.t === 'yjs')).toHaveLength(1)
    inbound?.({ t: 'room-joined', room: 'expiring-room', requestId: firstJoin.requestId })
    await provider.flush()
    expect(provider.isRoomJoined()).toBe(true)
    expect(sent.filter((frame) => frame.t === 'yjs')).toHaveLength(2)
    provider.destroy()
  })

  it('fails closed without sticking or rejecting when a room-join send throws', async () => {
    const authorize = jest.fn().mockResolvedValue('renewed-capability')
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize,
      subscribe: () => jest.fn(),
      send: (frame) => {
        if (frame.t === 'room-join') {
          throw new Error('socket closed')
        }
      },
    }
    const provider = new EncryptedYjsProvider(
      new Y.Doc(),
      'throwing-join-room',
      channel,
      createTestTransportCipher(),
      'initial-capability',
    )
    const retry = provider as unknown as { joinWithCapability(): Promise<void> }

    expect(() => provider.connect()).not.toThrow()
    await Promise.resolve()
    await expect(retry.joinWithCapability()).resolves.toBeUndefined()
    await expect(retry.joinWithCapability()).resolves.toBeUndefined()

    expect(authorize).toHaveBeenCalledTimes(2)
    expect(provider.isRoomJoined()).toBe(false)
    provider.destroy()
  })

  it('completes local teardown when offline leave and unsubscribe both throw', async () => {
    const sent: CollabFrame[] = []
    let inbound: ((frame: CollabFrame) => void) | undefined
    const unsubscribe = jest.fn(() => {
      throw new Error('unsubscribe failed')
    })
    const channel: CollabChannel = {
      isConnected: () => true,
      authorize: async () => 'capability',
      subscribe: (handler) => {
        inbound = handler
        return unsubscribe
      },
      send: (frame) => {
        sent.push(frame)
        if (frame.t === 'room-leave') {
          throw new Error('socket closed')
        }
      },
    }
    const doc = new Y.Doc()
    const provider = new EncryptedYjsProvider(
      doc,
      'offline-leave-room',
      channel,
      createTestTransportCipher(),
      'initial-capability',
    )
    provider.connect()
    const join = sent[0] as Extract<CollabFrame, { t: 'room-join' }>
    inbound?.({ t: 'room-joined', room: 'offline-leave-room', requestId: join.requestId })
    await provider.flush()

    expect(provider.isRoomJoined()).toBe(true)
    expect(() => provider.disconnect()).not.toThrow()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(provider.isRoomJoined()).toBe(false)

    const sentAfterDisconnect = sent.length
    doc.getText('content').insert(0, 'local only')
    await provider.flush()
    expect(sent).toHaveLength(sentAfterDisconnect)
    provider.destroy()
  })

  it('converges two docs editing the same room (test transport cipher)', async () => {
    const hub = new LoopbackHub()
    const room = 'note-1'
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = new EncryptedYjsProvider(docA, room, hub.channel(), createTestTransportCipher())
    const b = new EncryptedYjsProvider(docB, room, hub.channel(), createTestTransportCipher())
    a.connect()
    b.connect()
    await settle(a, b)

    docA.getText('content').insert(0, 'Hello ')
    docB.getText('content').insert(0, 'World')
    await settle(a, b)

    expect(docA.getText('content').toString()).toBe(docB.getText('content').toString())
    expect(docA.getText('content').toString().length).toBe('Hello World'.length)
    a.destroy()
    b.destroy()
  })

  it('a late joiner receives prior state via the room-sync handshake', async () => {
    const hub = new LoopbackHub()
    const room = 'note-2'
    const docA = new Y.Doc()
    const a = new EncryptedYjsProvider(docA, room, hub.channel(), createTestTransportCipher())
    a.connect()
    docA.getText('content').insert(0, 'existing content')
    await settle(a)

    const docB = new Y.Doc()
    const b = new EncryptedYjsProvider(docB, room, hub.channel(), createTestTransportCipher())
    b.connect()
    await settle(a, b)

    expect(docB.getText('content').toString()).toBe('existing content')
    a.destroy()
    b.destroy()
  })

  it('preserves both Y.Docs while offline and converges concurrent edits after reconnect', async () => {
    const hub = new ReconnectableLoopbackHub()
    const transportA = hub.channel()
    const transportB = hub.channel()
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = new EncryptedYjsProvider(docA, 'reconnect-room', transportA.channel, createTestTransportCipher())
    const b = new EncryptedYjsProvider(docB, 'reconnect-room', transportB.channel, createTestTransportCipher())
    a.connect()
    b.connect()
    await settle(a, b)

    docA.getText('content').insert(0, 'base')
    await settle(a, b)
    expect(docB.getText('content').toString()).toBe('base')

    transportA.setConnected(false)
    transportB.setConnected(false)
    expect(a.isRoomJoined()).toBe(false)
    expect(b.isRoomJoined()).toBe(false)
    docA.getText('content').insert(docA.getText('content').length, '-offline-a')
    docB.getText('content').insert(0, 'offline-b-')
    await settle(a, b)
    expect(docA.getText('content').toString()).not.toBe(docB.getText('content').toString())

    transportA.setConnected(true)
    transportB.setConnected(true)
    await settle(a, b)

    expect(a.isRoomJoined()).toBe(true)
    expect(b.isRoomJoined()).toBe(true)
    expect(docA.getText('content').toString()).toBe(docB.getText('content').toString())
    expect(docA.getText('content').toString()).toContain('offline-a')
    expect(docA.getText('content').toString()).toContain('offline-b')
    a.destroy()
    b.destroy()
  })

  it('does not echo a remote update back to the sender', async () => {
    const hub = new LoopbackHub()
    const room = 'note-3'
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = new EncryptedYjsProvider(docA, room, hub.channel(), createTestTransportCipher())
    const b = new EncryptedYjsProvider(docB, room, hub.channel(), createTestTransportCipher())
    a.connect()
    b.connect()
    await settle(a, b)

    let aUpdatesFromApply = 0
    docA.on('update', (_u, origin) => {
      if (origin === a) aUpdatesFromApply++
    })
    docB.getText('content').insert(0, 'typed on B')
    await settle(a, b)

    expect(docA.getText('content').toString()).toBe('typed on B')
    // A applied exactly the remote update(s); it must not re-broadcast them.
    expect(aUpdatesFromApply).toBeGreaterThan(0)
    a.destroy()
    b.destroy()
  })
})

type ManualProviderHarness = {
  doc: Y.Doc
  provider: EncryptedYjsProvider
  sent: CollabFrame[]
  receive(frame: CollabFrame): void
}

async function joinedManualProvider(
  room: string,
  cipher: RoomCipher = createTestTransportCipher(),
  doc = new Y.Doc(),
): Promise<ManualProviderHarness> {
  const sent: CollabFrame[] = []
  let receive: ((frame: CollabFrame) => void) | undefined
  const channel: CollabChannel = {
    isConnected: () => true,
    authorize: async () => 'fresh-capability',
    subscribe: (handler) => {
      receive = handler
      return () => {
        receive = undefined
      }
    },
    send: (frame) => sent.push(frame),
  }
  const provider = new EncryptedYjsProvider(doc, room, channel, cipher, 'initial-capability')
  provider.connect()
  const join = sent.find((frame): frame is Extract<CollabFrame, { t: 'room-join' }> => frame.t === 'room-join')
  receive?.({ t: 'room-joined', room, requestId: join?.requestId })
  await provider.flush()
  sent.length = 0
  return {
    doc,
    provider,
    sent,
    receive: (frame) => receive?.(frame),
  }
}

describe('EncryptedYjsProvider retry responder election', () => {
  const setSharedReadiness = (harnesses: ManualProviderHarness[], readyIds: Set<number>) => {
    const clientIds = harnesses.map(({ doc }) => doc.clientID)
    for (const { provider } of harnesses) {
      const awareness = provider as unknown as {
        yAwareness: { getStates(): Map<number, { awarenessData: { srnStateReady: boolean } }> }
      }
      const states = awareness.yAwareness.getStates()
      states.clear()
      for (const clientId of clientIds) {
        states.set(clientId, { awarenessData: { srnStateReady: readyIds.has(clientId) } })
      }
    }
  }

  it('elects exactly one established responder across 32 peers for one unique retry', async () => {
    const peers = await Promise.all(Array.from({ length: 32 }, () => joinedManualProvider('election-room')))
    for (const [index, peer] of peers.entries()) {
      peer.doc.getText('content').insert(0, `peer-${index}`)
      await peer.provider.flush()
      peer.sent.length = 0
    }
    setSharedReadiness(peers, new Set(peers.map(({ doc }) => doc.clientID)))
    const retry: CollabFrame = {
      t: 'yjs-retry',
      room: 'election-room',
      requestId: 'unique-retry-1',
      requesterClientId: 0xffff_ffff,
    }

    for (const peer of peers) {
      peer.receive(retry)
    }
    await Promise.all(peers.map(({ provider }) => provider.flush()))

    const responses = peers.flatMap(({ sent }) =>
      sent.filter(
        (frame) => (frame.t === 'yjs' || frame.t === 'yjs-chunk') && frame.stateRequestId === 'unique-retry-1',
      ),
    )
    expect(responses).toHaveLength(1)
    for (const peer of peers) {
      peer.provider.destroy()
    }
  })

  it('filters loading awareness peers so the sole established peer answers', async () => {
    const peers = await Promise.all(Array.from({ length: 12 }, () => joinedManualProvider('loading-election-room')))
    const established = peers[7]
    established.doc.getText('content').insert(0, 'canonical established state')
    await established.provider.flush()
    for (const peer of peers) {
      peer.sent.length = 0
    }
    setSharedReadiness(peers, new Set([established.doc.clientID]))
    for (const peer of peers) {
      if (peer !== established) {
        ;(peer.provider as unknown as { stateServingReady: boolean }).stateServingReady = false
      }
    }
    const retry: CollabFrame = {
      t: 'yjs-retry',
      room: 'loading-election-room',
      requestId: 'loading-retry',
      requesterClientId: 0xffff_ffff,
    }

    for (const peer of peers) {
      peer.receive(retry)
    }
    await Promise.all(peers.map(({ provider }) => provider.flush()))

    expect(
      established.sent.filter(
        (frame) => (frame.t === 'yjs' || frame.t === 'yjs-chunk') && frame.stateRequestId === 'loading-retry',
      ),
    ).toHaveLength(1)
    expect(
      peers
        .filter((peer) => peer !== established)
        .flatMap(({ sent }) => sent)
        .filter((frame) => frame.t === 'yjs' || frame.t === 'yjs-chunk'),
    ).toHaveLength(0)
    for (const peer of peers) {
      peer.provider.destroy()
    }
  })
})

type ProductionClaimHarness = ManualProviderHarness & {
  leaseRequestId: string
  release: jest.Mock
}

async function readyProductionClaimProvider(room: string, index: number): Promise<ProductionClaimHarness> {
  const sent: CollabFrame[] = []
  let receive: ((frame: CollabFrame) => void) | undefined
  const leaseRequestId = `production-lease-${index}`
  const release = jest.fn()
  const channel: CollabChannel = {
    isConnected: () => true,
    authorize: jest.fn(),
    subscribe: (handler) => {
      receive = handler
      return () => {
        receive = undefined
      }
    },
    send: (frame) => {
      sent.push(frame)
      if (frame.t === 'yjs' && frame.transferId) {
        receive?.({ t: 'yjs-accepted', room, transferId: frame.transferId, protocolVersion: 2 })
      }
    },
  }
  const doc = new Y.Doc()
  doc.getText('content').insert(0, `established peer ${index}`)
  const provider = new EncryptedYjsProvider(
    doc,
    room,
    channel,
    createTestTransportCipher(),
    undefined,
    leaseRequestId,
    {
      activeLease: {
        requestId: leaseRequestId,
        shouldBootstrap: true,
        protocolVersion: 2,
        maxTransferBytes: MAX_YJS_TRANSFER_BYTES,
        release,
      },
      shouldBootstrap: true,
      validateAttachment: jest.fn(() => true),
      reactivate: jest.fn(),
      onFatal: jest.fn(),
      onBootstrapRetry: jest.fn(),
    },
  )
  provider.connect()
  await settle(provider)
  sent.length = 0
  return {
    doc,
    provider,
    sent,
    receive: (frame) => receive?.(frame),
    leaseRequestId,
    release,
  }
}

describe('EncryptedYjsProvider gateway-coordinated response claims', () => {
  it.each(['all-self', 'cyclic'] as const)(
    'submits bounded claims for %s awareness and emits state only for the exact global grant',
    async (awarenessView) => {
      const room = `production-claim-${awarenessView}`
      const peers = await Promise.all(
        Array.from({ length: 16 }, (_, index) => readyProductionClaimProvider(room, index)),
      )
      try {
        for (const [index, peer] of peers.entries()) {
          const states = (
            peer.provider as unknown as {
              yAwareness: { getStates(): Map<number, { awarenessData: { srnStateReady: boolean } }> }
            }
          ).yAwareness.getStates()
          states.clear()
          const visibleClientId =
            awarenessView === 'all-self' ? peer.doc.clientID : peers[(index + 1) % peers.length].doc.clientID
          states.set(visibleClientId, { awarenessData: { srnStateReady: true } })
        }
        const stateRequestId = `state-request-${awarenessView}`
        const retry: CollabFrame = {
          t: 'yjs-retry',
          room,
          requestId: stateRequestId,
          requesterClientId: 0xffff_ffff,
        }
        for (const peer of peers) {
          peer.receive(retry)
        }
        await Promise.all(peers.map(({ provider }) => provider.flush()))

        expect(peers.flatMap(({ sent }) => sent).filter((frame) => frame.t === 'yjs-response-claim')).toHaveLength(
          peers.length,
        )
        expect(
          peers
            .flatMap(({ sent }) => sent)
            .filter(
              (frame) => (frame.t === 'yjs' || frame.t === 'yjs-chunk') && frame.stateRequestId === stateRequestId,
            ),
        ).toHaveLength(0)

        const winner = peers[5]
        peers[0].receive({
          t: 'yjs-response-granted',
          room,
          stateRequestId,
          leaseRequestId: winner.leaseRequestId,
          protocolVersion: 2,
        })
        await peers[0].provider.flush()
        expect(
          peers[0].sent.filter(
            (frame) => (frame.t === 'yjs' || frame.t === 'yjs-chunk') && frame.stateRequestId === stateRequestId,
          ),
        ).toHaveLength(0)
        winner.receive({
          t: 'yjs-response-granted',
          room,
          stateRequestId,
          leaseRequestId: winner.leaseRequestId,
          protocolVersion: 2,
        })
        await Promise.all(peers.map(({ provider }) => provider.flush()))

        const responses = peers.flatMap(({ sent }) =>
          sent.filter(
            (frame) => (frame.t === 'yjs' || frame.t === 'yjs-chunk') && frame.stateRequestId === stateRequestId,
          ),
        )
        expect(responses).toHaveLength(1)
        expect(
          winner.sent.filter(
            (frame) => (frame.t === 'yjs' || frame.t === 'yjs-chunk') && frame.stateRequestId === stateRequestId,
          ),
        ).toHaveLength(1)
      } finally {
        for (const peer of peers) {
          peer.provider.destroy()
        }
      }
    },
  )
})

describe('EncryptedYjsProvider bounded chunk transfers', () => {
  it('rejects an over-budget authenticated update before any live document observer can see it', async () => {
    const room = 'remote-preflight-budget-room'
    const doc = new Y.Doc()
    const original = 'a'.repeat(MAX_YJS_TRANSFER_BYTES - 96 * 1024)
    doc.getText('content').insert(0, original)
    const harness = await joinedManualProvider(room, createTestTransportCipher(), doc)
    const remote = new Y.Doc()
    remote.getText('content').insert(0, 'b'.repeat(128 * 1024))
    const remoteUpdate = Y.encodeStateAsUpdate(remote)
    let liveRemoteUpdates = 0
    doc.on('update', (_update, origin) => {
      if (origin === harness.provider) {
        liveRemoteUpdates += 1
      }
    })

    try {
      harness.receive({
        t: 'yjs',
        room,
        payload: Buffer.from(remoteUpdate).toString('base64'),
      })
      await harness.provider.flush()

      expect(liveRemoteUpdates).toBe(0)
      expect(doc.getText('content').toString()).toBe(original)
      expect(harness.provider.getLastSyncFailure()).toBe('encrypted-yjs-fatal')
      expect(harness.provider.isRoomJoined()).toBe(false)
    } finally {
      harness.provider.destroy()
      remote.destroy()
    }
  })

  it('fails closed when valid cumulative key and tombstone churn makes the encoded Y.Doc exceed the transfer budget', async () => {
    const harness = await joinedManualProvider('cumulative-state-budget-room')
    const churn = harness.doc.getMap<string>('deleted-keys')
    try {
      for (let batch = 0; batch < 80 && harness.provider.isRoomJoined(); batch += 1) {
        harness.doc.transact(() => {
          for (let index = 0; index < 5_000; index += 1) {
            const key = `${batch}:${index}`
            churn.set(key, 'valid-value')
            churn.delete(key)
          }
        })
        await harness.provider.flush()
      }

      expect(churn.size).toBe(0)
      expect(Y.encodeStateAsUpdate(harness.doc).byteLength).toBeGreaterThan(MAX_YJS_TRANSFER_BYTES)
      expect(harness.provider.getLastSyncFailure()).toBe('encrypted-yjs-fatal')
      expect(harness.provider.isRoomJoined()).toBe(false)
    } finally {
      harness.provider.destroy()
    }
  })

  it('converges a state larger than 512 KiB even when encrypted chunks arrive out of order', async () => {
    const sender = await joinedManualProvider('large-room')
    const receiver = await joinedManualProvider('large-room')
    const body = Array.from({ length: 700_000 }, (_, index) => String.fromCharCode(33 + (index % 80))).join('')

    sender.doc.getText('content').insert(0, body)
    await sender.provider.flush()
    const chunks = sender.sent.filter(
      (frame): frame is Extract<CollabFrame, { t: 'yjs-chunk' }> => frame.t === 'yjs-chunk',
    )
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every((frame) => frame.payload.length < 512 * 1024)).toBe(true)

    for (const frame of [...chunks].reverse()) {
      receiver.receive(frame)
    }
    await receiver.provider.flush()

    expect(receiver.doc.getText('content').toString()).toBe(body)
    expect(receiver.provider.getInboundTransferStats()).toEqual({ transfers: 0, reservedBytes: 0, reservedChunks: 0 })
    sender.provider.destroy()
    receiver.provider.destroy()
  })

  it('rejects duplicate and inconsistent transfer metadata and requests a bounded retry', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const sender = await joinedManualProvider('invalid-room')
      const receiver = await joinedManualProvider('invalid-room')
      sender.doc.getText('content').insert(0, 'x'.repeat(YJS_CHUNK_PLAINTEXT_BYTES + 1))
      await sender.provider.flush()
      const chunks = sender.sent.filter(
        (frame): frame is Extract<CollabFrame, { t: 'yjs-chunk' }> => frame.t === 'yjs-chunk',
      )

      receiver.receive(chunks[0])
      receiver.receive(chunks[0])
      await receiver.provider.flush()
      expect(receiver.provider.getLastSyncFailure()).toBe('encrypted-yjs-chunk-duplicate')
      expect(receiver.sent.filter((frame) => frame.t === 'yjs-retry')).toHaveLength(1)
      expect(receiver.provider.getInboundTransferStats()).toEqual({ transfers: 0, reservedBytes: 0, reservedChunks: 0 })

      receiver.receive({ ...chunks[1], count: chunks[1].count + 1 } as CollabFrame)
      await receiver.provider.flush()
      expect(receiver.provider.getLastSyncFailure()).toBe('encrypted-yjs-chunk-metadata-invalid')
      expect(receiver.provider.getInboundTransferStats()).toEqual({ transfers: 0, reservedBytes: 0, reservedChunks: 0 })
      sender.provider.destroy()
      receiver.provider.destroy()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('expires a missing-chunk transfer, surfaces failure, and asks a peer for fresh full state', async () => {
    jest.useFakeTimers()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const sender = await joinedManualProvider('timeout-room')
      const receiver = await joinedManualProvider('timeout-room')
      sender.doc.getText('content').insert(0, 'm'.repeat(YJS_CHUNK_PLAINTEXT_BYTES + 1))
      await sender.provider.flush()
      const first = sender.sent.find(
        (frame): frame is Extract<CollabFrame, { t: 'yjs-chunk' }> => frame.t === 'yjs-chunk',
      )!
      receiver.receive(first)
      await receiver.provider.flush()
      expect(receiver.provider.getInboundTransferStats().transfers).toBe(1)

      await jest.advanceTimersByTimeAsync(YJS_TRANSFER_TIMEOUT_MS)
      expect(receiver.provider.getLastSyncFailure()).toBe('encrypted-yjs-transfer-timeout')
      expect(receiver.sent.some((frame) => frame.t === 'yjs-retry')).toBe(true)
      expect(receiver.provider.getInboundTransferStats()).toEqual({ transfers: 0, reservedBytes: 0, reservedChunks: 0 })
      sender.provider.destroy()
      receiver.provider.destroy()
    } finally {
      consoleError.mockRestore()
      jest.useRealTimers()
    }
  })

  it('recovers a timed-out transfer by retrying a fresh full-state transfer', async () => {
    jest.useFakeTimers()
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    let sender: ManualProviderHarness | undefined
    let receiver: ManualProviderHarness | undefined
    try {
      sender = await joinedManualProvider('retry-room')
      receiver = await joinedManualProvider('retry-room')
      const body = 'retry-safe-state-'.repeat(20_000)
      sender.doc.getText('content').insert(0, body)
      await sender.provider.flush()
      const originalChunks = sender.sent.filter(
        (frame): frame is Extract<CollabFrame, { t: 'yjs-chunk' }> => frame.t === 'yjs-chunk',
      )
      expect(originalChunks.length).toBeGreaterThan(1)

      receiver.receive(originalChunks[0])
      await receiver.provider.flush()
      await jest.advanceTimersByTimeAsync(YJS_TRANSFER_TIMEOUT_MS)
      const retry = receiver.sent.find(
        (frame): frame is Extract<CollabFrame, { t: 'yjs-retry' }> => frame.t === 'yjs-retry',
      )
      expect(retry).toBeDefined()

      const sentBeforeRetry = sender.sent.length
      sender.receive(retry!)
      await sender.provider.flush()
      const replacementChunks = sender.sent
        .slice(sentBeforeRetry)
        .filter((frame): frame is Extract<CollabFrame, { t: 'yjs-chunk' }> => frame.t === 'yjs-chunk')
      expect(replacementChunks.length).toBeGreaterThan(1)
      expect(replacementChunks[0].transferId).not.toBe(originalChunks[0].transferId)

      for (const frame of [...replacementChunks].reverse()) {
        receiver.receive(frame)
      }
      await receiver.provider.flush()

      expect(receiver.doc.getText('content').toString()).toBe(body)
      expect(receiver.provider.getLastSyncFailure()).toBeUndefined()
      expect(receiver.provider.getInboundTransferStats()).toEqual({ transfers: 0, reservedBytes: 0, reservedChunks: 0 })
    } finally {
      sender?.provider.destroy()
      receiver?.provider.destroy()
      consoleError.mockRestore()
      jest.useRealTimers()
    }
  })

  it('rejects a chunk whose authenticated plaintext length contradicts its metadata', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const sender = await joinedManualProvider('wrong-size-room')
      const receiver = await joinedManualProvider('wrong-size-room')
      sender.doc.getText('content').insert(0, 'z'.repeat(YJS_CHUNK_PLAINTEXT_BYTES + 1))
      await sender.provider.flush()
      const first = sender.sent.find(
        (frame): frame is Extract<CollabFrame, { t: 'yjs-chunk' }> => frame.t === 'yjs-chunk',
      )!

      receiver.receive({ ...first, payload: Buffer.from([1]).toString('base64') })
      await receiver.provider.flush()

      expect(receiver.provider.getLastSyncFailure()).toBe('encrypted-yjs-chunk-size-invalid')
      expect(receiver.sent.filter((frame) => frame.t === 'yjs-retry')).toHaveLength(1)
      expect(receiver.provider.getInboundTransferStats()).toEqual({ transfers: 0, reservedBytes: 0, reservedChunks: 0 })
      sender.provider.destroy()
      receiver.provider.destroy()
    } finally {
      consoleError.mockRestore()
    }
  })

  it.each([
    ['index', (frame: Extract<CollabFrame, { t: 'yjs-chunk' }>) => ({ ...frame, index: 1 })],
    [
      'transfer id',
      (frame: Extract<CollabFrame, { t: 'yjs-chunk' }>) => ({ ...frame, transferId: `${frame.transferId}-tampered` }),
    ],
  ])('rejects relay-tampered %s metadata through AES-GCM authentication', async (_field, tamper) => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    let sender: ManualProviderHarness | undefined
    let receiver: ManualProviderHarness | undefined
    try {
      const roomKey = await generateTestRoomKey()
      sender = await joinedManualProvider('authenticated-metadata-room', createRoomCipher(roomKey))
      receiver = await joinedManualProvider('authenticated-metadata-room', createRoomCipher(roomKey))
      sender.doc.getText('content').insert(0, 'a'.repeat(YJS_CHUNK_PLAINTEXT_BYTES * 2))
      await sender.provider.flush()
      const first = sender.sent.find(
        (frame): frame is Extract<CollabFrame, { t: 'yjs-chunk' }> => frame.t === 'yjs-chunk' && frame.index === 0,
      )!

      receiver.receive(tamper(first))
      await receiver.provider.flush()

      expect(receiver.provider.getLastSyncFailure()).toBe('encrypted-yjs-chunk-decryption-failed')
      expect(receiver.sent.filter((frame) => frame.t === 'yjs-retry')).toHaveLength(1)
      expect(receiver.provider.getInboundTransferStats()).toEqual({ transfers: 0, reservedBytes: 0, reservedChunks: 0 })
    } finally {
      sender?.provider.destroy()
      receiver?.provider.destroy()
      consoleError.mockRestore()
    }
  })

  it('binds direct yjs ciphertext to protocol, room, frame type, and correlation metadata', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    let sender: ManualProviderHarness | undefined
    let receiver: ManualProviderHarness | undefined
    let wrongRoomReceiver: ManualProviderHarness | undefined
    try {
      const roomKey = await generateTestRoomKey()
      sender = await joinedManualProvider('direct-aad-room', createRoomCipher(roomKey))
      receiver = await joinedManualProvider('direct-aad-room', createRoomCipher(roomKey))
      wrongRoomReceiver = await joinedManualProvider('other-direct-aad-room', createRoomCipher(roomKey))
      sender.doc.getText('content').insert(0, 'authenticated direct update')
      await sender.provider.flush()
      const frame = sender.sent.find(
        (candidate): candidate is Extract<CollabFrame, { t: 'yjs' }> => candidate.t === 'yjs',
      )
      expect(frame).toBeDefined()

      receiver.receive({ ...frame!, stateRequestId: 'relay-added-correlation' })
      receiver.receive({ t: 'awareness', room: frame!.room, payload: frame!.payload })
      wrongRoomReceiver.receive({ ...frame!, room: 'other-direct-aad-room' })
      await Promise.all([receiver.provider.flush(), wrongRoomReceiver.provider.flush()])
      expect(receiver.doc.getText('content').toString()).toBe('')
      expect(wrongRoomReceiver.doc.getText('content').toString()).toBe('')

      receiver.receive(frame!)
      await receiver.provider.flush()
      expect(receiver.doc.getText('content').toString()).toBe('authenticated direct update')
    } finally {
      sender?.provider.destroy()
      receiver?.provider.destroy()
      wrongRoomReceiver?.provider.destroy()
      consoleError.mockRestore()
    }
  })

  it('bounds concurrent transfer reservations by aggregate bytes and chunk count', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const receiver = await joinedManualProvider('bounded-room')
      const payload = Buffer.alloc(YJS_CHUNK_PLAINTEXT_BYTES, 1).toString('base64')
      const count = MAX_YJS_TRANSFER_BYTES / YJS_CHUNK_PLAINTEXT_BYTES
      for (let transfer = 0; transfer < 8; transfer += 1) {
        receiver.receive({
          t: 'yjs-chunk',
          room: 'bounded-room',
          transferId: `bounded-transfer-${transfer}`,
          index: 0,
          count,
          totalBytes: MAX_YJS_TRANSFER_BYTES,
          payload,
        })
      }
      await receiver.provider.flush()

      const stats = receiver.provider.getInboundTransferStats()
      expect(stats.transfers).toBeLessThanOrEqual(2)
      expect(stats.reservedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
      expect(stats.reservedChunks).toBeLessThanOrEqual(64)
      receiver.provider.disconnect()
      expect(receiver.provider.getInboundTransferStats()).toEqual({ transfers: 0, reservedBytes: 0, reservedChunks: 0 })
      receiver.provider.destroy()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('caps shared unresolved crypto work while duplicate chunk churn is queued', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const decryptResolvers: Array<() => void> = []
    const decryptedChunk = new Uint8Array(YJS_CHUNK_PLAINTEXT_BYTES)
    const stalledCipher: RoomCipher = {
      encrypt: async (plaintext) => Buffer.from(plaintext).toString('base64'),
      decrypt: () =>
        new Promise<Uint8Array>((resolve) => {
          decryptResolvers.push(() => resolve(decryptedChunk))
        }),
    }
    let receiver: ManualProviderHarness | undefined
    try {
      receiver = await joinedManualProvider('decrypt-cap-room', stalledCipher)
      const frame = (index: number): Extract<CollabFrame, { t: 'yjs-chunk' }> => ({
        t: 'yjs-chunk',
        room: 'decrypt-cap-room',
        transferId: 'shared-stalled-transfer',
        index,
        count: MAX_YJS_TRANSFER_BYTES / YJS_CHUNK_PLAINTEXT_BYTES,
        totalBytes: MAX_YJS_TRANSFER_BYTES,
        payload: 'opaque-ciphertext',
      })

      for (let index = 0; index < MAX_ACTIVE_INBOUND_CRYPTO; index += 1) {
        receiver.receive(frame(index))
      }
      for (let index = 0; index < MAX_INBOUND_CHUNK_DECRYPTS; index += 1) {
        receiver.receive(frame(index % MAX_ACTIVE_INBOUND_CRYPTO))
      }
      await Promise.resolve()

      expect(decryptResolvers).toHaveLength(MAX_ACTIVE_INBOUND_CRYPTO)
      expect(receiver.provider.getInboundChunkDecryptCount()).toBe(MAX_ACTIVE_INBOUND_CRYPTO)
      expect(receiver.provider.getInboundCryptoStats()).toMatchObject({
        active: MAX_ACTIVE_INBOUND_CRYPTO,
        queued: MAX_INBOUND_CHUNK_DECRYPTS - MAX_ACTIVE_INBOUND_CRYPTO,
      })
      expect(receiver.provider.getInboundTransferStats()).toEqual({
        transfers: 1,
        reservedBytes: MAX_YJS_TRANSFER_BYTES,
        reservedChunks: MAX_YJS_TRANSFER_BYTES / YJS_CHUNK_PLAINTEXT_BYTES,
      })

      receiver.provider.disconnect()
      expect(receiver.provider.getInboundChunkDecryptCount()).toBe(MAX_ACTIVE_INBOUND_CRYPTO)
      expect(receiver.provider.getInboundCryptoStats().queued).toBe(0)
      for (const resolve of decryptResolvers) {
        resolve()
      }
      await receiver.provider.flush()

      expect(receiver.provider.getInboundChunkDecryptCount()).toBe(0)
      expect(receiver.provider.getPendingCount()).toBe(0)
    } finally {
      for (const resolve of decryptResolvers) {
        resolve()
      }
      await receiver?.provider.flush()
      receiver?.provider.destroy()
      consoleError.mockRestore()
    }
  })
})

async function drain(provider: EncryptedYjsProvider): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await provider.flush()
    await new Promise((r) => setTimeout(r, 0)) // let .finally() cleanups run
  }
}

describe('EncryptedYjsProvider — no memory leak', () => {
  it('the in-flight work set is BOUNDED — it does not grow with update volume', async () => {
    const hub = new LoopbackHub()

    const measure = async (updates: number): Promise<number> => {
      const doc = new Y.Doc()
      const provider = new EncryptedYjsProvider(doc, `leak-${updates}`, hub.channel(), createTestTransportCipher())
      provider.connect()
      await drain(provider)
      for (let i = 0; i < updates; i++) {
        doc.getText('content').insert(0, 'x') // awareness/doc churn
      }
      await drain(provider)
      const count = provider.getPendingCount()
      provider.destroy()
      return count
    }

    // The leak (a growing array) would leave ~updates entries retained. The fix
    // (self-cleaning Set) leaves the SAME small residual regardless of volume.
    const small = await measure(50)
    const large = await measure(5000)
    expect(large).toBe(small)
    expect(large).toBeLessThan(5)
  })

  it('every awareness heartbeat interval created is cleared on terminal destroy (no timer leak)', () => {
    const hub = new LoopbackHub()
    const setSpy = jest.spyOn(globalThis, 'setInterval')
    const clearSpy = jest.spyOn(globalThis, 'clearInterval')
    try {
      const setBefore = setSpy.mock.calls.length
      const clearBefore = clearSpy.mock.calls.length

      for (let i = 0; i < 200; i++) {
        const p = new EncryptedYjsProvider(new Y.Doc(), `cycle-${i}`, hub.channel(), createTestTransportCipher())
        p.connect()
        p.destroy()
      }

      const created = setSpy.mock.calls.length - setBefore
      const cleared = clearSpy.mock.calls.length - clearBefore
      expect(created).toBeGreaterThan(0) // the awareness heartbeat
      expect(cleared).toBe(created) // every one torn down — none leaked
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })
})

const hasSubtle = !!(globalThis as { crypto?: Crypto }).crypto?.subtle
const maybe = hasSubtle ? describe : describe.skip

maybe('RoomCrypto (AES-GCM, requires WebCrypto)', () => {
  it('round-trips an encrypted yjs update', async () => {
    const key = await generateTestRoomKey()
    const cipher = createRoomCipher(key)
    const plaintext = Y.encodeStateAsUpdate(
      ((): Y.Doc => {
        const d = new Y.Doc()
        d.getText('content').insert(0, 'secret note body')
        return d
      })(),
    )
    const payload = await cipher.encrypt(plaintext)
    expect(typeof payload).toBe('string')
    const back = await cipher.decrypt(payload)
    expect(Array.from(back)).toEqual(Array.from(plaintext))
  })

  it('two collaborators with the room key can decrypt while an outsider cannot', async () => {
    const sharedKey = await generateTestRoomKey()
    const cipher1 = createRoomCipher(sharedKey)
    const cipher2 = createRoomCipher(sharedKey)
    const outsiderCipher = createRoomCipher(await generateTestRoomKey())

    const msg = new TextEncoder().encode('hello')
    const payload = await cipher1.encrypt(msg)
    expect(Array.from(await cipher2.decrypt(payload))).toEqual(Array.from(msg))
    await expect(outsiderCipher.decrypt(payload)).rejects.toBeDefined()
  })

  it('authenticates optional protocol metadata as AES-GCM additional data', async () => {
    const cipher = createRoomCipher(await generateTestRoomKey())
    const plaintext = new TextEncoder().encode('bound chunk')
    const metadata = new TextEncoder().encode('room|transfer|0|2|131073')
    const payload = await cipher.encrypt(plaintext, metadata)

    await expect(cipher.decrypt(payload, metadata)).resolves.toEqual(plaintext)
    await expect(cipher.decrypt(payload, new TextEncoder().encode('room|transfer|1|2|131073'))).rejects.toBeDefined()
    await expect(cipher.decrypt(payload)).rejects.toBeDefined()
  })
})
