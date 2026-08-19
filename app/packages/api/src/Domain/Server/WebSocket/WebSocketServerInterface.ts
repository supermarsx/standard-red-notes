import { HttpResponse } from '@standardnotes/responses'
import { WebSocketConnectionTokenRequestParams } from '../../Request/WebSocket/WebSocketConnectionTokenRequestParams'
import { WebSocketConnectionTokenResponseBody } from '../../Response/WebSocket/WebSocketConnectionTokenResponseBody'
import { CollaborationAuthorizationResponseBody } from '../../Response/WebSocket/CollaborationAuthorizationResponseBody'

export interface WebSocketServerInterface {
  createConnectionToken(
    params: WebSocketConnectionTokenRequestParams,
  ): Promise<HttpResponse<WebSocketConnectionTokenResponseBody>>
  authorizeCollaboration(
    params: CollaborationAuthorizationRequestParams,
  ): Promise<HttpResponse<CollaborationAuthorizationResponseBody>>
}

export type CollaborationAuthorizationRequestParams =
  | { noteUuid: string; collaborationProtocolVersion: 3; epochDiscovery: true }
  | {
      noteUuid: string
      collaborationProtocolVersion: 3
      epochDiscovery?: false
      expectedRoomEpoch: string
      leaseRequestId?: string
      bootstrapChallenge?: string
    }
