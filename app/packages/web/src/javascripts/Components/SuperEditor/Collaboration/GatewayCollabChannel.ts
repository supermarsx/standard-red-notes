import { WebApplication } from '@/Application/WebApplication'
import { WebSocketsServiceEvent } from '@standardnotes/snjs'
import type { CollabChannel, CollabFrame } from './CollabChannel'

/**
 * Backs a CollabChannel with the app's existing authenticated gateway socket
 * (WebSocketsService). Reuses the single live connection rather than opening a
 * second socket per note. Editor and comment consumers carry stable request IDs;
 * the gateway treats those as logical leases on one physical socket membership,
 * so one consumer can leave or renew without invalidating the other.
 */
export function createGatewayCollabChannel(application: WebApplication): CollabChannel {
  return {
    isConnected: () => application.sockets.isWebSocketConnectionOpen(),
    send: (frame: CollabFrame) => application.sockets.sendCollaborationFrame(frame),
    subscribe: (handler: (frame: CollabFrame) => void) =>
      application.sockets.onCollaborationFrame(handler as (frame: CollabFrame) => void),
    subscribeStatus: (handler) =>
      application.sockets.addEventObserver((event) => {
        if (event === WebSocketsServiceEvent.WebSocketDidOpen) {
          handler(true)
        } else if (event === WebSocketsServiceEvent.WebSocketDidClose) {
          handler(false)
        }
        return Promise.resolve()
      }),
    // Standard Red Notes: fetch the gateway-required room capability for this note.
    authorize: async (room: string, leaseRequestId?: string, bootstrapChallenge?: string) =>
      (
        await (leaseRequestId || bootstrapChallenge
          ? application.sockets.authorizeCollaborationRoom(room, leaseRequestId, bootstrapChallenge)
          : application.sockets.authorizeCollaborationRoom(room))
      )?.capability,
  }
}
