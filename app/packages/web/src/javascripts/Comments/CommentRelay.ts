import { WebApplication } from '@/Application/WebApplication'
import { createGatewayCollabChannel } from '@/Components/SuperEditor/Collaboration/GatewayCollabChannel'
import { createRoomCipher, deriveRoomKey, RoomCipher } from '@/Components/SuperEditor/Collaboration/RoomCrypto'
import type { CollabFrame } from '@/Components/SuperEditor/Collaboration/CollabChannel'
import { normalizeComment, NoteComment } from './comments'

/**
 * Standard Red Notes: realtime broadcast of note comments over the existing
 * authenticated gateway relay.
 *
 * Reuses the SAME transport (the single live WebSocket via WebSocketsService) and
 * the SAME end-to-end encryption as the collaborative yjs editor: every comment
 * is JSON-encoded and encrypted with a per-room AES-GCM key derived from a shared
 * secret (the vault's key-system identifier) + the note uuid. The gateway only
 * ever relays an opaque base64 blob, so comment text is never exposed.
 *
 * Degrades gracefully: if the socket is closed the send is a no-op — the comment
 * is still persisted E2E in the note's appData and reaches peers via normal HTTP
 * sync. This channel only makes the delivery LIVE when peers are connected.
 */
export class CommentRelay {
  private readonly channel = createGatewayCollabChannel(this.application)
  private cipher: Promise<RoomCipher>
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly application: WebApplication,
    private readonly room: string,
    sharedSecret: string,
    private readonly onRemoteComment: (comment: NoteComment) => void,
  ) {
    this.cipher = deriveRoomKey(sharedSecret, room).then(createRoomCipher)
    // Join the room so the gateway routes peer comment frames to us. The yjs
    // provider may also join the same room; duplicate joins are idempotent.
    this.channel.send({ t: 'room-join', room })
    this.unsubscribe = this.channel.subscribe(this.handleFrame)
  }

  /** Encrypt + broadcast a comment to peers with this note open. No-op if offline. */
  async broadcast(comment: NoteComment): Promise<void> {
    if (!this.channel.isConnected()) {
      return
    }
    try {
      const cipher = await this.cipher
      const plaintext = new TextEncoder().encode(JSON.stringify(comment))
      const payload = await cipher.encrypt(plaintext)
      this.channel.send({ t: 'comment', room: this.room, payload })
    } catch (error) {
      console.error('[comments] broadcast failed', error)
    }
  }

  private readonly handleFrame = (frame: CollabFrame): void => {
    if (frame.t !== 'comment' || frame.room !== this.room) {
      return
    }
    void this.decryptAndDeliver(frame.payload)
  }

  private async decryptAndDeliver(payload: string): Promise<void> {
    try {
      const cipher = await this.cipher
      const bytes = await cipher.decrypt(payload)
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
      const comment = normalizeComment(parsed)
      if (comment) {
        this.onRemoteComment(comment)
      }
    } catch (error) {
      console.error('[comments] receive failed', error)
    }
  }

  destroy(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
  }
}
