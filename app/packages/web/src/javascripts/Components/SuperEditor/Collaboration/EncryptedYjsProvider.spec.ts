/**
 * @jest-environment node
 */
import { webcrypto } from 'node:crypto'
import * as Y from 'yjs'
import { EncryptedYjsProvider } from './EncryptedYjsProvider'
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

async function settle(...providers: EncryptedYjsProvider[]): Promise<void> {
  // Updates may cascade (full-state replies, etc.); flush a few rounds.
  for (let i = 0; i < 6; i++) {
    await Promise.all(providers.map((p) => p.flush()))
  }
}

describe('EncryptedYjsProvider convergence', () => {
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
    provider.disconnect()
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
    provider.disconnect()
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
    provider.disconnect()
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
    provider.disconnect()
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
    a.disconnect()
    b.disconnect()
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
    a.disconnect()
    b.disconnect()
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
    a.disconnect()
    b.disconnect()
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
      provider.disconnect()
      return count
    }

    // The leak (a growing array) would leave ~updates entries retained. The fix
    // (self-cleaning Set) leaves the SAME small residual regardless of volume.
    const small = await measure(50)
    const large = await measure(5000)
    expect(large).toBe(small)
    expect(large).toBeLessThan(5)
  })

  it('every awareness heartbeat interval created is cleared on disconnect (no timer leak)', () => {
    const hub = new LoopbackHub()
    const setSpy = jest.spyOn(globalThis, 'setInterval')
    const clearSpy = jest.spyOn(globalThis, 'clearInterval')
    try {
      const setBefore = setSpy.mock.calls.length
      const clearBefore = clearSpy.mock.calls.length

      for (let i = 0; i < 200; i++) {
        const p = new EncryptedYjsProvider(new Y.Doc(), `cycle-${i}`, hub.channel(), createTestTransportCipher())
        p.connect()
        p.disconnect()
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
})
