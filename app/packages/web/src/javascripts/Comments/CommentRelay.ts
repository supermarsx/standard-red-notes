import { WebApplication } from '@/Application/WebApplication'
import { createGatewayCollabChannel } from '@/Components/SuperEditor/Collaboration/GatewayCollabChannel'
import { createRoomCipher, RoomCipher } from '@/Components/SuperEditor/Collaboration/RoomCrypto'
import {
  createCollaborationRequestId,
  type CollabChannel,
  type CollabFrame,
} from '@/Components/SuperEditor/Collaboration/CollabChannel'
import { getSuperCollaborationAvailability } from '@/Components/SuperEditor/Collaboration/CollaborationAvailability'
import { normalizeComment, NoteComment } from './comments'

export type CommentRelayEvent =
  { version: 1; operation: 'upsert'; comment: NoteComment } | { version: 1; operation: 'remove'; commentId: string }

/**
 * Realtime comment events share the editor's authenticated gateway room and
 * exact same per-note AES key. The relay sees only AES-GCM ciphertext.
 */
export class CommentRelay {
  private readonly channel: CollabChannel
  private readonly cipher: RoomCipher
  private readonly requestId: string
  private unsubscribe: (() => void) | null = null
  private joined = false
  private destroyed = false
  private joining = false
  private joinRequested = false

  constructor(
    private readonly application: WebApplication,
    private readonly room: string,
    roomKey: CryptoKey,
    capability: string,
    private readonly onRemoteEvent: (event: CommentRelayEvent) => void,
  ) {
    const availability = getSuperCollaborationAvailability()
    if (!availability.available) {
      throw new Error(availability.reason)
    }
    if (!room || !capability) {
      throw new Error('Comments require an exact-note collaboration capability.')
    }

    // Validate the key before creating or joining a network channel.
    this.cipher = createRoomCipher(roomKey)
    this.channel = createGatewayCollabChannel(this.application)
    this.requestId = createCollaborationRequestId()
    this.unsubscribe = this.channel.subscribe(this.handleFrame)
    try {
      this.joinRequested = true
      this.channel.send({
        t: 'room-join',
        room,
        cap: capability,
        requestId: this.requestId,
        role: 'comment',
      })
    } catch (error) {
      this.joinRequested = false
      this.destroyed = true
      try {
        this.unsubscribe?.()
      } catch {
        // Preserve the transport's join error while still abandoning the relay.
      }
      this.unsubscribe = null
      throw error
    }
  }

  isRoomJoined(): boolean {
    return this.joined
  }

  /** Backward-compatible shorthand for broadcasting an upsert. */
  async broadcast(comment: NoteComment): Promise<void> {
    await this.broadcastUpsert(comment)
  }

  async broadcastUpsert(comment: NoteComment): Promise<void> {
    await this.broadcastEvent({ version: 1, operation: 'upsert', comment })
  }

  async broadcastRemove(commentId: string): Promise<void> {
    if (!commentId) {
      return
    }
    await this.broadcastEvent({ version: 1, operation: 'remove', commentId })
  }

  private async broadcastEvent(event: CommentRelayEvent): Promise<void> {
    // Never queue plaintext or emit before the server acknowledges this exact
    // authorized join. Persistence + ordinary encrypted sync remain the fallback.
    if (this.destroyed || !this.joined || !this.channel.isConnected()) {
      return
    }
    try {
      const plaintext = new TextEncoder().encode(JSON.stringify(event))
      const payload = await this.cipher.encrypt(plaintext)
      if (!this.destroyed && this.joined && this.channel.isConnected()) {
        this.channel.send({ t: 'comment', room: this.room, payload })
      }
    } catch {
      // Fail closed without logging plaintext, keys, tokens, or payloads.
    }
  }

  private readonly handleFrame = (frame: CollabFrame): void => {
    if (frame.room !== this.room) {
      return
    }
    if (frame.t === 'room-joined' && frame.requestId === this.requestId && this.joinRequested) {
      this.joinRequested = false
      this.joined = true
      return
    }
    if (frame.t === 'room-denied' && frame.requestId === this.requestId) {
      this.joinRequested = false
      const shouldReauthorize = this.joined
      this.joined = false
      if (shouldReauthorize) {
        void this.reauthorizeAndJoin()
      }
      return
    }
    if (frame.t === 'comment' && this.joined) {
      void this.decryptAndDeliver(frame.payload)
    }
  }

  private async reauthorizeAndJoin(): Promise<void> {
    if (this.destroyed || this.joining) {
      return
    }
    try {
      if (!this.channel.isConnected()) {
        return
      }
    } catch {
      return
    }
    this.joining = true
    try {
      let capability: string | undefined
      try {
        capability = await this.channel.authorize(this.room)
      } catch {
        capability = undefined
      }
      if (!this.destroyed && capability && this.channel.isConnected()) {
        try {
          this.joinRequested = true
          this.channel.send({
            t: 'room-join',
            room: this.room,
            cap: capability,
            requestId: this.requestId,
            role: 'comment',
          })
        } catch {
          this.joinRequested = false
          this.joined = false
          // A reconnect race can close the transport between the connected
          // check and send. Remain unjoined and use durable encrypted sync.
        }
      }
    } catch {
      this.joinRequested = false
      this.joined = false
    } finally {
      this.joining = false
    }
  }

  private async decryptAndDeliver(payload: string): Promise<void> {
    try {
      const bytes = await this.cipher.decrypt(payload)
      if (this.destroyed || !this.joined) {
        return
      }
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<CommentRelayEvent>
      if (parsed.version !== 1) {
        return
      }
      if (parsed.operation === 'upsert') {
        const comment = normalizeComment(parsed.comment)
        if (comment) {
          this.onRemoteEvent({ version: 1, operation: 'upsert', comment })
        }
      } else if (parsed.operation === 'remove' && typeof parsed.commentId === 'string' && parsed.commentId) {
        this.onRemoteEvent({ version: 1, operation: 'remove', commentId: parsed.commentId })
      }
    } catch {
      // Wrong/rotated keys and malformed ciphertext are intentionally ignored.
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    this.joined = false
    this.joinRequested = false
    try {
      this.channel.send({ t: 'room-leave', room: this.room, requestId: this.requestId })
    } catch {
      // Offline teardown is best-effort; capability expiry is the backstop.
    }
    try {
      this.unsubscribe?.()
    } catch {
      // A transport cleanup callback must not make component teardown throw.
    }
    this.unsubscribe = null
  }
}
