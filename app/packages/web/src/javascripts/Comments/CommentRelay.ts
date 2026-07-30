import { WebApplication } from '@/Application/WebApplication'
import { createGatewayCollabChannel } from '@/Components/SuperEditor/Collaboration/GatewayCollabChannel'
import { createRoomCipher, RoomCipher } from '@/Components/SuperEditor/Collaboration/RoomCrypto'
import type { CollabChannel, CollabFrame } from '@/Components/SuperEditor/Collaboration/CollabChannel'
import { getSuperCollaborationAvailability } from '@/Components/SuperEditor/Collaboration/CollaborationAvailability'
import { normalizeComment, NoteComment } from './comments'

/**
 * Standard Red Notes: realtime broadcast of note comments over the existing
 * authenticated gateway relay.
 *
 * Reuses the SAME transport (the single live WebSocket via WebSocketsService)
 * and the SAME end-to-end encryption boundary as the collaborative yjs editor:
 * every comment is JSON-encoded and encrypted with a non-extractable AES-GCM
 * key derived from client-only vault key material. Public vault identifiers are
 * never accepted as key material.
 *
 * The centralized collaboration release gate is checked before a channel is
 * constructed. Until a real client-only key is wired, comments remain persisted
 * E2E in the note's appData and reach peers through normal HTTP sync.
 */
export class CommentRelay {
  private readonly channel: CollabChannel
  private readonly cipher: RoomCipher
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly application: WebApplication,
    private readonly room: string,
    roomKey: CryptoKey,
    private readonly onRemoteComment: (comment: NoteComment) => void,
  ) {
    const availability = getSuperCollaborationAvailability()
    if (!availability.available) {
      throw new Error(availability.reason)
    }

    // Validate the key before creating or joining a network channel.
    this.cipher = createRoomCipher(roomKey)
    this.channel = createGatewayCollabChannel(this.application)
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
      const plaintext = new TextEncoder().encode(JSON.stringify(comment))
      const payload = await this.cipher.encrypt(plaintext)
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
      const bytes = await this.cipher.decrypt(payload)
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
