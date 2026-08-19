import { WebApplication } from '@/Application/WebApplication'
import { WebSocketsServiceEvent } from '@standardnotes/snjs'
import { COLLABORATION_PROTOCOL_VERSION, type CollabChannel, type CollabFrame } from './CollabChannel'
import { isValidCollaborationRoomEpoch } from './RoomCrypto'

type EpochBoundAuthorizer = (
  room: string,
  leaseRequestId: string | undefined,
  bootstrapChallenge: string | undefined,
  expectedRoomEpoch: string,
) => Promise<unknown>

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
    // WebSocketsService is the protected shared integration seam. Protocol-v3
    // frames remain opaque JSON on the wire; its declared frame union is
    // updated by the central transport integrator alongside the gateway.
    send: (frame: CollabFrame) => application.sockets.sendCollaborationFrame(frame as never),
    subscribe: (handler: (frame: CollabFrame) => void) => application.sockets.onCollaborationFrame(handler as never),
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
    authorizeEpochBound: async (room, expectedRoomEpoch, leaseRequestId, bootstrapChallenge) => {
      if (!isValidCollaborationRoomEpoch(expectedRoomEpoch)) {
        return undefined
      }
      // Protected shared seam: the central WebSocketsService/worker transport
      // adds this fourth argument and validates the echoed epoch before this
      // client adapter can adopt the capability.
      const authorization = await (application.sockets.authorizeCollaborationRoom as unknown as EpochBoundAuthorizer)(
        room,
        leaseRequestId,
        bootstrapChallenge,
        expectedRoomEpoch,
      )
      if (!authorization || typeof authorization !== 'object') {
        return undefined
      }
      const candidate = authorization as Record<string, unknown>
      if (
        typeof candidate.capability !== 'string' ||
        candidate.capability.length === 0 ||
        candidate.collaborationProtocolVersion !== COLLABORATION_PROTOCOL_VERSION ||
        candidate.roomEpoch !== expectedRoomEpoch
      ) {
        return undefined
      }
      return {
        capability: candidate.capability,
        roomEpoch: expectedRoomEpoch,
        collaborationProtocolVersion: COLLABORATION_PROTOCOL_VERSION,
      }
    },
  }
}
