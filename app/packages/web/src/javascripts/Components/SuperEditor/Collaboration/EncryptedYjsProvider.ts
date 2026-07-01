import * as Y from 'yjs'
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness'
import type { Provider } from '@lexical/yjs'
import type { CollabChannel, CollabFrame } from './CollabChannel'
import type { RoomCipher } from './RoomCrypto'

type Listener = (...args: never[]) => void

/**
 * A yjs provider that syncs a Y.Doc over the gateway relay, encrypting every
 * update end-to-end. Implements the @lexical/yjs `Provider` interface so it can
 * drive @lexical/react's CollaborationPlugin.
 *
 * Sync model (no central server, peer-to-peer over the relay):
 *  - local doc change  -> encrypt incremental update -> broadcast `yjs` frame;
 *  - inbound `yjs`     -> decrypt -> Y.applyUpdate(origin=this) (no echo back);
 *  - a peer joining    -> gateway sends us `room-sync` -> we reply with the FULL
 *                         encoded state so the newcomer converges (yjs updates
 *                         are commutative + idempotent, so full-state is safe).
 * Awareness (cursors/presence) rides the same channel as `awareness` frames.
 */
export class EncryptedYjsProvider implements Provider {
  public readonly awareness: Provider['awareness']
  private readonly yAwareness: Awareness
  private readonly listeners: Record<string, Set<Listener>> = {}
  private unsubscribe: (() => void) | null = null
  private connected = false
  // In-flight encrypt/send/decrypt work. Entries REMOVE THEMSELVES on settle so
  // this never grows unbounded over a long editing session (awareness fires on
  // every cursor move); flush() still works for tests by awaiting the live set.
  private readonly pending = new Set<Promise<void>>()

  constructor(
    public readonly doc: Y.Doc,
    private readonly room: string,
    private readonly channel: CollabChannel,
    private readonly cipher: RoomCipher,
  ) {
    this.yAwareness = new Awareness(doc)
    // y-protocols Awareness is structurally compatible with lexical's
    // ProviderAwareness at runtime; the field type differs only in the UserState
    // shape it carries.
    this.awareness = this.yAwareness as unknown as Provider['awareness']
  }

  // --- @lexical/yjs Provider event emitter -------------------------------

  on(type: string, cb: Listener): void {
    ;(this.listeners[type] ??= new Set()).add(cb)
  }

  off(type: string, cb: Listener): void {
    this.listeners[type]?.delete(cb)
  }

  private emit(type: string, ...args: never[]): void {
    this.listeners[type]?.forEach((cb) => cb(...args))
  }

  // --- lifecycle ---------------------------------------------------------

  connect(): void {
    if (this.connected) return
    this.connected = true

    this.doc.on('update', this.onLocalDocUpdate)
    this.yAwareness.on('update', this.onLocalAwarenessUpdate)
    this.unsubscribe = this.channel.subscribe(this.onFrame)

    // The gateway requires a signed capability on room-join. Fetch it, then join.
    // If authorization fails (no access / offline), we simply never join the relay
    // room — local editing still works; we just don't receive/send remote frames.
    void this.joinWithCapability()
    // Broadcast our current state so peers already in the room merge us in (no-op
    // until/unless we actually joined; the room-sync handshake recovers state).
    void this.broadcastFullState()
    // The plugin waits for `sync` before it stops showing a loading state.
    queueMicrotask(() => this.emit('sync', true as never))
  }

  private async joinWithCapability(): Promise<void> {
    let capability: string | undefined
    try {
      capability = await this.channel.authorize(this.room)
    } catch {
      capability = undefined
    }
    // A concurrent disconnect() may have run while we awaited; don't join if so.
    if (!this.connected) return
    if (!capability) {
      // Denied / unavailable: do not attempt to join. The gateway would reject a
      // capability-less join anyway; skipping avoids a pointless room-denied round trip.
      return
    }
    this.channel.send({ t: 'room-join', room: this.room, cap: capability })
  }

  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    removeAwarenessStates(this.yAwareness, [this.doc.clientID], 'disconnect')
    this.channel.send({ t: 'room-leave', room: this.room })
    this.doc.off('update', this.onLocalDocUpdate)
    this.yAwareness.off('update', this.onLocalAwarenessUpdate)
    this.yAwareness.destroy() // clears the awareness heartbeat interval
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  /** Count of in-flight encrypt/send/decrypt operations (for tests/leak guards). */
  getPendingCount(): number {
    return this.pending.size
  }

  /** Resolves once all in-flight encrypt/send work settles (used by tests). */
  async flush(): Promise<void> {
    while (this.pending.size) {
      await Promise.all([...this.pending])
    }
  }

  // --- outbound ----------------------------------------------------------

  private readonly onLocalDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return // came from applying a remote update; don't loop
    this.track(
      this.cipher.encrypt(update).then((payload) => {
        this.channel.send({ t: 'yjs', room: this.room, payload })
      }),
    )
  }

  private readonly onLocalAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === 'remote') return
    const changed = [...changes.added, ...changes.updated, ...changes.removed]
    const update = encodeAwarenessUpdate(this.yAwareness, changed)
    this.track(
      this.cipher.encrypt(update).then((payload) => {
        this.channel.send({ t: 'awareness', room: this.room, payload })
      }),
    )
  }

  private async broadcastFullState(): Promise<void> {
    const payload = await this.cipher.encrypt(Y.encodeStateAsUpdate(this.doc))
    this.channel.send({ t: 'yjs', room: this.room, payload })
  }

  // --- inbound -----------------------------------------------------------

  private readonly onFrame = (frame: CollabFrame): void => {
    if (frame.room !== this.room) return
    switch (frame.t) {
      case 'room-sync':
        this.track(this.broadcastFullState())
        break
      case 'yjs':
        this.track(
          this.cipher.decrypt(frame.payload).then((update) => {
            Y.applyUpdate(this.doc, update, this)
          }),
        )
        break
      case 'awareness':
        this.track(
          this.cipher.decrypt(frame.payload).then((update) => {
            applyAwarenessUpdate(this.yAwareness, update, 'remote')
          }),
        )
        break
    }
  }

  private track(p: Promise<void>): void {
    const settled = p
      .catch((err) => console.error('[collab] frame error', err))
      .finally(() => this.pending.delete(settled))
    this.pending.add(settled)
  }
}
