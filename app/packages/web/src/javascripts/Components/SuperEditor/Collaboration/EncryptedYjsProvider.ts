import * as Y from 'yjs'
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness'
import type { Provider } from '@lexical/yjs'
import { createCollaborationRequestId, type CollabChannel, type CollabFrame } from './CollabChannel'
import type { RoomCipher } from './RoomCrypto'

type Listener = (...args: never[]) => void

/**
 * A yjs provider that syncs a Y.Doc over the gateway relay through the supplied
 * RoomCipher. The product entry point supplies a non-extractable key derived
 * from client-only shared-vault key material and fails closed before mounting
 * this provider when that source is unavailable. Implements the @lexical/yjs
 * `Provider` interface so it can drive @lexical/react's CollaborationPlugin.
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
  private joined = false
  private readonly joinRequestId: string
  private initialCapabilityConsumed = false
  private joining = false
  // In-flight encrypt/send/decrypt work. Entries REMOVE THEMSELVES on settle so
  // this never grows unbounded over a long editing session (awareness fires on
  // every cursor move); flush() still works for tests by awaiting the live set.
  private readonly pending = new Set<Promise<void>>()

  constructor(
    public readonly doc: Y.Doc,
    private readonly room: string,
    private readonly channel: CollabChannel,
    private readonly cipher: RoomCipher,
    private readonly initialCapability?: string,
    leaseRequestId?: string,
  ) {
    this.joinRequestId = leaseRequestId ?? createCollaborationRequestId()
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
    if (this.connected) {
      return
    }
    this.connected = true

    this.doc.on('update', this.onLocalDocUpdate)
    this.yAwareness.on('update', this.onLocalAwarenessUpdate)
    this.unsubscribe = this.channel.subscribe(this.onFrame)

    // The gateway requires a signed exact-note capability. No yjs or awareness
    // payload is sent until it acknowledges this specific join request.
    void this.joinWithCapability()
  }

  private async joinWithCapability(): Promise<void> {
    if (this.joining) {
      return
    }
    this.joining = true
    try {
      let capability: string | undefined
      if (!this.initialCapabilityConsumed) {
        capability = this.initialCapability
        this.initialCapabilityConsumed = true
      }
      if (!capability) {
        try {
          capability = await this.channel.authorize(this.room)
        } catch {
          capability = undefined
        }
      }
      // A concurrent disconnect() may have run while we awaited; don't join if so.
      if (!this.connected || !capability) {
        // Denied / unavailable: do not attempt to join. The gateway would reject a
        // capability-less join anyway; skipping avoids a pointless room-denied round trip.
        return
      }
      try {
        this.channel.send({
          t: 'room-join',
          room: this.room,
          cap: capability,
          requestId: this.joinRequestId,
          role: 'editor',
        })
      } catch {
        // A reconnect race may close the transport between capability minting
        // and send. Stay fail-closed; durable encrypted sync remains available.
      }
    } finally {
      this.joining = false
    }
  }

  disconnect(): void {
    if (!this.connected) {
      return
    }
    this.connected = false
    this.joined = false
    removeAwarenessStates(this.yAwareness, [this.doc.clientID], 'disconnect')
    this.doc.off('update', this.onLocalDocUpdate)
    this.yAwareness.off('update', this.onLocalAwarenessUpdate)
    // Clears the awareness heartbeat interval.
    this.yAwareness.destroy()
    try {
      this.unsubscribe?.()
    } catch {
      // Local listener cleanup must not make editor teardown throw.
    }
    this.unsubscribe = null
    try {
      this.channel.send({ t: 'room-leave', room: this.room, requestId: this.joinRequestId })
    } catch {
      // Offline teardown is best-effort; capability expiry is the backstop.
    }
  }

  /** Count of in-flight encrypt/send/decrypt operations (for tests/leak guards). */
  getPendingCount(): number {
    return this.pending.size
  }

  isRoomJoined(): boolean {
    return this.joined
  }

  /** Resolves once all in-flight encrypt/send work settles (used by tests). */
  async flush(): Promise<void> {
    while (this.pending.size) {
      await Promise.all([...this.pending])
    }
  }

  // --- outbound ----------------------------------------------------------

  private readonly onLocalDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Remote updates are applied with this provider as their origin; do not echo.
    if (origin === this || !this.connected || !this.joined) {
      return
    }
    this.track(
      this.cipher.encrypt(update).then((payload) => {
        if (this.connected && this.joined) {
          this.channel.send({ t: 'yjs', room: this.room, payload })
        }
      }),
    )
  }

  private readonly onLocalAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === 'remote' || !this.connected || !this.joined) {
      return
    }
    const changed = [...changes.added, ...changes.updated, ...changes.removed]
    const update = encodeAwarenessUpdate(this.yAwareness, changed)
    this.track(
      this.cipher.encrypt(update).then((payload) => {
        if (this.connected && this.joined) {
          this.channel.send({ t: 'awareness', room: this.room, payload })
        }
      }),
    )
  }

  private async broadcastFullState(): Promise<void> {
    if (!this.connected || !this.joined) {
      return
    }
    const payload = await this.cipher.encrypt(Y.encodeStateAsUpdate(this.doc))
    if (this.connected && this.joined) {
      this.channel.send({ t: 'yjs', room: this.room, payload })
    }
  }

  // --- inbound -----------------------------------------------------------

  private readonly onFrame = (frame: CollabFrame): void => {
    if (frame.room !== this.room) {
      return
    }
    switch (frame.t) {
      case 'room-joined':
        if (!this.connected || frame.requestId !== this.joinRequestId) {
          break
        }
        this.joined = true
        this.track(this.broadcastFullState())
        queueMicrotask(() => {
          if (this.connected && this.joined) {
            this.emit('sync', true as never)
          }
        })
        break
      case 'room-denied':
        if (frame.requestId === this.joinRequestId) {
          const shouldReauthorize = this.joined
          this.joined = false
          this.emit('sync', false as never)
          if (shouldReauthorize && this.connected) {
            void this.joinWithCapability()
          }
        }
        break
      case 'room-sync':
        if (this.joined) {
          this.track(this.broadcastFullState())
        }
        break
      case 'yjs':
        if (!this.joined) {
          break
        }
        this.track(
          this.cipher.decrypt(frame.payload).then((update) => {
            if (this.connected && this.joined) {
              Y.applyUpdate(this.doc, update, this)
            }
          }),
        )
        break
      case 'awareness':
        if (!this.joined) {
          break
        }
        this.track(
          this.cipher.decrypt(frame.payload).then((update) => {
            if (this.connected && this.joined) {
              applyAwarenessUpdate(this.yAwareness, update, 'remote')
            }
          }),
        )
        break
    }
  }

  private track(p: Promise<void>): void {
    const settled = p
      // Do not log thrown objects: a custom cipher/channel error could include
      // plaintext, ciphertext, key material, or a capability in its message.
      .catch(() => console.error('[collab] encrypted frame processing failed'))
      .finally(() => this.pending.delete(settled))
    this.pending.add(settled)
  }
}
