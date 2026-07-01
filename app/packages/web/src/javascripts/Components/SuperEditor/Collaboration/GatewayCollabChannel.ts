import { WebApplication } from '@/Application/WebApplication'
import type { CollabChannel, CollabFrame } from './CollabChannel'

/**
 * Backs a CollabChannel with the app's existing authenticated gateway socket
 * (WebSocketsService). Reuses the single live connection rather than opening a
 * second socket per note.
 */
export function createGatewayCollabChannel(application: WebApplication): CollabChannel {
  return {
    isConnected: () => application.sockets.isWebSocketConnectionOpen(),
    send: (frame: CollabFrame) => application.sockets.sendCollaborationFrame(frame),
    subscribe: (handler: (frame: CollabFrame) => void) =>
      application.sockets.onCollaborationFrame(handler as (frame: CollabFrame) => void),
    // Standard Red Notes: fetch the gateway-required room capability for this note.
    authorize: (room: string) => application.sockets.authorizeCollaborationRoom(room),
  }
}
