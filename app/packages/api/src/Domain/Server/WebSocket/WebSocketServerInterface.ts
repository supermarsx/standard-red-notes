import { HttpResponse } from '@standardnotes/responses'
import { WebSocketConnectionTokenRequestParams } from '../../Request/WebSocket/WebSocketConnectionTokenRequestParams'
import { WebSocketConnectionTokenResponseBody } from '../../Response/WebSocket/WebSocketConnectionTokenResponseBody'
import { CollaborationAuthorizationResponseBody } from '../../Response/WebSocket/CollaborationAuthorizationResponseBody'

export interface WebSocketServerInterface {
  createConnectionToken(
    params: WebSocketConnectionTokenRequestParams,
  ): Promise<HttpResponse<WebSocketConnectionTokenResponseBody>>
  authorizeCollaboration(params: {
    noteUuid: string
  }): Promise<HttpResponse<CollaborationAuthorizationResponseBody>>
}
