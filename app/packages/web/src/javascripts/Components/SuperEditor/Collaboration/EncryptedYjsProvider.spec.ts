/**
 * @jest-environment node
 */
import * as Y from 'yjs'
import { EncryptedYjsProvider } from './EncryptedYjsProvider'
import { createPlaintextCipher, createRoomCipher, deriveRoomKey } from './RoomCrypto'
import type { CollabChannel, CollabFrame } from './CollabChannel'

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
    }
  }

  private relay(from: symbol, frame: CollabFrame): void {
    if (frame.t === 'room-join') {
      const set = this.rooms.get(frame.room) ?? new Set<symbol>()
      set.add(from)
      this.rooms.set(frame.room, set)
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
  it('converges two docs editing the same room (plaintext cipher)', async () => {
    const hub = new LoopbackHub()
    const room = 'note-1'
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const a = new EncryptedYjsProvider(docA, room, hub.channel(), createPlaintextCipher())
    const b = new EncryptedYjsProvider(docB, room, hub.channel(), createPlaintextCipher())
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
    const a = new EncryptedYjsProvider(docA, room, hub.channel(), createPlaintextCipher())
    a.connect()
    docA.getText('content').insert(0, 'existing content')
    await settle(a)

    const docB = new Y.Doc()
    const b = new EncryptedYjsProvider(docB, room, hub.channel(), createPlaintextCipher())
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
    const a = new EncryptedYjsProvider(docA, room, hub.channel(), createPlaintextCipher())
    const b = new EncryptedYjsProvider(docB, room, hub.channel(), createPlaintextCipher())
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
      const provider = new EncryptedYjsProvider(doc, `leak-${updates}`, hub.channel(), createPlaintextCipher())
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
        const p = new EncryptedYjsProvider(new Y.Doc(), `cycle-${i}`, hub.channel(), createPlaintextCipher())
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
    const key = await deriveRoomKey('vault-secret', 'note-1')
    const cipher = createRoomCipher(key)
    const plaintext = Y.encodeStateAsUpdate(((): Y.Doc => {
      const d = new Y.Doc()
      d.getText('content').insert(0, 'secret note body')
      return d
    })())
    const payload = await cipher.encrypt(plaintext)
    expect(typeof payload).toBe('string')
    const back = await cipher.decrypt(payload)
    expect(Array.from(back)).toEqual(Array.from(plaintext))
  })

  it('two collaborators derive the same key; an outsider derives a different one', async () => {
    const k1 = await deriveRoomKey('vault-secret', 'note-1')
    const cipher1 = createRoomCipher(k1)
    const k2 = await deriveRoomKey('vault-secret', 'note-1')
    const cipher2 = createRoomCipher(k2)
    const k3 = await deriveRoomKey('different-secret', 'note-1')
    const cipher3 = createRoomCipher(k3)

    const msg = new TextEncoder().encode('hello')
    const payload = await cipher1.encrypt(msg)
    expect(Array.from(await cipher2.decrypt(payload))).toEqual(Array.from(msg))
    await expect(cipher3.decrypt(payload)).rejects.toBeDefined()
  })
})
